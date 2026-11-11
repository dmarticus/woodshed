# Woodshed

A PR caretaker with a native macOS app. Woodshed watches your non-draft GitHub PRs, coordinates coding sessions through Herdr Core, and brings human decisions to your inbox.

The controller runs on your Mac or an always-on Linux VM. Closing a window or quitting the Mac app does not stop maintenance. With the controller on a VM, maintenance also continues while your Mac is asleep or shut down.

## Run

Requires Bun, GitHub CLI authenticated with access to your repository, Herdr Core (`hc`), and Codex CLI signed in on this Mac. Woodshed does not read, copy, or store Codex credentials. Codex uses its own local login and permissions.

```sh
cp woodshed.config.example.json woodshed.config.json
```

Set `checkout` to your existing repository's absolute path. Keep `mode: "watch"` for monitoring, then start:

```sh
bun start
```

To keep the controller in Herdr, use `sh scripts/start.sh` instead. `hc attach woodshed` lets you inspect the controller; `hc kill woodshed` stops it. Stop only Woodshed's terminal, not the shared hc server. The local HTTP service is an API for the native app; it no longer serves a web UI.

Preview invented data without contacting GitHub or launching agents:

```sh
bun run demo
```

## macOS app

```sh
sh scripts/build-mac.sh
open dist/Woodshed.app
```

The app needs the controller running. Its menu shows **Needs you**, **Running**, a collapsed **Waiting** count, and **Ready to merge**. Only live agent sessions appear under Running. A quiet queue leaves a quiet menu. The hammer reflects Watch, Auto, or Paused; an orange dot means something needs you. Conventional commit prefixes are removed from display titles, and PR numbers are displayed without thousands separators.

Launching Woodshed, clicking its Dock icon, or choosing **Open Woodshed** (⌘O) opens the same main window with a PR sidebar and agent run details. Closing the window keeps Woodshed running; the Dock icon restores it, including when minimized. The menu-bar controls remain available. To pin the icon after quitting, choose **Options → Keep in Dock** from its Dock menu. Checks and unresolved review threads expand from summary chips. Run history shows one entry per session, including model, turns, duration, and estimated spend. Stack position appears when GitHub supplies stack metadata. Refresh is available with ⌘R in the main window. The app subscribes to authenticated server-sent state updates instead of polling every five seconds.

Decisions show structured choice buttons when available, with a free-text fallback. The composer supports replies, one-off instructions, and a per-run model override. Interrupt is on the Running header. Paused PRs show Resume; unwatched PRs show Watch PR; ready PRs show Merge on GitHub. One-off runs work in Watch mode. **Stop watching** applies only to the selected PR and stops its current run. Recheck and GitHub links live in the window toolbar. Permission and login prompts require opening the hc session; ordinary questions can be answered in the window. Replies are tied to the displayed head and a stable question identity. Stale replies are saved, refreshed, and applied automatically only if the same question still applies; changed questions require confirmation with the saved draft. This also applies to notification replies.

The toolbar’s action menu can request a human reviewer by GitHub username or `organization/team`. This explicit action may notify that reviewer. Woodshed does not merge or enqueue PRs; ready PRs open on GitHub for your merge decision.

Woodshed requests notification permission on first launch. If notifications are off, the menu points to Notifications settings. Banners offer **Reply**, **Retry**, **Skip run**, **Open**, or **Spend settings** as appropriate. Skipping stops a run and suppresses further work on that commit. Notifications are limited to decisions, finished runs, and ready PRs; CI and review waits stay quiet. They are deduplicated across restarts and suppressed in previews. Delivery also depends on System Settings and Focus mode. The app is built for Apple Silicon, macOS 14 or newer, with local ad-hoc signing; it is not notarized or configured to launch at login.

## Enable automation

Use the **Watch / Auto / Paused** control in the menu or Settings. Watch follows PRs and allows explicit one-off runs. Auto requests reviews and starts repairs. Paused queues new work and replies; existing runs continue. Settings (⌘,) apply immediately and use native toolbar tabs for General, Automation, Notifications, and Spend. Currency caps are single formatted fields. General can watch your PRs, your PRs plus review requests, or a custom GitHub query. Auto only modifies PRs authored by the signed-in GitHub user.

Woodshed uses a separate detached Git worktree per attempt, one coding session per PR, and a configurable active-run concurrency limit. Jobs use an interactive Codex app-server bridge inside hc with workspace-write permissions and network access for the authorized PR task. Routine approvals use Codex's automatic reviewer. Product questions, visual approval, unavailable credentials, and actions the reviewer cannot approve still go to you. **Open session** launches the PR's hc session in Terminal. A worktree may require its own development environment before tests can run.

