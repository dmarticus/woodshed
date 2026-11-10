import { approvalRequestState } from "../src/model";
import { localDay } from "../src/usage";

const now = Date.now();
const time = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const check = (name: string, conclusion = "SUCCESS") => ({ name, status: "COMPLETED", conclusion, url: "" });
const base = (number: number, title: string, kind: string, reason: string) => ({
  snapshot: { number, title, url: `https://github.com/example/project/pull/${number}`, head: `preview-head-${number}`, branch: `feature/report-${number}`, base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [check("Tests")], threads: [], reviews: [], labels: [] },
  decision: { kind, reason }, paused: false, watching: true, attempts: 0, fingerprint: "preview", stateSince: time(36000),
});
const prs: any[] = [
  base(104, "feat(reports): keep paused reports visible until archived", "review", "Waiting for PostHog Review on this commit"),
  base(105, "fix(reports): ask before restarting a delivery", "human", "Gave up after 3 attempts · typecheck"),
  base(106, "feat(reports): add owners to delivery reports", "waiting", "Agent is working"),
  base(107, "fix(mobile): preserve report links", "waiting", "Agent is working"),
  ...Array.from({ length: 5 }, (_, i) => base(108 + i, `chore(reports): improve report behavior ${i + 1}`, "waiting", "Waiting for checks to finish")),
];
prs[0].snapshot.stack = { position: 2, size: 4 };
prs[0].snapshot.checks = [...Array.from({ length: 62 }, (_, i) => check(`Check ${i + 1}`)), ...Array.from({ length: 14 }, (_, i) => check(`Optional check ${i + 1}`, "SKIPPED"))];
const run = (number: number, state: string, costUSD: number, turns: number, duration: number, ago = 0, summary = "Working through the current feedback") => ({
  id: `ws-${number}-preview`, number, startedAt: time(duration + ago), ...(ago ? { endedAt: time(ago) } : {}), state, model: "gpt-6.1-sol", turns, costUSD,
  costsByDay: { [localDay()]: costUSD }, summary,
});
const runs: any[] = [run(107, "running", 0.17, 6, 60), run(106, "running", 0.42, 12, 120), run(105, "failed", 1.98, 29, 540, 1800, "Gave up after 3 attempts to fix the typecheck failure. A decision is needed."), run(104, "succeeded", 0.61, 14, 220, 43200, "Fixed the typecheck failure and published a verified update.")];
for (const record of prs.filter(p => [106, 107].includes(p.snapshot.number))) record.job = { name: `ws-${record.snapshot.number}-preview`, head: record.snapshot.head, fingerprint: "preview", startedAt: time(120), model: "gpt-6.1-sol", adapter: "app-server" };
if (process.argv.includes("--question")) {
  prs[0].job = { name: "ws-104-question", head: prs[0].snapshot.head, fingerprint: "preview", startedAt: time(100), model: "gpt-6.1-sol", adapter: "app-server" };
  prs[0].decision = { kind: "human", reason: "Keep paused reports visible or hide them?" };
  runs.unshift({ ...run(104, "waiting", 0.08, 3, 100), id: "ws-104-question", prompt: { id: "preview-question", kind: "question", text: "Keep paused reports visible or hide them?" } });
}
if (process.argv.includes("--draft")) {
  prs[0].snapshot.draft = true; prs[0].canMarkReady = true; prs[0].snapshot.stack = undefined;
  prs[0].snapshot.title = "feat(signals): align report actions between web and desktop inbox";
  prs[0].snapshot.checks = Array.from({ length: 7 }, (_, i) => check(`Check ${i + 1}`, "FAILURE"));
  prs[0].decision = { kind: "paused", reason: "Draft PR" }; delete prs[0].job;
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].number === 104) runs.splice(i, 1);
}
if (process.argv.includes("--ui")) {
  const titles = ["Quill filters and tabs on the Home-style inbox list", "Quill evidence cards on the Home-style inbox report", "Quill details sections on the Home-style inbox report"];
  for (const [index, number] of [108, 109, 110].entries()) {
    const record = prs.find(p => p.snapshot.number === number)!;
    record.snapshot.draft = true; record.snapshot.title = `feat(signals): ${titles[index]}`;
    record.canMarkReady = true; record.snapshot.stack = { position: index + 1, size: 3 };
    record.decision = { kind: "paused", reason: "Draft PR" };
  }
  const ready = prs.find(p => p.snapshot.number === 111)!;
  ready.snapshot.title = "feat(mobile): open report links in the app with universal links";
  ready.decision = { kind: "ready", reason: "Checks and review verified on the current head" };
}
if (process.argv.includes("--waiting")) {
  const scenarios = [
    base(201, "fix(signals): align report actions between web and desktop inbox", "waiting", "Waiting for review from Team Surfaces, Team Agent Infrastructure, Team Self-Driving"),
    base(202, "fix(inbox): explain usage limits when starting report tasks", "waiting", "Waiting for checks to finish"),
    base(203, "feat(desktop): ask before replacing an existing claim", "review", "Waiting for PostHog Review on this commit"),
    base(204, "fix(signals): preserve user status changes during research", "waiting", "Checking the result against GitHub"),
    base(205, "feat(mobile): open report links in the app", "waiting", "GitHub is calculating mergeability"),
    { ...base(206, "feat(signals): ask before implementing a claimed report", "paused", "Paused by you"), paused: true },
    base(207, "fix(inbox): add team Slack notification priorities", "fix", "3 failing checks"),
  ];
  prs.splice(0, prs.length, ...scenarios); runs.splice(0, runs.length);
}
const approvalPreview = process.argv.some(arg => arg.startsWith("--approval"));
if (approvalPreview) {
  const record = prs[0];
  record.snapshot.draft = false; record.snapshot.reviewDecision = "REVIEW_REQUIRED";
  record.snapshot.reviewRequests = ["Team Surfaces"];
  record.snapshot.reviews = [{ author: "posthog[bot]", head: record.snapshot.head, state: "COMMENTED", body: "Reviewed", submittedAt: time(60) }];
  record.decision = { kind: "approval", reason: "Waiting for approval on the current changes" }; delete record.job;
  if (process.argv.includes("--approval-requested")) {
    record.requestedApproval = record.snapshot.head; record.approvalRequestedAt = time(20);
    record.decision.reason = "Stamphog requested; waiting for approval on this commit";
  }
  if (process.argv.includes("--approval-approved")) {
    record.snapshot.reviews.push({ author: "stamphog[bot]", head: record.snapshot.head, state: "APPROVED", body: "Approved", submittedAt: time(5) });
    record.snapshot.reviewDecision = "APPROVED"; record.decision = { kind: "ready", reason: "Ready for your merge decision" };
  }
}
if (process.argv.includes("--needs-access") || process.argv.includes("--repair-stopped")) {
  const record = prs[0]; record.snapshot.draft = false; delete record.job;
  record.snapshot.title = "feat(signals): ask before implementing a claimed report";
  record.snapshot.checks = [check("Backend tests on Depot", "FAILURE")];
  record.snapshot.threads = [];
  record.decision = process.argv.includes("--needs-access")
    ? { kind: "human", response: "recheck", title: "Connect Depot on the maintenance server", reason: "Woodshed can't retry the failed checks without Depot access.", question: "Sign in to Depot on the server, or retry the failed jobs in Depot. Then recheck this PR.", action: { label: "Open failed job", url: "https://depot.dev/job/example" } }
    : { kind: "human", response: "retry", title: "CI still needs a fix", reason: "Woodshed stopped after repeated attempts to finish this repair.", question: "Review what remains, then retry with instructions or finish the fix yourself.", action: { label: "Open failed check", url: "https://github.com/example/project/actions" } };
  record.assessment = { report: "The CI provider reported a missing API token on the maintenance server. No retry was submitted.", result: { route: "ask", title: record.decision.title!, evidence: [{ url: "https://depot.dev/job/example", detail: "The CI job failed before the test runner started." }] } } as any;
}
const mode = approvalPreview ? "watch" : "auto";
for (const record of prs) record.approval = approvalRequestState(record, true, mode);
const quiet = process.argv.includes("--quiet");
console.log(JSON.stringify({ repository: "example/project", demo: true, automation: mode === "auto", mode, syncing: false,
  settings: { repository: "example/project", author: "@me", automation: mode === "auto", paused: false, mode, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 1, runCapUSD: 5, dailyCapUSD: 20, defaultModel: "gpt-6.1-sol", retryModel: "gpt-6-astra", escalateOnRetry: false, watchFilter: "mine", watchQuery: "", modelPrices: {} },
  prs: quiet ? prs.filter(p => ![105, 106, 107].includes(p.snapshot.number)) : prs, runs: quiet ? runs.filter(r => r.endedAt) : runs,
  events: [], spend: { day: localDay(), spentUSD: 3.18, capUSD: 20, runs: 4, unknownRuns: 0, prTotals: { "104": 0.61, "105": 1.98, "106": 0.42, "107": 0.17 } },
  models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", isDefault: true, price: { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10 } }, { id: "gpt-6-luna", name: "GPT-6 Luna", isDefault: false, price: { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 } }, { id: "gpt-6-astra", name: "GPT-6 Astra", isDefault: false, price: { input: 10, cached: 1, cacheWrite: 12.5, output: 50 } }],
}));
