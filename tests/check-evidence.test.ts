import { expect, test } from "bun:test";
import { GitHub } from "../src/github";
import { actionableTests, diagnosticText, namedTestFailures, routeWithCIEvidence, type CIEvidence } from "../src/check-evidence";
import { parseAssessment } from "../src/triage";
import type { AssessmentResult, Config, Snapshot } from "../src/model";

const head = "a".repeat(40);
const testID = "posthog/hogql/transforms/test/test_flag_calls_union.py::test_serialized_property_keeps_its_json_type_on_the_native_events_table_8_restricted_temporary_key";
const check = { name: "Backend CI / Test results", status: "COMPLETED", conclusion: "FAILURE", url: "https://depot.dev/job/123" };
const pr = () => ({ number: 42, head, checks: [{ ...check }] } as Snapshot);
const run = () => ({ id: 123, head_sha: head, name: check.name, status: "completed", conclusion: "failure", details_url: check.url, output: { title: "1 failing test", summary: `| ${testID} | AssertionError: assert equals failed |`, text: null, annotations_count: 1 } });
const question = (): AssessmentResult => ({ head, route: "ask", category: "checks", response: "recheck", title: "Sign in to Depot", reason: "Cannot read full provider logs.", question: "Sign in on the server and recheck.", evidence: [{ url: check.url, detail: "The provider redirects to sign-in." }] });

async function fixture(options: { oldHead?: boolean; unavailableAnnotations?: boolean; annotationOnly?: boolean; timeoutOnly?: boolean } = {}) {
  const calls: string[][] = [];
  const github = new GitHub({ repository: "example/project" } as Config, async args => {
    calls.push(args);
    if (args[2].includes("/annotations")) {
      if (options.unavailableAnnotations) throw Error("HTTP 403");
      return JSON.stringify([{ path: "posthog/hogql/test_example.py", start_line: 12, message: options.timeoutOnly ? "Dependency install timed out with code 124" : `FAILED ${testID}: AssertionError: expected 0, got False` }]);
    }
    const report = run(); if (options.oldHead) report.head_sha = "b".repeat(40);
    if (options.annotationOnly || options.timeoutOnly) report.output = { ...report.output, title: "Failed", summary: "", text: null };
    return JSON.stringify({ check_runs: [report] });
  });
  return { evidence: await github.failureEvidence(pr()), calls };
}

test("reads GitHub summaries and annotations even when the details link belongs to Depot", async () => {
  const { evidence, calls } = await fixture();
  expect(evidence.head).toBe(head); expect(evidence.reports[0].test_failures).toEqual([testID]);
  expect(evidence.reports[0].github_url).toBe("https://github.com/example/project/runs/123");
  expect(evidence.reports[0].annotations[0].message).toContain("expected 0, got False");
  expect(calls.every(args => args[0] === "gh" && args[1] === "api" && args[2].startsWith("repos/example/project/"))).toBe(true);
});

test("finds a named assertion in annotations when the summary is empty", async () => {
  const { evidence } = await fixture({ annotationOnly: true });
  expect(actionableTests(evidence, head)[0].test_failures).toEqual([testID]);
});

test("an unavailable annotation endpoint does not discard an available failure summary", async () => {
  const { evidence } = await fixture({ unavailableAnnotations: true });
  expect(actionableTests(evidence, head)).toHaveLength(1);
  expect(evidence.unavailable[0].reason).toContain("summary is still available");
});

test("old-head reports cannot authorize a current-head repair", async () => {
  const { evidence } = await fixture({ oldHead: true });
  expect(evidence.reports).toEqual([]); expect(evidence.unavailable).toHaveLength(1);
  expect(actionableTests({ ...evidence, reports: [(await fixture()).evidence.reports[0]] }, "different")).toEqual([]);
});

