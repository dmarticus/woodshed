import { expect, test } from "bun:test";
import { GitHub } from "../src/github";
import type { Config, Snapshot } from "../src/model";

test("reads all check pages including a failure beyond the first 200", async () => {
  const seen: string[] = [];
  const exec = async (argv: string[]): Promise<string> => {
    if (argv[1] === "pr") return JSON.stringify({ headRefOid: "head", baseRefName: "parent", labels: [] });
    if (argv.some(a => a.includes("/stacks?"))) return JSON.stringify([{ open: true, pull_requests: [{ number: 9, state: "closed" }, { number: 1, state: "open" }, { number: 2, state: "open" }] }]);
    const query = argv.find(a => a.startsWith("query=")) ?? "";
    if (query.includes("reviewThreads")) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
    if (query.includes("reviews(")) return JSON.stringify({ data: { repository: { pullRequest: { reviews: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
    const cursor = argv.find(a => a.startsWith("cursor="))?.slice(7) ?? "0";
    seen.push(cursor);
    const page = Number(cursor);
    const nodes = page === 2 ? [{ context: "PostHog Visual Review / storybook", state: "FAILURE", description: "Visual changes detected: 1 changed", targetUrl: "https://example.com/visual-diff" }] : Array.from({ length: 100 }, (_, i) => ({ name: `Check ${page * 100 + i}`, status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "" }));
    return JSON.stringify({ data: { repository: { object: { statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: page < 2, endCursor: String(page + 1) } } } } } } });
  };
  const pr = await new GitHub({ repository: "example/project" } as Config, exec).snapshot(1);
  expect(seen).toEqual(["0", "1", "2"]);
  expect(pr.checks.length).toBe(201);
  expect(pr.checks[200].conclusion).toBe("FAILURE");
  expect(pr.checks[200].description).toBe("Visual changes detected: 1 changed");
  expect(pr.stack).toEqual({ position: 1, size: 2 });
});

test("rate limits back off across PRs rather than repeatedly calling GitHub", async () => {
  let calls = 0;
  const github = new GitHub({ repository: "example/project" } as Config, async argv => {
    calls++;
    if (argv[2] === "rate_limit") return JSON.stringify({ resources: { core: { remaining: 0, reset: Math.ceil(Date.now() / 1000) + 600 } } });
    throw new Error("API rate limit already exceeded");
  });
  await expect(github.snapshot(1)).rejects.toThrow("automatically retrying");
  await expect(github.snapshot(2)).rejects.toThrow("automatically retrying");
  expect(calls).toBe(2);
});

test.each(["verified", "human", "human reply", "other bot", "missing marker", "changed comment", "stale head", "changed before mutation", "other repository", "other owner", "resolved", "unknown thread"])("bot-thread cleanup guards %s", async scenario => {
  const pr = { number: 42, head: "abc", state: "OPEN", draft: false, author: "owner", threads: [{ id: "thread", comments: [{ author: "posthog", authorType: "Bot", body: "Handle a missing value <!-- reviewhog:finding -->", url: "https://github.com/example/project/pull/42#discussion_r1" }] }] } as Snapshot;
  const fresh = structuredClone(pr);
  if (scenario === "human") pr.threads[0].comments[0].authorType = fresh.threads[0].comments[0].authorType = "User";
  if (scenario === "human reply") {
    const reply = { author: "reviewer", authorType: "User", body: "Please keep this open", url: pr.threads[0].comments[0].url };
    fresh.threads[0].comments.push(reply); pr.threads[0].comments.push(reply);
  }
  if (scenario === "other bot") pr.threads[0].comments[0].author = fresh.threads[0].comments[0].author = "another-bot";
  if (scenario === "missing marker") pr.threads[0].comments[0].body = fresh.threads[0].comments[0].body = "A discussion with no recognized finding marker";
  if (scenario === "changed comment") fresh.threads[0].comments[0].body += " Also verify the empty string.";
  if (scenario === "stale head") fresh.head = "new";
  if (scenario === "other owner") fresh.author = "another-owner";
  if (scenario === "resolved") fresh.threads = [];
  let mutations = 0;
  const github = new GitHub({ repository: "example/project" } as Config, async argv => {
    if (argv[1] === "pr") return JSON.stringify({ headRefOid: scenario === "changed before mutation" ? "new" : "abc", state: "OPEN", isDraft: false });
    mutations++;
    return JSON.stringify({ data: { resolveReviewThread: { thread: { id: "thread", isResolved: true } } } });
  });
  github.viewerName = "owner";
  github.snapshot = async () => mutations ? { ...fresh, threads: [] } : fresh;
  const result = await github.resolveAddressedThreads(pr, [{ id: scenario === "unknown thread" ? "unrelated" : "thread", status: "addressed", reason: "The current code handles missing values", code_url: `https://github.com/${scenario === "other repository" ? "other/project" : "example/project"}/blob/abc/file.ts` }]);
  expect(mutations).toBe(scenario === "verified" ? 1 : 0);
  expect(result.resolved).toEqual(scenario === "verified" ? ["thread"] : []);
});