### Unattended Git access and signing

Woodshed rewrites GitHub SSH remotes to HTTPS for its own Git processes and agent shells, using the existing `gh` login. It does not edit your global Git configuration or repository remotes. This avoids Secretive authentication prompts on background fetches. Ordinary agents prepare and test edits, then return the exact changed file list. The controller checks that list, verifies the live PR target and remote head, stages the declared changes, and runs the commit and push hooks. A concurrent head change stops publication. Publication state persists so a restart does not create a duplicate commit.

Run this once from the Woodshed project to provision unattended signing:

```sh
bun scripts/setup-signing.ts
```

It creates an Ed25519 signing key under `~/Library/Application Support/Woodshed/signing/`, outside the repository, with an owner-only directory and private key. The key has no passphrase so the service can sign unattended; it is a local file rather than a Secure Enclave key. Only the public key is registered with GitHub, as a signing key. Your normal signing key remains configured for your other tools. If the current GitHub login lacks `admin:ssh_signing_key`, authorize that scope once with `gh auth refresh -h github.com -s admin:ssh_signing_key` and rerun setup. Private key contents are never written into Woodshed config, prompts, or logs.

The config records only `gitSigningKey`, the private key's absolute path. Restart the controller after setup. Existing active workers can be updated with `bun scripts/upgrade-workers.ts <PR numbers>` while the controller is stopped. This retains their worktrees, Codex threads, spend, and concurrency limits; genuine product questions remain waiting.

Automation settings choose the default model and optionally escalate to another model after a failed attempt. Available models come from your local Codex catalog, using your existing login. A per-run override does not change that default.

### Spend

Run details, Running rows, and the menu footer show estimated USD from reported token usage. These are **API-equivalent estimates, not charges on your Codex subscription**. Included standard rates cover GPT-6.1 Sol, GPT-6 Astra, and GPT-6 Luna; pricing references are linked in Spend settings. Other models require token rates entered there before a capped run can start. Cached tokens and long-context rates are accounted for separately. Missing usage stays unknown rather than appearing as a free run.

Per-run and local-calendar daily caps default to $5 and $20. Concurrent runs reserve their remaining allowance. Reaching a cap interrupts the run and creates a Needs you decision. Allow $1.00 more extends only that run and queues it for the next available slot. The daily cap and default run cap stay unchanged; increasing the daily cap is a separate explicit settings action. Stop run preserves its checkout. Caps are checked when usage arrives, so an in-flight model call can exceed the remaining estimate; they are not a billing guarantee. Lowering a cap also applies to active runs. Usage and per-day totals persist in SQLite across controller restarts. Clean branch merges use no model call.

GitHub rate limits back off automatically until their reset (or a short retry delay for secondary limits), without creating an owner decision. The controller refreshes GitHub periodically, batches PR state and first pages in GraphQL, paginates remaining checks and review threads, uses conditional ETag requests for REST discovery and stack metadata, records jobs before launch, and persists retry budgets in SQLite. It verifies actual GitHub state after an agent reports publishing. Identical failure sets keep their attempt budget across new commits. Startup uncertainty goes to a person instead of triggering duplicate jobs.

Needs you gets its own GitHub refresh every 30 seconds, including while the regular PR poll is busy. Resolved checks and threads, approved visual changes, superseding approvals, new commits, and closed or merged PRs remove obsolete attention items. An agent that continues after an answer in its hc session also leaves Needs you. Obsolete blocked runs are stopped and retained in history; their worktrees and spend remain available. The native app removes the corresponding attention notification on its next refresh. Genuine product questions and unresolved blockers stay until evidence resolves them; an API error does not dismiss a decision. This attention refresh does not launch agents, request reviews, or publish changes.

Check history is scoped by workflow identity and run time. Replaced cancellations and earlier attempts stop counting as current failures; a lone cancellation remains blocking unless GitHub explicitly marks that check as optional. Unrelated workflow failures remain visible. Advisory CI-report warnings and successful quarantined visual results do not require a human decision.

### Escalation investigation

Before an agent report enters Needs you, a separate bounded Codex run verifies it against fresh GitHub checks, review requests, approvals, unresolved threads, comments, and relevant linked issues. Each unresolved review thread is classified as addressed, needing repair, or awaiting its reviewer. Addressed findings require a code link pinned to the current commit. In Auto, the controller can resolve verified PostHog Review threads containing only bot comments after rechecking ownership, the PR head, and the unchanged discussion. Human discussions stay open for their reviewers. Already requested reviews wait quietly when no repairable blockers remain; the original investigation verdict is preserved. Conflicts, required base updates, failing checks, and unhandled findings continue through the saved repair's follow-up path. Routine repairs and output-protocol errors go back to the original saved checkout, with at most two follow-ups. Exhausted repairs identify the remaining blocker and link directly to its review discussion when available. A clean no-change result skips publication. Worktrees, existing edits, and accumulated spend are preserved.