test("paginates beyond unrelated green checks and matches the current attempt", async () => {
  let pages = 0;
  const snapshot = pr(); snapshot.checks[0].startedAt = "2026-01-01T00:00:00Z";
  const github = new GitHub({ repository: "example/project" } as Config, async args => {
    if (args[2].includes("annotations")) return "[]";
    pages++;
    if (pages === 1) return JSON.stringify({ check_runs: Array.from({ length: 100 }, () => ({ ...run(), name: "Unrelated green check", conclusion: "success" })) });
    return JSON.stringify({ check_runs: [{ ...run(), started_at: "2025-01-01T00:00:00Z" }, { ...run(), id: 124, started_at: snapshot.checks[0].startedAt }] });
  });
  const evidence = await github.failureEvidence(snapshot);
  expect(pages).toBe(2); expect(evidence.reports[0].github_url).toEndWith("/124");
});

test("a named test in GitHub turns an unnecessary provider-login ask into investigation and repair", async () => {
  const { evidence } = await fixture(); const result = routeWithCIEvidence(question(), evidence);
  expect(result.route).toBe("repair"); expect(result.question).toBeUndefined();
  expect(result.instructions).toContain(testID);
  expect(result.instructions).toContain("PR-caused defect");
  expect(result.instructions).toContain("do not weaken tests");
  expect(result.evidence[0].url).toContain("github.com");
});

test("code assertion and install timeout remain separate diagnostic signals", async () => {
  const { evidence } = await fixture(); const timeout = (await fixture({ timeoutOnly: true })).evidence.reports[0];
  evidence.reports.unshift(timeout);
  expect(timeout.test_failures).toEqual([]);
  expect(routeWithCIEvidence(question(), evidence).route).toBe("repair");
});

test("a real CI access blocker requires specific missing evidence and prior local diagnosis", async () => {
  const { evidence } = await fixture({ timeoutOnly: true });
  expect(() => routeWithCIEvidence(question(), evidence)).toThrow("local diagnosis");
  const result = { ...question(), ci_access: { service: "Depot", missing_evidence: "The dependency resolver output needed to distinguish a private package denial from a network timeout.", local_attempt: { status: "blocked" as const, detail: "The lockfile installs locally, but the failure does not reproduce. GitHub summaries and annotations contain only code 124; the private resolver failure needs its omitted error output." } } };
  expect(routeWithCIEvidence(parseAssessment(result, head), evidence).route).toBe("ask");
  expect(() => parseAssessment({ ...result, ci_access: { ...result.ci_access, missing_evidence: "" } }, head)).toThrow("specific missing evidence");
  expect(() => routeWithCIEvidence(result, { ...evidence, head: "other" })).toThrow("current-head");
});

test("real product and operations decisions remain human-owned even with a failing test", async () => {
  const { evidence } = await fixture();
  for (const category of ["product", "operations", "visual"] as const) expect(routeWithCIEvidence({ ...question(), category }, evidence).route).toBe("ask");
});

test("sanitizes diagnostic control codes and bounds payloads without inventing test failures", () => {
  expect(diagnosticText("\u001b[31mred\u001b[0m\u0000\nline", 100)).toBe("red\nline");
  expect(diagnosticText("x".repeat(100), 10)).toHaveLength(10);
  expect(namedTestFailures({ title: "Install timed out", summary: "Exit code 124", text: "", annotations: [] })).toEqual([]);
});


test("a genuinely blocked local investigation may require access even when GitHub names a test", async () => {
  const { evidence } = await fixture();
  const result = { ...question(), ci_access: { service: "Private package registry", missing_evidence: "The test's required private package cannot be installed without registry access.", local_attempt: { status: "blocked" as const, detail: "Worktree environment preparation returned HTTP 403 for the required private dependency; the test cannot import its module." } } };
  expect(routeWithCIEvidence(parseAssessment(result, head), evidence).route).toBe("ask");
  expect(routeWithCIEvidence({ ...result, ci_access: { ...result.ci_access, local_attempt: { status: "not_attempted", detail: "Only tried opening the provider log URL." } } }, evidence).route).toBe("repair");
});
