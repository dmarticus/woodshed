import { GitHub } from "../src/github";
import type { Config } from "../src/model";

const github = new GitHub({ repository: "PostHog/posthog", author: "@me" } as Config);
const numbers = await github.list();
console.log(`GitHub returned ${numbers.length} open non-draft PRs for the authenticated user.`);
if (numbers.length) {
  const pr = await github.snapshot(numbers[0]);
  console.log(`Read one current snapshot: ${pr.checks.length} checks, ${pr.threads.length} unresolved threads, ${pr.reviews.length} reviews; merge state ${pr.mergeStateStatus}.`);
}