Only a verified question reaches you, as a short next step with evidence links. Run output stays behind **Run details**. **Recheck GitHub** repeats the investigation; answers are investigated before resuming work. Operational prerequisites remain questions until completion evidence or your answer resolves them; green CI alone does not clear them. Investigations share concurrency and daily limits, have a maximum $1 run allowance (or your lower configured limit), and stop after two unsuccessful attempts. Owner escalations remain attached to the relevant blocker until you act, the commit changes, or that blocker changes. Unrelated CI progress and PR timestamps do not restart an exhausted repair or repeat its notification. Other cached investigations refresh when GitHub evidence changes. Linked issues are checked during investigations and explicit rechecks; they are not independently polled.

Optionally set `TYPESAFE_API_KEY` in the controller process environment to enable a second routing check with TypeSafe's pinned `jev-1.14.0` model. This sends the structured investigation and a compact GitHub summary to TypeSafe; credentials and raw run output are excluded. Jev returns a typed route and confidence. A high-confidence disagreement triggers one more GitHub investigation, never an automatic dismissal of a human prerequisite. Missing keys and API errors leave Codex triage usable. Successful TypeSafe calls record input-token cost in the spend ledger. Jev disagreements, proposed routes, confidence, and subsequent triage outcomes are retained in SQLite audits for threshold evaluation; the 0.9 threshold stays fixed until that data supports a change. Restart the controller after changing its environment. Keep the key out of the repository and config JSON.

`/health` reports the routing check as `off` (no key), `idle`, `ok`, or `failing` (three consecutive errors), with the last success, last error, and the last time it was skipped for budget. Add `"requiredIntegrations": ["typesafe"]` (and/or `"posthog"`) to the config to treat a missing key as a warning: the menu shows it with an orange dot, and a deploy whose new controller reports it rolls back. A failing routing check also warns, but does not block deploys. Independently of that setting, a deploy rolls back if the new controller loses an integration the previous one had, such as a `.env.local` that did not carry over.

The menu also warns when herdr fails three commands in a row (it can stay up while its registry writer is stopped, so every run looks stuck; `hc server restart` recovers it) and when the disk holding `.woodshed` is at least 80% full. Neither warning blocks deploys.

Jev also runs in shadow mode before each investigation, routing from GitHub state and the agent's report alone. Shadow verdicts are recorded as `jev-shadow` audits and never change the investigation. A verdict counts as a would-be skip when Jev answers wait or ready with confidence of at least 0.9 and the PR has no unresolved threads; threads still need the investigation's per-thread code evidence. `bun scripts/jev-shadow-report.ts [state.sqlite] [days]` compares shadow verdicts with the investigations that followed and reports safe skips, unsafe skips, and the investigation spend that safe skips would have avoided. Skipping is not enabled; that decision waits on this data.

Optional PostHog product analytics uses a separate project ingestion token. Set `POSTHOG_PROJECT_TOKEN` in the Woodshed checkout's `.env.local`; set `POSTHOG_HOST` for a non-US region or self-hosted instance. The default host is `https://us.i.posthog.com`. This token is separate from the chat's PostHog connection and `TYPESAFE_API_KEY`.

Analytics tracks PR enrollment, verified readiness, observed merges and closures, owner decisions, native and MCP actions, notifications, and repair, triage, and routing-check runs. Events use random local identifiers for PRs, maintenance episodes, decisions, and runs. Repository names, PR numbers, heads, titles, prompts, review text, code, and error messages are not sent. Geolocation enrichment and person profile creation are disabled for new events.

Events use `schema_version=2`. Existing open PRs and active runs are marked `baseline` when tracking first attaches. Exclude baseline PR episodes from enrollment-to-readiness timing because their earlier history is unknown. A readiness event requires fresh controller readiness evidence; it does not authorize a merge. `without_owner_decision` means no recorded Needs you decision in the episode; it cannot account for human work outside Woodshed.

A run starts once. Suspension and resumption create numbered segments; `woodshed_run_finished` describes the end of a segment, not proof that the PR is ready. Run completion carries a cumulative estimated cost snapshot. Sum only `cost_usd_delta` on `woodshed_run_cost_updated` to calculate spend without counting resumed runs twice. Unknown usage stays unknown. Values are API-equivalent estimates, not Codex subscription charges.

