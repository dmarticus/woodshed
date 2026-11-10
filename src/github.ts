import { QueueSubmissionRejected, parseTrunkComments, parseTrunkCheck, type QueueObservation } from "./merge-queue";
import { command } from "./command";
import type { Config, Snapshot, ReviewThreadAssessment } from "./model";
import { diagnosticText, namedTestFailures, type CIEvidence, type CheckFailureReport } from "./check-evidence";
import { failed, currentChecks } from "./model";
import { infrastructureKind, type InfrastructureSignal } from "./ci-incidents";

export class GitHub {
  constructor(readonly config: Config, readonly exec: typeof command = command) {}
  viewerName?: string;
  resumeAt = 0;
  authenticationError?: string;
  private primed = new Map<number, any>();
  private conditional = new Map<string, { etag: string; data: any }>();
  private signalCache = new Map<string, { time: number; signal?: InfrastructureSignal }>();
  private async queueComments(number: number): Promise<any[]> {
    const comments: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await this.conditionalJSON(`repos/${this.config.repository}/issues/${number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw Error("Invalid merge queue comment response");
      comments.push(...rows);
      if (rows.length < 100) return comments;
    }
    throw Error("Queue comment history exceeds the supported page limit");
  }
  async mergeQueue(pr: Snapshot): Promise<QueueObservation | undefined> {
    if (pr.state !== "OPEN") return undefined;
    try {
      const bot = parseTrunkComments(await this.queueComments(pr.number), pr);
      const check = parseTrunkCheck(pr);
      return bot && bot.state !== "available" ? bot : check ?? bot;
    } catch {
      // Preserve prior queue membership on an outage. Never infer an eviction
      // from missing/partial data or an authentication/rate-limit failure.
      return { provider: "trunk", state: "unknown", revision: "unavailable", url: pr.url, error: "Could not refresh Trunk queue status. Woodshed will check again." };
    }
  }
  async submitMergeQueue(pr: Snapshot, requestId: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw Error("Invalid queue submission identifier");
    let posting = false;
    try {
    const marker = `<!-- woodshed-merge-queue:${requestId} head:${pr.head} -->`;
    const existing = (await this.queueComments(pr.number)).find(c => c.user?.login === this.viewerName && c.body?.includes(marker));
    if (existing) return existing.html_url;
    const fresh = JSON.parse(await this.request(["gh", "pr", "view", String(pr.number), "--repo", this.config.repository, "--json", "headRefOid,baseRefName,state,isDraft"]));
    if (fresh.headRefOid !== pr.head || fresh.baseRefName !== pr.base || fresh.state !== "OPEN" || fresh.isDraft) throw Error("The PR changed before queue submission. Refresh and review the current version.");
    posting = true;
    const comment = JSON.parse(await this.request(["gh", "api", `repos/${this.config.repository}/issues/${pr.number}/comments`, "--method", "POST", "-f", `body=/trunk merge\n\n${marker}`]));
    if (typeof comment.html_url !== "string") throw Error("Queue submission could not be confirmed");
    return comment.html_url;
    } catch (error) {
      if (!posting || /HTTP\s+(?:400|401|403|404|422)\b/.test(String(error))) throw new QueueSubmissionRejected(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  async failureEvidence(pr: Snapshot): Promise<CIEvidence> {
    const failures = pr.checks.filter(failed);
    const evidence: CIEvidence = { head: pr.head, reports: [], unavailable: [] };
    if (!failures.length) return evidence;
    const found = new Set<string>();
    try {
      for (let page = 1; page <= 10; page++) {
        const data = JSON.parse(await this.request(["gh", "api", `repos/${this.config.repository}/commits/${encodeURIComponent(pr.head)}/check-runs?filter=latest&per_page=100&page=${page}`]));
        if (!Array.isArray(data.check_runs)) throw Error("Invalid GitHub check response");
        for (const run of data.check_runs) {
          const check = failures.find(c => c.name === run.name && (!c.url || c.url === run.details_url) && (!c.startedAt || Date.parse(c.startedAt) === Date.parse(run.started_at)));
          if (!check || found.has(check.name) || run.head_sha !== pr.head || !Number.isSafeInteger(run.id) || run.id <= 0 || run.status !== "completed" || String(run.conclusion).toUpperCase() !== check.conclusion) continue;
          const report: CheckFailureReport = {
            name: check.name, github_url: `https://github.com/${this.config.repository}/runs/${run.id}`,
            provider_url: check.url, title: diagnosticText(run.output?.title, 300),
            summary: diagnosticText(run.output?.summary, 12000), text: diagnosticText(run.output?.text, 12000), annotations: [], test_failures: [],
          };
          if (run.output?.annotations_count > 0) {
            try {
              for (let annotationPage = 1; annotationPage <= 2; annotationPage++) {
                const rows = JSON.parse(await this.request(["gh", "api", `repos/${this.config.repository}/check-runs/${run.id}/annotations?per_page=100&page=${annotationPage}`]));
                if (!Array.isArray(rows)) throw Error("Invalid GitHub annotations");
                report.annotations.push(...rows.map(a => ({ path: diagnosticText(a.path, 500), line: a.start_line, message: diagnosticText([a.title, a.message, a.raw_details].filter(Boolean).join("\n"), 2000) })));
                if (rows.length < 100) break;
              }
            } catch { evidence.unavailable.push({ name: check.name, reason: "Some GitHub annotations could not be read; the check summary is still available." }); }
          }
          report.annotations = report.annotations.slice(0, 30);
          report.test_failures = namedTestFailures(report);
          evidence.reports.push(report); found.add(check.name);
          if (evidence.reports.length >= 6) break;
        }
        if (data.check_runs.length < 100 || found.size === failures.length || evidence.reports.length >= 6) break;
      }
    } catch { /* Preserve summaries already collected if a later page is unavailable. */ }
    for (const check of failures) if (!found.has(check.name)) evidence.unavailable.push({ name: check.name, reason: "A matching current-head GitHub check report could not be read." });
    return evidence;
  }
  async failureSignal(pr: Snapshot, check: Snapshot["checks"][number]): Promise<InfrastructureSignal | undefined> {
    let url: URL;
    try { url = new URL(check.url); } catch { return undefined; }
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)$/);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || match?.[1].toLowerCase() !== this.config.repository.toLowerCase()) return undefined;
    const key = `${pr.head}:${check.url}`;
    const cached = this.signalCache.get(key);
    if (cached && Date.now() - cached.time < 120000) return cached.signal;
    const job = JSON.parse(await this.request(["gh", "api", `repos/${this.config.repository}/actions/jobs/${match[2]}`]));
    if (job.head_sha !== pr.head || job.status !== "completed" || !Number.isSafeInteger(job.run_id)) return undefined;
    const log = await this.request(["gh", "api", `repos/${this.config.repository}/actions/jobs/${match[2]}/logs`]);
    const kind = infrastructureKind(log);
    const signal = kind ? { signature: `${kind.kind}:${check.source?.workflow ?? check.name}`, label: kind.label, head: pr.head, job: match[2], run: String(job.run_id), url: check.url } : undefined;
    if (this.signalCache.size >= 100) this.signalCache.delete(this.signalCache.keys().next().value!);
    this.signalCache.set(key, { time: Date.now(), signal });
    return signal;
  }
  async rerunFailed(signal: InfrastructureSignal): Promise<void> {
    if (!/^\d+$/.test(signal.run)) throw new Error("Invalid CI run identifier");
    const run = JSON.parse(await this.request(["gh", "api", `repos/${this.config.repository}/actions/runs/${signal.run}`]));
    if (run.head_sha !== signal.head || run.status !== "completed") throw new Error("The CI run changed or is still running; observe it before rerunning");
    await this.request(["gh", "run", "rerun", signal.run, "--repo", this.config.repository, "--failed"]);
  }
  async conditionalJSON(endpoint: string): Promise<any> {
    const cached = this.conditional.get(endpoint);
    const args = ["gh", "api", "--include", endpoint, "-H", "X-GitHub-Api-Version: 2026-03-10"];
    if (cached) args.push("-H", `If-None-Match: ${cached.etag}`);
    let response: string;
    try { response = await this.request(args); }
    catch (error) {
      if (cached && /\bHTTP\s+304\b/.test(String(error))) { this.authenticationError = undefined; return cached.data; }
      throw error;
    }
    if (!/^HTTP\//.test(response)) return JSON.parse(response);
    const split = response.search(/\r?\n\r?\n/);
    const headers = split < 0 ? response : response.slice(0, split);
    if (/^HTTP\/[^ ]+ 304/m.test(headers)) {
      if (!cached) throw new Error("GitHub returned 304 without a cached response");
      return cached.data;
    }
    const body = response.slice(split).trim();
    const data = JSON.parse(body);
    const etag = headers.match(/^etag:\s*(.+)$/im)?.[1].trim();
    if (etag) this.conditional.set(endpoint, { etag, data });
    return data;
  }
  async prepareBatch(numbers: number[]): Promise<void> {
    const [owner, name] = this.config.repository.split("/");
    for (let offset = 0; offset < numbers.length; offset += 25) {
      const batch = numbers.slice(offset, offset + 25);
      if (batch.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error("Invalid PR number");
      const selections = batch.map(n => `p${n}:pullRequest(number:${n}){number title url headRefOid headRefName baseRefName baseRefOid state isDraft mergeable mergeStateStatus reviewDecision body updatedAt author{login} labels(first:100){nodes{name} pageInfo{hasNextPage}} reviewRequests(first:100){nodes{requestedReviewer{...on User{login} ...on Team{name slug}}} pageInfo{hasNextPage}} reviewThreads(first:20){nodes{id isResolved comments(first:10){nodes{author{login __typename} body url} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}} reviews(first:30){nodes{author{login} state body commit{oid} submittedAt} pageInfo{hasNextPage endCursor}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{...on CheckRun{isRequired(pullRequestNumber:${n}) name status conclusion detailsUrl startedAt checkSuite{app{slug} workflowRun{id createdAt workflow{id}}}} ...on StatusContext{isRequired(pullRequestNumber:${n}) context state description targetUrl}} pageInfo{hasNextPage endCursor}}}}}}}`).join(" ");
      const result = JSON.parse(await this.request(["gh", "api", "graphql", "-f", `query=query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${selections}}}`]));
      if (result.errors) throw new Error("GitHub batch query failed: " + JSON.stringify(result.errors));
      for (const n of batch) {
        const p = result.data?.repository?.[`p${n}`];
        if (!p) continue;
        if (p.labels.pageInfo.hasNextPage || p.reviewRequests.pageInfo.hasNextPage) throw new Error("PR metadata exceeds the supported page size");
        const commit = p.commits.nodes[0]?.commit;
        if (commit?.oid !== p.headRefOid) throw new Error("GitHub returned inconsistent PR and check heads");
        if (p.reviewThreads.nodes.some((t: any) => !t.isResolved && t.comments.pageInfo.hasNextPage)) delete p.reviewThreads;
        this.primed.set(n, { ...p, labels: p.labels.nodes, reviewRequests: p.reviewRequests.nodes.map((r: any) => r.requestedReviewer), _checks: commit.statusCheckRollup?.contexts });
      }
    }
  }
  private async request(argv: string[]): Promise<string> {
    if (Date.now() < this.resumeAt) throw new Error(`GitHub rate limit; automatically retrying after ${new Date(this.resumeAt).toLocaleTimeString()}`);
    try { const result = await this.exec(argv); this.authenticationError = undefined; return result; }
    catch (error) {
      if (/bad credentials|requires authentication|not logged|HTTP 401|authentication failed/i.test(String(error))) this.authenticationError = "Reconnect GitHub to continue monitoring and repairs.";
      if (!/rate limit|secondary rate|abuse detection/i.test(String(error))) throw error;
      this.resumeAt = Date.now() + 60_000;
      try {
        const rates = JSON.parse(await this.exec(["gh", "api", "rate_limit"]));
        const rate = rates.resources?.[argv.includes("graphql") ? "graphql" : "core"];
        if (rate?.remaining === 0 && Number.isFinite(rate.reset)) this.resumeAt = Math.max(this.resumeAt, rate.reset * 1000 + 2000);
      } catch { }
      throw new Error(`GitHub rate limit; automatically retrying after ${new Date(this.resumeAt).toLocaleTimeString()}`);
    }
  }
  async list(): Promise<number[]> {
    this.viewerName ??= (await this.conditionalJSON("user")).login;
    const author = this.config.author === "@me" ? this.viewerName : this.config.author;
    const queries = this.config.watchFilter === "query" ? [this.config.watchQuery!.replaceAll("@me", this.viewerName!)] : [`author:${author}`];
    if (this.config.watchFilter === "mine-and-reviews") queries.push(`review-requested:${this.viewerName}`);
    const numbers = new Set<number>();
    for (const filter of queries) {
      let page = 1;
      while (true) {
        const query = `repo:${this.config.repository} is:pr is:open ${filter}`;
        const data = await this.conditionalJSON(`search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`);
        if (data.total_count >= 1000 || data.incomplete_results) throw new Error("PR listing reached its limit; narrow the watch filter before continuing.");
        for (const item of data.items) numbers.add(item.number);
        if (data.items.length < 100 || numbers.size >= data.total_count && queries.length === 1) break;
        page++;
      }
    }
    return [...numbers].sort((a, b) => b - a);
  }
  async canMaintain(pr: Snapshot): Promise<boolean> {
    if (!pr.author) return !this.config.watchFilter || this.config.watchFilter === "mine";
    this.viewerName ??= (await this.request(["gh", "api", "user", "--jq", ".login"])).trim();
    return pr.author.toLowerCase() === this.viewerName.toLowerCase();
  }
  canMaintainKnown(pr: Snapshot): boolean {
    return !!pr.author && !!this.viewerName && pr.author.toLowerCase() === this.viewerName.toLowerCase();
  }
  async freshSnapshot(number: number): Promise<Snapshot> { this.primed.delete(number); return this.snapshot(number); }
  async snapshot(number: number): Promise<Snapshot> {
    const pr = this.primed.get(number) ?? JSON.parse(await this.request(["gh", "pr", "view", String(number), "--repo", this.config.repository, "--json", "number,title,url,headRefOid,headRefName,baseRefName,baseRefOid,state,isDraft,mergeable,mergeStateStatus,reviewDecision,labels,author,body,updatedAt,reviewRequests"]));
    this.primed.delete(number);
    const [owner, name] = this.config.repository.split("/");
    const pages = async (field: string, selection: string, path: string[], variables = ""): Promise<any[]> => {
      let cursor: string | null = null;
      const rows: any[] = [];
      do {
        if (!cursor && pr[field]) {
          const initial = pr[field]; rows.push(...initial.nodes);
          if (!initial.pageInfo.hasNextPage) break;
          cursor = initial.pageInfo.endCursor;
        }
        const args = ["gh", "api", "graphql", "-f", `query=query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${field}(first:100,after:$cursor${variables}){nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
        if (cursor) args.push("-f", `cursor=${cursor}`);
        const result = JSON.parse(await this.request(args));
        if (result.errors) throw new Error(JSON.stringify(result.errors));
        let connection = result.data.repository.pullRequest;
        for (const key of path) connection = connection[key];
        if (!connection) return [];
        rows.push(...connection.nodes);
        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      } while (cursor);
      return rows;
    };
    const threads = await pages("reviewThreads", "id isResolved comments(first:100){nodes{author{login __typename} body url} pageInfo{hasNextPage}}", ["reviewThreads"]);
    if (threads.some(t => !t.isResolved && t.comments.pageInfo.hasNextPage)) throw new Error("A review thread exceeds 100 comments; open it manually before automation continues.");
    const reviews = await pages("reviews", "author{login} state body commit{oid} submittedAt", ["reviews"]);
    let cursor: string | null = null;
    const checks: Snapshot["checks"] = [];
    do {
      const args = ["gh", "api", "graphql", "-f", "query=query($owner:String!,$name:String!,$head:GitObjectID!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){object(oid:$head){... on Commit{statusCheckRollup{contexts(first:100,after:$cursor){nodes{... on CheckRun{isRequired(pullRequestNumber:$number) name status conclusion detailsUrl startedAt checkSuite{app{slug} workflowRun{id createdAt workflow{id}}}} ... on StatusContext{isRequired(pullRequestNumber:$number) context state description targetUrl}} pageInfo{hasNextPage endCursor}}}}}}}", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `head=${pr.headRefOid}`, "-F", `number=${number}`];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const result = !cursor && pr._checks ? { data: { repository: { object: { statusCheckRollup: { contexts: pr._checks } } } } } : JSON.parse(await this.request(args));
      if (result.errors) throw new Error(JSON.stringify(result.errors));
      const connection = result.data.repository.object?.statusCheckRollup?.contexts;
      if (!connection) break;
      for (const c of connection.nodes) checks.push(c.context ? {
        name: c.context, status: ["PENDING", "EXPECTED"].includes(c.state) ? "IN_PROGRESS" : "COMPLETED",
        conclusion: c.state === "SUCCESS" ? "SUCCESS" : c.state === "FAILURE" || c.state === "ERROR" ? "FAILURE" : null,
        required: c.isRequired, url: c.targetUrl ?? "", description: c.description ?? undefined,
      } : { app: c.checkSuite?.app?.slug, required: c.isRequired, name: c.name, status: c.status, conclusion: c.conclusion, url: c.detailsUrl ?? "", startedAt: c.startedAt ?? undefined,
        ...(c.checkSuite?.workflowRun?.workflow ? { source: { workflow: c.checkSuite.workflowRun.workflow.id, run: c.checkSuite.workflowRun.id, createdAt: c.checkSuite.workflowRun.createdAt } } : {}) });
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    let stack: Snapshot["stack"];
    if (pr.baseRefName) {
      try {
        const stacks = await this.conditionalJSON(`repos/${this.config.repository}/stacks?pull_request=${number}`);
        const members = stacks.find((s: any) => s.open && s.pull_requests.some((p: any) => p.number === number))?.pull_requests.filter((p: any) => p.state === "open");
        const position = members?.findIndex((p: any) => p.number === number);
        if (members?.length > 1 && position >= 0) stack = { position: position + 1, size: members.length };
      } catch { stack = undefined; }
    }
    return {
      number, title: pr.title, url: pr.url, head: pr.headRefOid, branch: pr.headRefName, base: pr.baseRefName, baseHead: pr.baseRefOid,
      state: pr.state, draft: pr.isDraft, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus,
      reviewDecision: pr.reviewDecision, labels: pr.labels.map((l: any) => l.name), checks: currentChecks(checks),
      threads: threads.filter(t => !t.isResolved).map(t => ({ id: t.id, comments: t.comments.nodes.map((c: any) => ({ author: c.author?.login ?? "deleted", authorType: c.author?.__typename, body: c.body, url: c.url })) })),
      reviews: reviews.map(r => ({ author: r.author?.login ?? "deleted", state: r.state, body: r.body, head: r.commit?.oid ?? "", submittedAt: r.submittedAt })),
      author: pr.author?.login,
      body: pr.body, updatedAt: pr.updatedAt, reviewRequests: (pr.reviewRequests ?? []).map((r: any) => r.login ?? r.name ?? r.slug).filter(Boolean),
      stack,
    };
  }
  async resolveAddressedThreads(pr: Snapshot, findings: ReviewThreadAssessment[]): Promise<{ snapshot: Snapshot; resolved: string[] }> {
    this.primed.delete(pr.number);
    const fresh = await this.snapshot(pr.number);
    const resolved: string[] = [];
    if (fresh.head !== pr.head || fresh.state !== "OPEN" || fresh.draft || !await this.canMaintain(fresh)) return { snapshot: fresh, resolved };
    for (const finding of findings) {
      if (finding.status !== "addressed" || !finding.code_url || resolved.includes(finding.id)) continue;
      const evidence = new URL(finding.code_url);
      if (evidence.origin !== "https://github.com" || !evidence.pathname.startsWith(`/${this.config.repository}/blob/${pr.head}/`)) continue;
      const original = pr.threads.find(t => t.id === finding.id);
      const thread = fresh.threads.find(t => t.id === finding.id);
      if (!original || !thread || JSON.stringify(original.comments) !== JSON.stringify(thread.comments)) continue;
      if (!thread.comments.length || thread.comments.some(c => c.authorType !== "Bot") || !thread.comments.some(c => /^posthog(?:\[bot\])?$/i.test(c.author) && c.body.includes("<!-- reviewhog:finding -->"))) continue;
      const current = JSON.parse(await this.request(["gh", "pr", "view", String(pr.number), "--repo", this.config.repository, "--json", "headRefOid,state,isDraft"]));
      if (current.headRefOid !== pr.head || current.state !== "OPEN" || current.isDraft) break;
      const result = JSON.parse(await this.request(["gh", "api", "graphql", "-f", "query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}", "-f", `thread=${thread.id}`]));
      if (result.errors || result.data?.resolveReviewThread?.thread?.isResolved !== true) throw new Error("GitHub did not confirm review thread resolution");
      resolved.push(thread.id);
    }
    return { snapshot: resolved.length ? await this.snapshot(pr.number) : fresh, resolved };
  }
  async label(number: number, label: string): Promise<void> {
    await this.request(["gh", "pr", "edit", String(number), "--repo", this.config.repository, "--add-label", label]);
  }
  async requestApproval(number: number, expectedHead: string): Promise<void> {
    const label = this.config.approvalLabel;
    if (!label?.trim()) throw new Error("Configure a Stamphog approval label first");
    const inspect = async () => {
      const pr = JSON.parse(await this.request(["gh", "pr", "view", String(number), "--repo", this.config.repository, "--json", "headRefOid,state,isDraft,labels"]));
      if (pr.headRefOid !== expectedHead || pr.state !== "OPEN" || pr.isDraft) throw new Error("The PR changed. Refresh before requesting Stamphog approval.");
      return pr;
    };
    const pr = await inspect();
    // Reapplying an existing label requires a distinct labeled event for the new head.
    if (pr.labels.some((entry: { name: string }) => entry.name === label)) {
      await this.request(["gh", "api", "--method", "DELETE", `repos/${this.config.repository}/issues/${number}/labels/${encodeURIComponent(label)}`]);
      await inspect();
    }
    await this.label(number, label);
  }
  async requestReviewer(number: number, reviewer: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9-]{0,99})?$/.test(reviewer)) throw new Error("Enter a GitHub username or organization/team");
    await this.request(["gh", "pr", "edit", String(number), "--repo", this.config.repository, "--add-reviewer", reviewer]);
  }
  async markReady(number: number, expectedHead: string): Promise<void> {
    const current = await this.snapshot(number);
    if (current.state !== "OPEN" || !current.draft) throw new Error("This pull request is no longer a draft. Refresh its current state.");
    if (current.head !== expectedHead) throw new Error("The draft changed. Refresh before marking it ready.");
    await this.request(["gh", "pr", "ready", String(number), "--repo", this.config.repository]);
  }
  async markDraft(number: number, expectedHead: string): Promise<void> {
    const current = await this.snapshot(number);
    if (current.state !== "OPEN" || current.draft) throw new Error("This pull request is no longer ready for review. Refresh its state.");
    if (current.head !== expectedHead) throw new Error("The pull request changed. Refresh before converting it to a draft.");
    await this.request(["gh", "pr", "ready", String(number), "--undo", "--repo", this.config.repository]);
  }
}