Events are queued in a private local SQLite outbox and retried after network errors, server failures, and rate limits. Retries preserve the original timestamp and insertion ID. Permanent HTTP rejections are retained in quarantine. The ingestion token is not stored in queued payloads. Preview mode disables analytics. PR actions never wait for analytics network delivery.

### Automatic conflicts and branch updates

When GitHub reports a conflict or requires an up-to-date branch, Woodshed merges a pinned commit from the PR's own base into an isolated worktree. Clean merges need no model call. For real conflicts, Codex edits the conflicted files and explains how it preserved both branches' intent. Necessary integration edits may also touch up to three existing PR-owned text files, with at most 300 added or deleted lines relative to the automatic merge. The controller verifies ownership, regular-file identity, file modes, size, and the additional diff; base-only files, binary files, and instruction or hook changes remain blocked. Woodshed stages the permitted resolution and publishes a normal two-parent merge commit, with the repository’s commit and push hooks enabled. Repair and base-update commits include a `Woodshed-Run: <id>` trailer and use the configured dedicated Woodshed signing key. It never rebases or force-pushes.

Migration-number collisions are reconciled by the controller before an agent starts. For a linear chain added only by the PR, Woodshed renumbers the files after the pinned base's migration tip, updates the chain's dependency strings and `max_migration.txt`, and adjusts exact migration-name references in other PR-owned files. A Python AST parser changes only dependency literals inside migrations; schema and data operations stay byte-for-byte unchanged. Existing base migrations remain unchanged. The repaired files become part of the controller's prepared merge, so the agent only resolves the remaining code conflicts. This uses macOS's `/usr/bin/python3` standard library, without importing Django or executing migration code. Renumbering migration files does not rebase Git history.

Before merging, the controller identifies missing file objects in the merge inputs and downloads them without changing the worktree. If Git's partial-clone transfer fails, a bounded GitHub blob API fallback verifies each object's size and Git hash before adding it to the local object cache. Invalid content stops preparation. Preparation progress appears in the native run view and output panel, with zero model usage until the coding agent starts.

Before publishing, the controller checks the merge parents, both ancestors, unresolved conflict markers, changes outside the permitted resolution files, and base-only files appearing in the PR diff. It verifies the GitHub target and remote head again. Concurrent branch changes cause a fresh plan rather than overwriting newer work. The base may advance during the attempt: Woodshed incorporates the pinned commit and lets the next GitHub refresh determine whether another update is actually required.

A completed resolution blocked by the old conflict-only scope rule can be recovered once after its additional edits pass these checks. The saved resolution is revalidated through the normal publication path without another agent call. This does not reset follow-up counts or spend limits. Resolutions that fail the bounded integration checks stay blocked.

Agent reports and guard failures pass through an independent read-only GitHub investigation before reaching you. The conflict-resolution task instructs the agent to edit only; the controller owns staging, committing, and publishing after validation. After publication, Woodshed waits for fresh CI and reviews. In monitor mode conflicts appear as queued repairs, with no branch changes or agent launches.

## Current boundaries

- GitHub polling, not webhooks. One repository with author, review-request, or custom-query filtering; matching open PRs, including drafts, appear in Woodshed. Drafts stay in their own list and do not start maintenance. Mark drafts ready individually or select several in the main window; convert an authored PR back to draft from its context menu. Right-click PRs in the menu bar dropdown or main list for GitHub actions and, on watched ready PRs, to start a task. Previously enrolled open PRs remain tracked until you stop watching them.
- PostHog Review and Stamphog use configurable GitHub labels. Auto requests Stamphog once the current commit has completed CI, no unresolved feedback, and a current-commit review. Outstanding reviewer requests do not block this approval stage. Watch mode offers **Request Stamphog approval** in PR details and menus. Requests are recorded per commit; existing approval labels are removed and re-added to trigger a fresh request after a commit changes. The UI shows **requested** until GitHub records approval on that commit. Refusals require a human review, and remaining GitHub approval requirements still apply. The PostHog MCP integration is not wired into this standalone app.
- Readiness requires completed checks, no open inline threads, review on this commit, GitHub approval, and known mergeability. A current-commit approval, including Stamphog approval, satisfies review without requesting a duplicate PostHog Review. It is a handoff signal; repository merge queue and branch protection remain authoritative.
- Top-level discussion comments are not independently classified. Review summaries are supplied to agents when a repair runs. Ambiguous feedback and human change requests require a person.
- Confirmed visual-change statuses are sent to you with their explanation and a direct diff link. Cancelled snapshot jobs, artifact errors, and generic visual CI failures go through the repair path. Woodshed does not accept new image baselines. It does not yet embed images or record a visual approval.
- Agents resolve the remaining conflicted paths and bounded, necessary integration edits in existing PR-owned files. The controller also handles the migration-chain repair above. Historical migration edits, dynamic dependencies, squash/run-before graphs, and ambiguous cross-app references require further validation rather than automatic rewriting.
- Review and approval waits have no timeout yet. An unavailable reviewer can leave a PR waiting; native details expose its state.
- **Paused** stops new work. It does not kill an existing agent: open the run to interrupt or take over. Changing back to Watch or Auto rechecks the existing job rather than launching another writer.
- Clean worktrees belonging to closed/merged PRs can be removed after seven days. Run artifacts expire after thirty days; SQLite run/spend history remains. Active, blocked, budget-waiting, referenced, dirty, or ignored-file-containing worktrees are preserved. Cleanup uses ordinary Git worktree removal without force. Service installation at login is not implemented.
- A macOS idle-sleep assertion is held through `caffeinate` only while a job is running. Manual sleep remains available; sleep/wake events mark interrupted jobs for rechecking.
- Infrastructure recovery is separate from repair attempts. Failed preparation, unavailable hc connections, and interrupted app-server workers retry after 30 seconds, two minutes, and ten minutes, on a later GitHub poll. Recovery state survives controller restarts. A verified live worker is retained, and an unavailable core never causes a second worker to launch. Interrupted workers resume in their saved checkout and Codex thread with accumulated usage and the original spend limits. Recovery pauses with the app mode or PR and rechecks the current head before continuing. After three retries, a concrete Retry recovery action appears.
- A broken partial-clone object cache causes the next preparation attempt to use a fresh Git object store. The failed checkout stays intact. The fresh repository retains the original hook path and commit identity; signing, head checks, ancestry validation, and publishing hooks still apply. Startup failures before an agent exists cost zero model usage. Sleep labels apply only to active runs and clear after reconnection; a stalled event loop alone does not label jobs as asleep.
- The service binds only to `127.0.0.1`. Every API request, state stream, and `/health` request requires a random bearer token from `~/Library/Application Support/Woodshed/api-token` (owner-only, mode 0600). Unexpected Host headers and every Origin header are rejected. The native client reads this credential locally; it is never sent to Codex or returned in API state. `WOODSHED_TOKEN_PATH` overrides the location for isolated previews. `/health` reports last poll/contact, queue depth, running work, GitHub connection errors, and sleep state. State and prompts stay in the ignored `.woodshed/` directory.

## Agent handoff and MCP

Run the local MCP server with `bun run mcp`, or register its bundled entry with Codex:

```sh
codex mcp add woodshed -- /opt/homebrew/bin/bun /Users/dylan/github.com/dmarticus/woodshed/dist/woodshed-mcp.js
```

Reconnect the MCP client after registering. Other clients can run the same command over stdio. The bridge reads the private local controller credential; no secret belongs in the MCP configuration. It accepts only a loopback controller URL, optionally through an SSH tunnel. Closing the bridge does not stop the controller or its jobs.

The server provides `handoff-pr`, `get-pr-status`, `list-attention`, `request-recheck`, and `wait-for-change`, plus `woodshed://inbox`, `woodshed://prs/{number}`, `woodshed://prs/{number}/readiness`, and `woodshed://playbooks` resources. Status responses include a stable version, freshness, the next action owner, run progress, estimated spend, and implementation context. Reads are cached; `request-recheck` refreshes GitHub with head binding. Waits are cancelable and bounded to 25 seconds, with a maximum of 32 outstanding waits. A polling timestamp alone does not wake a waiter.

Hand off only after publishing a ready-for-review PR. Supply the repository, PR number, current 40-character head, a stable `request_id`, summary, intent, deliberate tradeoffs, validation performed, and optionally an opaque implementation session reference. Complete handoffs are limited to 12 KB. Retries reuse the same request ID and payload; changed payloads or stale heads are rejected. Handoffs persist in SQLite and feed later repair prompts. Validation supplied by an agent never substitutes for fresh checks. Session references are context; Woodshed does not execute them or take over an arbitrary workspace.

At the start of an authoring session, read `woodshed://outcomes` (or `woodshed://outcomes?since=7d`) for local historical context. `api/agent/outcomes?since=14d&limit=50` selects the most recent handed-off PRs in the configured repository authored by the signed-in user; the limit is 1–200 distinct PRs. The digest includes observed review findings, CI-triggered repairs, repair rounds and run estimates, owner decisions, controller repairs, readiness timing, merges and closures. Recurring patterns count distinct PRs and link to commit-pinned evidence when available. Up to eight lessons are generated from those counts without a model call. The complete response is capped at 16 KB; truncation is explicit.

Capture starts when the feature observes a handoff. Older handoffs have partial coverage: missing repair counts, owner-decision history, models, publication results and readiness times remain unknown. A resumed repair can contain multiple rounds in one run; its reported cost is cumulative for that run, not apportioned among rounds. Cancelled and replaced checks do not become CI patterns, and verified controller-only branch/migration repairs are separated from authoring-agent patterns. Review reasons are retained locally, but raw review comments are not copied into outcome history. Paths, text, PR numbers and session references from this history are never added to product analytics. The digest is historical evidence, not a rule set, permission grant or current merge evidence, and is not injected into repair prompts.

Read `woodshed://decisions/src/api/report.py` before editing a file, or query `api/agent/decisions?path=src/api/**/*.py` for a group of files. Woodshed retains tradeoffs from the latest accepted handoff when its PR merges. A string tradeoff applies to every changed file. Use `{"text":"Keep archived reports visible to owners","paths":["src/api/report.py"]}` to name exact repository paths instead. A PR closed without merging contributes no decisions.

Each decision keeps the PR URL, merge commit and date, and the file identities from that merge. Reads return up to 20 decisions, newest first within each freshness group. A changed or removed file makes its decision possibly stale. Unavailable base metadata leaves freshness unknown and cannot trigger deletion. Housekeeping removes a decision only after every applicable path is absent. Missing merge metadata is retried; a read does not create a decision. There are no agent write or delete operations, and decision content stays out of product analytics.

Repair prompts include applicable decisions for known PR, review, CI, or conflict paths. If the final file list surfaces additional context, the repair reviews it before publication under the existing budget and scope. These records are historical evidence and grant no permissions.

Enrolling a PR does not change Watch, Auto, or Paused, and preserves a PR's existing pause and active job. Auto remains responsible for launching maintenance. The server exposes no tool for answering human questions, changing budgets, approving visual diffs, or merging a PR.

### Scheduling and readiness

In **Settings → Automation**, choose **Automatic** concurrency to admit agents according to measured CPU usage and available memory. The default targets are 80% CPU and 80% memory. The controller starts at most one new agent every five seconds and checks known queued work every two seconds. It leaves at least 512 MB of launch headroom beyond the memory reserve and samples usage again before the next start. Network-bound agents can outnumber CPU cores; there is no fixed agent-count limit in Automatic mode. Reaching a target pauses new starts; it does not terminate existing runs or impose a hard OS resource limit. **Fixed limit** retains a manual maximum. Existing configurations keep their fixed policy until Automatic is selected. Available daily budget is shared among runnable PRs, new runs need at least $0.10, and stack dependencies still wait for lower PRs. Queue messages explain resource and budget waits.

## Trunk merge queue

Woodshed recognizes Trunk through its GitHub bot and authenticated Trunk check runs, using the controller's existing `gh` login. No Trunk API key is required. Ready PRs show **Add to merge queue**. For a stack, the button names the number of included PRs and lists their numbers before submission. The controller refreshes every included PR, checks ownership and readiness, and requires the displayed commit IDs to match before posting Trunk's `/trunk merge` command. Trunk still enforces the repository's merge protections. A queued submission authorizes Trunk to merge; Woodshed never submits automatically or exposes submission as an autonomous MCP tool.

Submitted PRs appear under **Merge queue**, separate from repair jobs. Queue tracking continues in Watch and Paused modes. Trunk's **Pending Failure** remains an active queue state while it determines whether an upstream PR caused the failure. Network errors, missing observations, and partial responses never count as evictions. New maintenance work is held while a PR is queued, and an already-running repair is stopped with its checkout preserved if the PR enters the queue externally. Publication rechecks known Trunk queue state before attempting a push.

A confirmed failure or cancellation after an observed submission creates a durable **Removed from the merge queue** item and one notification per attempt when **Needs you** notifications are enabled. The item offers queue details, resubmission when ready, repair instructions, and dismissal. Historical failures discovered on first connection do not generate new eviction alerts. Successful merges leave the queue quietly. Re-submission is always an explicit user action. Interrupted submission responses remain pending for verification rather than automatically posting another command.

The integration polls known queue entries every 30 seconds and discovers other changes on the normal GitHub refresh. It uses [Trunk's supported GitHub commands](https://docs.trunk.io/merge-queue/using-the-queue/reference) and [GitHub queue status](https://docs.trunk.io/merge-queue/using-the-queue/monitor-queue-status). GitHub comment submission is not an atomic compare-and-swap with the PR head; the controller rechecks the head immediately before posting, and Trunk controls final admission and merge protections.


Tracked stacks are scheduled from the base upward. Repairs above a PR with active repairs, conflicts, checks, or unresolved threads wait for it to settle. An upper PR waits for its tracked base PR to merge before reporting readiness. An ordinary base movement does not trigger a rebase or restack; the existing GitHub conflict and required-update rules still decide when a branch needs updating. Dependencies are inferred only when a unique tracked open PR owns the base branch.

A readiness report binds checks, reviews, mergeability, and the base to the observed PR commit. It expires after roughly two polling intervals, bounded to three to five minutes. Attached jobs, pending recovery or investigation, real human decisions, and refresh errors prevent readiness. The native detail view exposes this report; MCP can read its full evidence. It is evidence for a merge decision, never authorization to merge or enqueue.

Before editing code for CI-only failures, Woodshed checks for a shared infrastructure incident. Matching runner or download failures must appear in current job logs on at least two distinct PRs, with both heads verified against GitHub. It requests at most one failed-workflow rerun per head and run, then waits at most five minutes before normal investigation resumes. Failed checks remain visible and never count as passing. A code failure mixed with an infrastructure failure follows the ordinary repair path.

The playbook catalog exposes existing deterministic base merges, supported migration-chain repairs, fresh Git object-cache recovery, and agent conflict resolution. Completed controller actions are counted once. Other repairs enter memory only after publication is verified and fresh checks pass on that exact commit. Later agents receive up to three examples from other PRs with the same failing check names. These are advisory context; current logs, scope, repository rules, and validation still govern every repair. No learned patch executes automatically.

### Always-on Linux host

An ordinary Cloudflare Worker cannot run the existing Git, hc, and Codex processes. A Linux VM can run them directly. A Cloudflare Sandbox would need a separate execution and persistence adapter. The current headless setup targets a non-root Linux user with systemd; actual remote deployment requires a host and its credentials.

The VM needs Git, GitHub CLI, Bun, hc, Codex, and the repository's development tools. Configure Git author identity, complete `gh auth login` and `codex login`, and prepare a repository checkout containing `AGENTS.md`. PostHog checkouts also need their Flox environment.

For a fresh, dedicated Ubuntu 24.04 x86_64 VM, `scripts/bootstrap-linux.sh` performs the system setup as root. It creates the unprivileged `woodshed` user, copies the administrator's authorized SSH public keys to that user, enables persistent user services, adds 8 GB of swap, and installs Git, the current official GitHub CLI, Node 24, Bun, Codex, hc, and Flox. It disables password-based SSH and enables automatic security updates. Configure the provider firewall to allow SSH; keep the controller port private. The script waits for cloud-init to finish before installing packages. Deploy the source under `/home/woodshed/repos/woodshed`, clone the maintained repository separately, and finish authentication as `woodshed` before installing the service.

The service setup commands below also work on an independently prepared Linux host:

```sh
bun install --frozen-lockfile
sudo loginctl enable-linger "$USER"
bun scripts/setup-headless.ts /absolute/path/to/repository
bun scripts/setup-signing.ts
systemctl --user restart woodshed.service
```

Bootstrap creates a private user service in **Watch** mode. It checks tool availability, GitHub and Codex login, and persistent user services. The API token lives at `$XDG_CONFIG_HOME/woodshed/api-token`, or `~/.config/woodshed/api-token`. The unattended signing key lives alongside it under `signing/`. The service restarts after failure and starts at boot with lingering enabled. It invokes Bun directly; hc owns individual agent sessions. Stopping the controller leaves those sessions intact.

Cut over only after pausing local scheduling and letting every local job finish, including saved or blocked jobs. Confirm there are no local jobs left, then stop the local `woodshed` controller. Keep its database and worktrees as a backup. Remote bootstrap discovers matching PRs afresh; it does not migrate local sessions or history.

Configure an SSH host alias and the same hc machine alias for the VM. Keep the service bound to loopback, and forward local port 7341 to remote port 7341:

```sh
hc machine add --install --name woodshed-vm user@host
hc run --bg --no-parent --name woodshed-tunnel --cwd /absolute/path/to/woodshed bun scripts/tunnel.ts woodshed-vm
```

The tunnel script reconnects after SSH interruptions with bounded backoff and requires existing SSH authentication. An SSH alias named `woodshed-vm` must already exist in your SSH config. Securely copy the VM's API token to a private local file (mode 0600), then run `bun scripts/connect-remote.ts woodshed-vm /path/to/that/file`. The command verifies it is reaching the headless service, writes a private connection file, and leaves the local credential intact. Reopen the app and reconnect MCP. Enable Auto on the remote controller only after confirming that the local controller is stopped. Never run both controllers in Auto for the same PRs.

The Mac app and MCP bridge read `~/Library/Application Support/Woodshed/controller.json`. The connection uses a loopback tunnel and a separate remote token. General settings show where runs execute. Opening a run attaches to the remote hc machine. Mac sleep stops local delivery until reconnection; it does not pause the remote service. A remote GitHub login must be refreshed on the VM. Removing the connection file returns clients to the local controller on their next restart; stop the remote scheduler before resuming local Auto. Notifications while the Mac is asleep require a separate delivery channel and are not provided by the tunnel.

After connecting, `bun scripts/smoke-mcp.ts --live` verifies tools, bounded waits, and resources through the configured controller connection. Restart existing MCP connections after cutover so they read the remote credential. To reconnect the tunnel automatically after Mac login, run the tunnel script from a user LaunchAgent with `RunAtLoad` and `KeepAlive`; the script handles reconnecting after SSH interruptions. Keep the VM's timezone consistent with the Mac's daily budget, and preserve existing daily usage when migrating a controller so cutover does not reset its spend allowance. Old agent sessions and run history remain on the original machine.

## Releases and deployments

Pull requests to `master` run Linux controller tests, TypeScript checking, demo HTTP/MCP smoke checks, and a Swift 6 Apple Silicon build with native interaction checks. These checks use invented fixtures and do not call models or modify live PRs.

Every push to `master` runs those checks and then publishes a GitHub Release. Versions use the major/minor from `package.json` plus the release workflow run number, for example `v0.1.12`. Re-running a workflow keeps the same version and commit. Releases include the Mac app ZIP, a controller source archive with a frozen Bun lockfile, the MCP bundle, and SHA-256 checksums. The Mac app carries the release version and build number; the controller's authenticated `/health` endpoint reports its version and source commit.

The release workflow then deploys the tested controller archive to the VM over SSH. It installs dependencies in a new immutable directory under `~/woodshed-releases`, temporarily changes Auto to Watch, and waits up to 20 minutes for attached jobs and polling to finish. If jobs remain attached (including blocked jobs), deployment fails while the existing version keeps running. Finish those jobs and re-run the workflow. A queued newer push replaces older pending releases; a deployment already running is allowed to finish.

Before switching, deployment stops only the controller and takes a SQLite backup under `~/.config/woodshed/backups`. It atomically switches `~/woodshed-current`, starts the service, and checks that the running controller reports the exact release commit. A failed startup restores the previous directory and service. Auto resumes after success or rollback; a deliberate switch to Paused while draining is respected. Database, worktrees, transcripts, configuration, credentials, and daily spend persist across updates. Code rollback does not restore the database; future incompatible database migrations need an explicit migration and rollback plan. Old release directories and backups are retained.

The existing VM uses a systemd unit pointing at `~/woodshed-current`, with `WOODSHED_CONFIG=/home/woodshed/repos/woodshed/woodshed.config.json`. Each release links its `.woodshed` directory and `.env.local` to the original persistent files. For another VM, provision the headless service and this layout first. GitHub Actions needs repository variables `WOODSHED_HOST` and `WOODSHED_USER`, secrets `WOODSHED_SSH_KEY` and `WOODSHED_SSH_KNOWN_HOSTS`, and a `production` environment. The dedicated deployment key belongs to the non-root service user, and its host key is pinned. Never upload controller or model credentials to Actions.

Download the Mac ZIP from [GitHub Releases](https://github.com/dmarticus/woodshed/releases), unzip it, and replace the installed app. Existing controller connection settings stay in Application Support. These personal builds use ad-hoc signing and are not notarized; macOS may require explicit approval on first launch. Mac updates and replacement of a local MCP bundle are manual; deploying the VM does not replace either local binary. There is no in-app updater yet.

## Check

```sh
bun test
sh scripts/build-mac.sh
bun build src/mcp.ts --target=bun --outfile=dist/woodshed-mcp.js
bun scripts/smoke-mcp.ts
```

No model calls are needed for the controller tests or demo. Running automated coding sessions consumes the configured Codex account's usage.

`bun scripts/smoke-worker.ts` checks a real metered Codex session in a temporary directory, with no PR changes. It consumes a small amount of account usage. `sh scripts/build-preview.sh` and `sh scripts/check-ui.sh` render native previews from the invented fixture generated by `bun scripts/native-preview-fixture.ts`. Previews capture the entire native window, including its titlebar and toolbar. `sh scripts/check-native-interaction.sh` uses an isolated app bundle and a mock controller to check PR grouping and waiting reasons, navigation during slow requests, queued actions, per-PR failures, mode rollback, stale agent responses, and reply draft preservation. It does not change GitHub PRs.

`bun scripts/smoke-access.ts /absolute/path/to/woodshed.config.json` checks a background agent reading GitHub and preparing a file, followed by a controller-signed local commit. It does not push or change a PR.
