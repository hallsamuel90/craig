# RFC: Agent CLI Control Plane and Declarative Orchestration

- **Date:** 2026-07-27
- **Status:** In Flight
- **Author:** Sam / Codex
- **Amends:** 2026-05-01-rfc-craig-terminal-workspace-rewrite.md

---

## Context and goals

Craig already owns durable task records, worktrees, runner PTYs, GitHub pull-request metadata, a PTY daemon, a UI heartbeat, and preview-gated agent activity indicators. These pieces are useful but are not yet a control plane:

- command mode is primarily human-formatted and requires exact task ids
- GitHub PR discovery exists in `domain/task/prs`, but there is no explicit CLI repair command when automatic discovery misses a PR
- creating a task always provisions a new `craig/task_*` branch, so an existing PR cannot be adopted as a new Craig task
- activity snapshots and daemon events are transient and UI-owned
- prompts can only be entered through the foreground terminal surface
- there is no durable command, event, wait, cancellation, or parent/child task contract
- there is no declarative orchestration format

The product goal is to make `craig` usable by both people and agents as the local control plane for Craig. The first slices must solve problems that exist now, especially identifying task context and linking or importing PRs. Later slices build on those same contracts to observe agents, inject prompts across tasks, delegate bounded work, and run declarative furys.

Goals:

- ship useful CLI primitives before building a fury runtime
- make task and workspace context resolvable without scraping the TUI
- make every automation-facing command non-interactive and machine-readable
- explicitly repair, refresh, unlink, and inspect task-to-PR associations
- adopt a supported existing PR as a new task without manufacturing an unrelated branch
- expose task and agent runtime state through domain-owned contracts
- introduce a durable workspace event journal with resumable cursors
- deliver prompts to a specific task and agent tab through a durable, idempotent queue
- model parent/child delegation with limits, lineage, cancellation, and audit history
- define furys as versioned YAML DAGs whose persisted runs survive Craig restarts
- allow fury authors to place intentional, durable human review checkpoints before downstream work proceeds
- use events for normal orchestration transitions and heartbeat jobs only for reconciliation
- keep the TUI, human CLI, and agent CLI on the same domain services

## Non-goals

- a hosted Craig control plane or cross-machine coordinator
- arbitrary shell execution from fury YAML
- treating terminal silence as proof that work succeeded
- replacing GitHub Actions or general-purpose workflow engines
- parsing terminal text to infer structured step outputs
- supporting cyclic graphs, unbounded recursive delegation, or unlimited fan-out
- supporting fork-origin PR import in the first PR-import slice
- multi-user reviewer assignment, remote approval, or organization policy enforcement
- treating a local human checkpoint as a security sandbox against a process with unrestricted access to the same user account
- making the PTY daemon or UI state file the durable source of truth
- exposing an unauthenticated network API
- preserving the current ad hoc argv parser or human output as a machine contract

## Proposal

### Product sequence

The work lands as independently useful vertical slices:

1. machine-readable context and explicit PR repair
2. adoption of an existing same-repository PR as a task
3. durable agent status, events, and waits
4. targeted prompt dispatch
5. bounded parent/child delegation
6. YAML fury validation, execution, and intentional human review gates

The CLI primitives are the product foundation, not a temporary wrapper around fury implementation.

### Architecture boundaries

Craig retains the dependency direction `input/ -> shell/ -> domain/`.

```text
TUI input ─────┐
human CLI ─────┼──> shell adapters ───> domain services ───> durable .craig state
agent CLI ─────┘       │                       │
                      ├── PTY daemon           ├── task / PR records
                      ├── Git / GitHub          ├── command records
                      └── clock / process       ├── event journal
                                                  └── fury runs
```

Ownership rules:

- `domain/task/` continues to own task context, task lifecycle, and PR association result types.
- `domain/agent/` owns observed agent status. A new `domain/orchestration/` consumes that status and owns command records, event envelopes, prompt dispatch, delegation, and fury definitions/runs.
- Domain services define ports for runtime delivery, clocks, ids, and external lookups. They do not import `ui/`, the PTY daemon, or terminal rendering.
- Shell adapters implement those ports using the existing PTY daemon, Git, GitHub CLI, filesystem, and process runtime.
- `commands/` parses input and maps domain results to output. It does not own result types or business rules.
- The TUI consumes the same status and event services as the CLI. UI-only activity derivation moves behind a domain-owned agent-runtime contract before CLI status ships.
- The PTY daemon remains a transport/runtime owner. Durable command and workflow state is persisted before a daemon write is attempted.

### Runtime ownership and single-leader execution

Durable orchestration cannot depend on the foreground TUI remaining open. The existing workspace PTY daemon therefore hosts an orchestration supervisor:

- CLI and TUI mutations call domain services to persist intent, then send a best-effort wake signal to the supervisor.
- The supervisor reads durable command/run state and invokes idempotent domain transitions through shell adapters.
- The supervisor owns no workflow truth in memory; restarting it reconstructs work from records and the event journal.
- One workspace leader lock prevents two compatible daemons or recovery processes from delivering the same command concurrently.
- A short-lived CLI recovery path may acquire the same lock when no daemon can start, but it may only perform bounded reconciliation and cannot remain resident.
- The daemon protocol gains explicit orchestration wake, status, target-delivery, and subscription messages. Protocol compatibility remains versioned.
- The existing heartbeat scheduler moves from `ui/` to a reusable shell-owned module before the supervisor uses it. The TUI and supervisor may register different jobs against separate scheduler instances.

The supervisor reacts immediately to persisted intent and daemon runtime events. Its heartbeat covers deadlines and missed signals; it is not the primary queue.

### CLI contract

The automation surface is versioned from its first slice:

```text
craig [--workspace-root <path>] [--json] <group> <command> [arguments]
```

Global options may appear before or after the subcommand. Commands must not prompt when `--json`, `--no-input`, or `CI` is present. Mutations that may be retried accept `--idempotency-key <value>`.

Successful `--json` commands write exactly one envelope to stdout:

```json
{
  "schemaVersion": 1,
  "command": "task.pr.link",
  "ok": true,
  "data": {},
  "warnings": []
}
```

Failed `--json` commands write no stdout and exactly one structured error envelope to stderr:

```json
{
  "schemaVersion": 1,
  "command": "task.pr.link",
  "ok": false,
  "error": {
    "code": "PR_BRANCH_MISMATCH",
    "message": "Pull request head branch does not match the task branch.",
    "retryable": false,
    "details": {}
  }
}
```

Streaming commands use JSON Lines and declare that explicitly with `--format jsonl`. Human output remains the default but is not a compatibility contract.

Stable exit codes:

| Code | Meaning |
| --- | --- |
| `0` | success, including an idempotent unchanged result |
| `2` | usage or validation error |
| `3` | workspace, task, tab, command, or run not found |
| `4` | state conflict or ambiguous context |
| `5` | external dependency failure such as GitHub, Git, or daemon |
| `6` | wait or command timeout |
| `7` | partial result; durable state exists but a requested follow-up failed |

### Workspace and task context

Every command accepts explicit identifiers. Omitted context resolves deterministically.

Workspace precedence:

1. `--workspace-root`
2. `CRAIG_WORKSPACE_ROOT`
3. nearest ancestor containing a valid `.craig/index.json`
4. Git common-worktree lookup when invoked from a Craig-owned worktree
5. fail with `WORKSPACE_CONTEXT_NOT_FOUND`

Task precedence:

1. `--task`
2. `CRAIG_TASK_ID`
3. exact or ancestor match against a task `worktreePath`, `bundlePath`, or project target `worktreePath`
4. fail with `TASK_CONTEXT_NOT_FOUND`

Craig-launched PTYs receive:

- `CRAIG_WORKSPACE_ROOT`
- `CRAIG_TASK_ID`
- `CRAIG_AGENT_TAB_ID` for agent tabs
- `CRAIG_PARENT_TASK_ID` when delegated
- `CRAIG_FURY_RUN_ID` and `CRAIG_FURY_STEP_ID` for fury workers
- `CRAIG_CAPABILITY_TOKEN` when the launched agent has mutation permissions

The UI-selected task is never an implicit CLI fallback. This prevents a command in one worktree from mutating whichever task happens to be selected in another Craig process.

Initial context commands:

```text
craig context show --json
craig task current --json
craig task show [<task-id>] --json
```

### Explicit PR association and repair

Existing task-domain PR discovery remains the implementation base. It gains explicit operations:

```text
craig task pr show [<task-id>] [--repo <repo-id>] --json
craig task pr discover [<task-id>] [--repo <repo-id>] --json
craig task pr link [<task-id>] --pr <url|number> [--repo <repo-id>] --json
craig task pr refresh [<task-id>] [--repo <repo-id>] --json
craig task pr unlink [<task-id>] --pr <url|number> [--repo <repo-id>] --json
```

Rules:

- A URL identifies owner, repository, and number. A bare number requires an unambiguous repo task or `--repo`.
- `link` fetches the PR before persisting it; callers cannot inject arbitrary PR metadata.
- The PR repository must match the selected task repo/target.
- By default, the PR head branch must match the task or target branch.
- Linking an already-associated PR returns `disposition: "unchanged"`.
- Linking a different active PR is allowed because sequential PR history already exists, but the result warns when it changes the primary active PR.
- `unlink` is explicit and idempotent. It removes only the selected association and re-derives task status from remaining PRs.
- Project tasks require `--repo` unless the PR URL maps to exactly one target.
- Persisted `owner` and `repo` fields are populated from the verified GitHub locator.
- Writes update both the task record and PR status artifact through one task-domain service.
- Concurrent task writes use a workspace-local lock and re-read-before-write; last-writer-wins mutation is not acceptable.

### Importing an existing PR as a task

PR association does not by itself make a newly provisioned branch represent an existing PR. Adoption is therefore a separate command:

```text
craig task import-pr --repo <repo-id> --pr <url|number> \
  [--runner codex|cursor|claude] [--worktree <path>] [--title <title>] \
  [--no-start] --json
```

Version 1 supports same-repository GitHub PRs:

- Resolve and authenticate the PR before allocating durable task state.
- If the head branch is already checked out in a worktree, require that path through `--worktree` or discover one unambiguously.
- Otherwise fetch the head branch and create a Craig-owned worktree that tracks it.
- Persist `worktreeOwnership: "craig" | "external"` so close/cleanup never removes an adopted external worktree.
- Persist `taskOrigin: { type: "pull_request", provider, owner, repo, number }`.
- Use an id allocator that is independent of the imported branch name.
- Set the task branch to the real PR head branch, immediately persist the verified PR, and derive task status from it.
- Create normal agent/terminal tabs and launch the selected runner after the record and worktree are valid unless `--no-start` is supplied.
- If task persistence succeeds but runner launch fails, return exit `7` with the usable task id and a recoverable failed runner state.
- Reject fork-origin PRs with `PR_IMPORT_FORK_UNSUPPORTED` until remote ownership, push credentials, and cleanup semantics are designed.

Re-importing the same owner/repo/number returns the existing task unless `--allow-duplicate` is explicitly added in a later RFC.

### Agent runtime status

The existing dot states become a domain contract:

```ts
type AgentRuntimeState = "idle" | "working" | "ready" | "error";
```

- `idle`: no live runtime snapshot exists for the agent tab
- `working`: the agent process is live and produced activity inside the configured recent window
- `ready`: the process is live but quiet, or exited successfully and needs attention
- `error`: startup failed, the daemon lost a running session unexpectedly, or the process exited non-zero

Task roll-up priority is `error > working > ready > idle`, so a task remains visibly active while any agent tab is working. Agent-tab status remains independently visible.

This state is an observation signal, not workflow completion. A quiet agent may still be reasoning, and `ready` never means that a fury step succeeded.

Commands:

```text
craig agent list [--task <task-id>] --json
craig agent status [--task <task-id>] [--tab <tab-id>] --json
craig task wait [<task-id>] --state <state[,state...]> \
  [--tab <tab-id>] [--timeout <duration>] --json
```

`task wait` subscribes to daemon activity before reconciling its initial snapshot, eliminating the read/subscribe race. It exits `6` on timeout, reconnects across daemon availability changes, and supports `SIGINT` cancellation without mutating the task. With `agentOrchestration` disabled it retains the Phase `2.1` transport-specific path; with the preview enabled it reconciles and advances a durable event cursor without changing the command contract.

### Durable event journal

The current daemon messages are transient transport events, not a general eventing system. Craig adds a durable, workspace-scoped append-only journal under `.craig/events/`.

```ts
interface CraigEvent<TType extends string = string, TData = unknown> {
  schemaVersion: 1;
  id: string;
  sequence: number;
  workspaceId: string | null;
  taskId: string | null;
  agentTabId: string | null;
  commandId: string | null;
  furyRunId: string | null;
  furyStepId: string | null;
  type: TType;
  occurredAt: string;
  actor: CraigActor;
  data: TData;
}
```

Initial event families:

- `task.created`, `task.updated`, `task.closed`
- `task.pr.linked`, `task.pr.unlinked`, `task.pr.refreshed`
- `agent.state.changed`
- `command.queued`, `command.delivered`, `command.failed`, `command.cancelled`
- `fury.run.*`, `fury.step.*`, and `fury.review.*`

```ts
type CraigActor =
  | { type: "human"; source: "cli" | "tui"; processId: number }
  | { type: "agent"; taskId: string; agentTabId: string; capabilityId: string }
  | { type: "system"; component: "orchestration-supervisor" | "heartbeat" };
```

Journal requirements:

- monotonically increasing workspace sequence numbers
- append under a workspace lock
- replay from `--after <sequence|event-id>`
- bounded record size and payload redaction
- fsync/atomic segment rotation appropriate for local durability
- recovery that ignores only a truncated final line and reports all other corruption
- retention by rotated segment, never deletion of records still referenced by a live command or fury run

Commands:

```text
craig events list [--task <task-id>] [--type <glob>] [--after <cursor>] --json
craig events watch [--task <task-id>] [--type <glob>] \
  [--after <cursor>] [--format jsonl]
```

The daemon may publish ephemeral high-frequency snapshots. A shell adapter coalesces them into durable semantic state transitions so terminal output does not become an event per byte.

### Durable prompt dispatch

Prompt injection is modeled as a command record, not an untracked PTY write:

```text
craig agent send --task <task-id> [--tab <tab-id>] \
  (--prompt <text> | --prompt-file <path> | --stdin) \
  [--delivery when-ready|immediate] [--timeout <duration>] \
  [--idempotency-key <key>] --json
craig command show <command-id> --json
craig command list [--task <task-id>] --json
craig command cancel <command-id> --json
craig command wait <command-id> [--state <states>] [--timeout <duration>] --json
```

`when-ready` is the default. The flow is:

1. validate actor, target task/tab, prompt size, and capability
2. persist a `PromptDispatch` in `queued`
3. append `command.queued`
4. deliver through a target-specific daemon request when the tab is eligible
5. persist `delivered` and append `command.delivered`, or persist a retryable/non-retryable failure

The daemon request must include `tabId`; it must not depend on the foreground-selected PTY. Runner-specific delivery adapters encode text safely, reject unsupported control bytes, and submit exactly one prompt. `immediate` requires explicit human invocation or a capability that allows interrupting a busy target.

Command states:

```text
queued -> delivering -> delivered
   |          |             |
cancelled   failed
```

`delivered` means bytes were accepted by the live PTY, not that the agent understood or completed the request.

### Delegation and agent capabilities

Agent-originated mutations use an opaque, workspace-local capability passed to Craig-launched agent PTYs. The capability record is stored with restrictive permissions and defines:

- actor task and agent tab
- allowed command families
- allowed target tasks or `children-only`
- maximum children, depth, concurrency, and prompt bytes
- expiry and revocation

Human CLI use remains local-user authorized. Every mutation records actor and parent/child lineage.

Delegation commands:

```text
craig task create-child --parent <task-id> --repo <repo-id> \
  --prompt <text> [--runner <runner>] [--idempotency-key <key>] --json
craig task children [<task-id>] --json
craig task cancel-tree [<task-id>] --json
```

Task records gain `parentTaskId`, `rootTaskId`, `delegationDepth`, and optional `furyRunId`/`furyStepId`. Cancellation is top-down and idempotent. A child failure does not silently cancel siblings; that decision belongs to the caller or fury policy.

### Declarative fury format

A Fury definition is immutable input stored under `.craig/fury/`. Validation is read-only. Planning resolves inputs and runners, binds the graph to the current planning task, and persists an immutable content-hashed approval plan separately from runtime state.

```yaml
version: 1
name: review-and-fix

limits:
  max_concurrency: 3
  max_tasks: 8
  timeout: 2h

inputs:
  task_id:
    type: string
    required: true

steps:
  inspect:
    task: "${{ inputs.task_id }}"
    agent:
      runner: codex
    prompt: |
      Inspect the task and report the highest-risk issues.
    output:
      schema:
        type: object
        required: [issues]

  fix:
    needs: [inspect]
    create_child:
      repo: craig
    prompt: |
      Fix these issues: ${{ steps.inspect.output.issues }}

  verify:
    needs: [fix]
    task: "${{ steps.fix.task_id }}"
    prompt: "Run the relevant verification and report the result."

  human_review:
    needs: [verify]
    human_review:
      title: "Review the implementation"
      summary: |
        Review task ${{ steps.fix.task_id }} before follow-on work proceeds.
      feedback_target:
        task: "${{ steps.fix.task_id }}"
      timeout: 24h

  publish:
    needs: [human_review]
    task: "${{ steps.fix.task_id }}"
    prompt: "Continue with the approved follow-on work."
```

Version 1 rules:

- The graph must be acyclic.
- A step targets an existing task or creates one child task.
- Every `create_child` target becomes a direct child of the planning task. DAG dependencies control execution order and never change task ancestry.
- A concrete existing-task or feedback target must be the planning task; downstream `${{ steps.<id>.task_id }}` references may target children created by the same plan.
- A step is either an agent step or a `human_review` step; the two shapes are mutually exclusive.
- Steps use prompt delivery only; arbitrary `shell:` steps are rejected.
- References are limited to declared inputs and completed step outputs.
- Outputs are submitted explicitly, not scraped from terminal text.
- A human review step becomes runnable only after all `needs` succeed.
- Approval succeeds the review step and releases its downstream dependents.
- Rejection fails the review step and run.
- When `feedback_target` is declared, requesting changes keeps the gate blocked, records the review round and reason, and sends that reason through durable prompt dispatch.
- A gate without `feedback_target` supports approve/reject only; `request-changes` returns a conflict and leaves it waiting for review.
- The feedback target or a human explicitly resubmits the same review after revisions; resubmission never implies approval.
- A review without its own timeout remains bounded by the required run timeout. A review timeout fails the step unless the run was cancelled first.
- Static limits are required and validated before any task is created.
- Unknown fields fail validation.
- Running requires a durable human approval whose plan id and content hash still match. An approved plan produces at most one run.

Commands:

```text
craig fury validate <file> --json
craig fury plan <file> [--root-task <task-id>] [--input key=value] --json
craig fury approve <plan-id> --json
craig fury run <plan-id> --json
craig fury status <run-id> --json
craig fury watch <run-id> [--after <cursor>] --format jsonl
craig fury cancel <run-id> --json
craig fury resume <run-id> --json
craig fury step complete --run <run-id> --step <step-id> \
  (--output <json> | --output-file <path> | --stdin) --json
craig fury step fail --run <run-id> --step <step-id> --reason <text> --json
craig fury reviews list [--run <run-id>] [--state <state>] --json
craig fury review show <review-id> --json
craig fury review approve <review-id> [--note <text>] --json
craig fury review reject <review-id> --reason <text> --json
craig fury review request-changes <review-id> --reason <text> --json
craig fury review resubmit <review-id> [--summary <text>] --json
```

Agent steps use:

```text
pending -> ready -> running -> succeeded
   |         |          |
cancelled  cancelled   failed | timed_out | cancelled
```

Human review steps use:

```text
pending -> ready -> waiting_for_review -> succeeded
   |         |              |       |
cancelled  cancelled        |       +-> failed (rejected or timed out)
                            |
                            +-> changes_requested -> waiting_for_review
```

`approve`, `reject`, and `request-changes` require a human actor. `resubmit` may be performed by a human or by the specifically scoped feedback-target agent capability. A run reports `waiting_for_review` when no agent work is runnable or running and at least one review gate is waiting for a human decision.

Normal transitions are event-driven. The heartbeat periodically reconciles:

- queued commands whose delivery event was missed
- running steps whose timeout expired
- daemon sessions that disappeared
- runs interrupted by Craig restart
- stale locks and retry backoff deadlines

The heartbeat never executes business transitions without re-reading durable state and applying an idempotent domain transition.

Conditions, retries, `foreach`, dynamic fan-out, and recursive child-created Fury runs are deferred until the fixed DAG is reliable.

### Persistence model

New workspace-local state:

```text
.craig/
  commands/<command-id>.json
  events/<segment>.jsonl
  orchestration/
    capabilities/<capability-id>.json
  fury/
    definitions/<definition-hash>.yaml
    plans/<plan-id>.json
    approvals/<plan-id>.json
    reviews/<review-id>.json
    runs/<run-id>.json
```

Representative records:

```ts
interface PromptDispatch {
  schemaVersion: 1;
  id: string;
  idempotencyKey: string | null;
  taskId: string;
  agentTabId: string;
  prompt: { source: "inline" | "file" | "stdin"; text: string };
  delivery: "when-ready" | "immediate";
  state: "queued" | "delivering" | "delivered" | "failed" | "cancelled";
  attempts: number;
  lastError: CraigError | null;
  actor: CraigActor;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

interface FuryPlan {
  schemaVersion: 1;
  id: string;
  planHash: string;
  definitionHash: string;
  rootTaskId: string;
  inputs: Record<string, unknown>;
  steps: FuryPlanStep[];
  createdBy: CraigActor;
  createdAt: string;
}

interface FuryApproval {
  schemaVersion: 1;
  planId: string;
  planHash: string;
  approvedBy: Extract<CraigActor, { type: "human" }>;
  approvedAt: string;
}

interface FuryRun {
  schemaVersion: 1;
  id: string;
  planId: string;
  planHash: string;
  definitionHash: string;
  state: "pending" | "running" | "waiting_for_review" | "succeeded" | "failed" | "cancelled" | "timed_out";
  inputs: Record<string, unknown>;
  limits: FuryLimits;
  stepRuns: Record<string, FuryStepRun>;
  eventCursor: number;
  actor: CraigActor;
  createdAt: string;
  updatedAt: string;
}

interface HumanReviewCheckpoint {
  schemaVersion: 1;
  id: string;
  runId: string;
  stepId: string;
  state: "waiting_for_review" | "changes_requested" | "approved" | "rejected" | "timed_out" | "cancelled";
  title: string;
  summary: string;
  feedbackTarget: { taskId: string; agentTabId: string | null } | null;
  round: number;
  requestedAt: string;
  deadlineAt: string;
  version: number;
  lastDecision: HumanReviewDecision | null;
  history: HumanReviewDecision[];
  updatedAt: string;
}

interface HumanReviewDecision {
  sequence: number;
  round: number;
  action: "approve" | "reject" | "request_changes" | "resubmit";
  message: string | null;
  actor: CraigActor;
  feedbackCommandId: string | null;
  occurredAt: string;
}
```

Records carry a schema version. Readers migrate supported older versions in memory and rewrite only during an explicit mutation. Secrets and capability values are never copied into events, logs, JSON output, or fury definitions.

## Implementation tracker

### Status summary

- `1.1` Add machine-readable command output and deterministic workspace/task context: `verified; regression hardening complete`
- `1.2` Add explicit PR show/discover/link/refresh/unlink repair commands: `implemented, review-hardened, and verified`
- `1.3` Import an existing same-repository PR as a Craig task: `deferred by product decision`
- `2.1` Extract domain-owned agent status and expose list/status/wait: `implemented and verified`
- `2.2` Add the durable event journal and event list/watch: `implemented and verified`
- `3.1` Add durable, target-specific prompt dispatch and command inspection/wait/cancel: `implemented, review-hardened, runner-submission hardened, and verified`
- `4.1` Add capability-scoped parent/child delegation and tree cancellation: `implemented, review- and session-ownership-hardened, and verified`
- `5.1` Add fury YAML parsing, validation, and dry-run planning: `implemented, review-hardened, and verified`
- `5.2` Execute and recover an approved Fury DAG with structured completion and intentional human review gates: `implemented, Fury naming/sign-off and preview rollback/daemon safety hardened, and automated verification complete; isolated manual bug bash pending`
- `5.3` Add guarded retry policies and conditional steps: `deferred`
- `5.4` Add bounded `foreach` fan-out and dynamic delegation: `deferred`

### Verification summary

- `1.1` Verified by replacing ad hoc argv matching with a structured parser for order-independent global options; adding versioned JSON success/error envelopes, an authoritative error-code-to-exit-code mapping, non-interactive guards, and stable exit categories; resolving workspace context through explicit flags, environment, ancestors, and Git common-worktree discovery; resolving task and agent-tab context through explicit flags, environment, and task filesystem topology without UI selection; exposing `context show`, `task current`, and optional-context `task show`; and propagating Craig identity into task PTYs. Coverage includes every pre-existing parser command with global options before and after the command, flag separators, stdout/stderr isolation, no-input behavior, optional-context task-show execution, task/repo/workspace not-found exits, corrupt-record classification, precedence, missing/invalid/ambiguous/conflicting context, macOS canonical path aliases, project task bundles and repo targets, ambient-context isolation, and packed-artifact JSON success and failure execution. Automated verification passed with 515 tests via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `1.2` Verified by adding task-domain `show`, `discover`, `link`, `refresh`, and `unlink` association services and matching `craig task pr` commands; accepting numeric and GitHub URL selectors; resolving repo-task and explicit or URL-inferred project targets; fetching before link; rejecting repository, branch, and task-target mismatches with stable PR-specific conflict codes; preserving sequential repo-qualified PR history; keeping project target mirrors and PR status artifacts synchronized; re-deriving task status after mutations; and serializing PR, heartbeat, lifecycle, check, commit, cleanup, link, and UI task persistence through the same crash-recoverable task-scoped workspace lock. Review hardening also made unlink independent of a live local Git remote, promotes the preceding project PR when the active association is removed, and emits warnings only once at the stable JSON envelope level. Coverage includes invalid and duplicate options, global and positional task context, stable JSON envelopes and warnings, URL and numeric selectors, no-result discovery, idempotent duplicate link and unlink, offline unlink, active-PR replacement warnings and rollback, project ambiguity, repository and branch mismatch rejection, same-number PRs in different project repositories, concurrent CLI links, concurrent heartbeat/CLI and ordinary task/CLI persistence, stale-lock recovery, and exit `7` partial-result reporting when the task persists but its artifact write fails. Automated verification passed with 536 tests via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`. An authenticated disposable-workspace smoke against GitHub PR `hallsamuel90/craig#176` verified packed `link`, `show`, `refresh`, and numeric `unlink` JSON flows without modifying a real Craig task.
- `1.3` Deferred after confirming the Phase `1.2` machine-ready `task pr link` flow already addresses the current association-repair use case. Revisit only if real usage demonstrates that linking must safely replace a task branch or worktree.
- `2.1` Verified by moving PTY activity snapshots and the `idle | working | ready | error` derivation into a domain-owned agent contract; keeping animation presentation in the UI; adding a shell-owned daemon protocol and activity adapter that observes, reconciles, and reconnects to the existing daemon without starting it as a read side effect; and exposing `agent list`, `agent status`, and `task wait` with versioned JSON results, global task filtering, per-tab selection, task roll-ups, duration parsing, timeout exit `6`, and distinct machine-readable `SIGINT` cancellation. The CLI and sidebar now call the same state and priority functions. Coverage includes all four states, multiple-agent task roll-up, ignored terminal tabs, correctly scoped durable startup failure, successful and non-zero exits, absent daemon behavior with preview disabled, workspace-wide listing from inside a task worktree, missing or cross-task tabs, subscription-before-snapshot race prevention, the shell-owned daemon client's snapshot and connection-loss behavior, timeout, cancellation, and parser/JSON contracts. Automated verification passed with 552 tests via `pnpm test`, including the PTY daemon and real-terminal E2E suites, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `2.2` Verified by adding a generic domain-owned, workspace-scoped event contract and fsynced append-only JSONL segments under `.craig/events/`; serializing appenders with a crash-recoverable workspace lock; enforcing monotonic sequences, record limits, sensitive-field redaction, deterministic idempotency, atomic rotation, bounded segment retention, replay by sequence or event id, glob/task filters, cursor expiration details, truncated-active-tail repair, and hard failure for all other corruption. A shell reconciler emits coalesced `task.created | updated | closed`, `task.pr.linked | unlinked | refreshed`, and `agent.state.changed` transitions, using a compact atomic checkpoint to prevent retained-history rotation from manufacturing duplicate lifecycle events while deterministic ids repair append/checkpoint crash gaps. `events list` returns versioned JSON envelopes; `events watch` supports resumable human or JSONL streams without a read/subscribe race; and preview-enabled `task wait` advances the same cursor while retaining its stable Phase `2.1` contract when the preview is disabled. The new `agentOrchestration` preview gates event commands. Coverage includes concurrent append, sequence monotonicity, idempotency, replay, filtering, rotation, retention, redaction, sequence and event-id expiration, truncated-tail recovery, corruption, concurrent reconciliation, checkpoint survival across retention, semantic task/PR/agent transitions, preview gating, parser/JSON/JSONL contracts, cursor-backed wait, and a real daemon-backed watch through working, connection-loss error, daemon restart, and working-again transitions. Automated verification passed with 564 tests via `pnpm test`, including PTY daemon and real-terminal E2E coverage, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `3.1` Verified by adding domain-owned, versioned prompt command records under `.craig/commands/` with crash-safe atomic persistence, a workspace command lock, bounded prompt/idempotency/timeout validation, path-safe identifiers, idempotent creation, explicit state transitions, queued-only cancellation, stable not-found/invalid/conflict errors, and partial-result reporting when durable mutation succeeds but event append fails. `craig agent send` accepts inline, file, or stdin prompts with default `when-ready` and explicit `immediate` delivery; `craig command show`, `list`, `wait`, and `cancel` inspect and control durable work even after preview disablement. The heartbeat implementation now lives in the shell layer, and the daemon hosts a single-leader orchestration supervisor that wakes on mutations, reconciles missed signals and deadlines, keeps activity observation alive independently of TUI subscribers, targets a concrete task/tab without using foreground selection, and never replays an interrupted `delivering` command. Runner-aware shell encoding uses bracketed paste followed by a separately timed submit event so Codex, Cursor, and Claude do not discard a same-batch submission, while the PTY runtime exposes only a target-specific write port. A failed submit write remains delivery-uncertain and cannot be reported as delivered. Command event reconciliation repairs record/event crash gaps without recreating retained history, and journal retention preserves segments referenced by live commands. Coverage includes preview gating, JSON contracts, inline/file/stdin parsing, idempotency conflicts, unsafe bytes, hard limits, path traversal, corrupted event partial results, wait timeout/cancellation states, leader contention, busy-to-ready delivery, closed and expired targets, first- and second-write transport exceptions, uncertain restart recovery, cancellation conflicts, retained live-command events, protocol compatibility, runner-specific submission sequences, and a real-node-PTY path that accepts only a separate submit event while proving exactly one follow-up prompt reaches an unselected delegated Cursor child. The runner-submission hardening passed as part of 662 tests across 68 files via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `4.1` Verified by adding orchestration-domain capability issuance, validation, expiry, revocation, actor audit, and restrictive `0700`/`0600` workspace-local persistence; preview-enabled root and interactive agent launches receive an opaque bearer token through scoped PTY environment context while task records retain only a non-authorizing capability reference. Task records now carry normalized parent/root/depth, idempotency, and optional fury lineage without introducing orchestration or UI imports into the task domain. `craig task create-child`, `task children`, and `task cancel-tree` expose bounded child creation, durable direct-child inspection, and serialized top-down idempotent cancellation; capability targets are limited to the owning task subtree, repo targets are limited to the parent task's repo scope, and creation is capped by prompt bytes, depth, total children, and concurrent children. The TUI uses one state-owned ordering contract for both sidebar rendering and keyboard navigation, grouping every visible descendant beneath its root while flattening all delegation depths to exactly one visual child level; task dots remain scoped to each task's own agent tabs. A crash-recoverable delegation lock closes idempotency and cancellation races, partial launch failures retain a replayable draft child, capability revocation follows tree cancellation, lineage cycles fail closed, daemon- and tmux-owned agent sessions are terminated, and mutation events retain the responsible actor with partial-result errors if audit persistence fails. Review hardening denies unscoped legacy agent sessions, keeps bearer values out of tmux commands through a private launch handoff, serializes issuance against stale snapshots, revokes orphaned task-bound capabilities, and keeps sidebar grouping and tree cancellation linear. Session-ownership hardening routes CLI- and Fury-created children through a shell-owned daemon launch port: the initial prompt starts immediately in the child's durable agent tab, prompt dispatch targets that same tab while it is unselected, and later TUI navigation reattaches instead of spawning a second runner. New child creation is gated by `agentOrchestration`, while inspection and cancellation remain available after preview disablement for recovery. Coverage includes command-family permission denial, restrictive file modes, bearer/reference separation and non-exposure, missing agent capability denial, stale-snapshot issuance, orphan revocation, expiry, unrelated-target denial, descendant authorization, depth/count/concurrency limits, lineage, idempotent replay and conflict handling, partial launch failure, concurrent tree cancellation, preview gating, parser/JSON contracts, one-level child/grandchild rendering and navigation, scoped tmux and daemon PTY context, and a real-terminal delegated Cursor flow proving initial launch, unselected dispatch, and navigation all reuse one daemon process. The current automated verification passed with 662 tests across 68 files via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `5.1` Verified by adding a direct `yaml` dependency and an orchestration-domain version `1` definition contract for typed inputs, required static limits, agent steps, child-task targets, explicit output schemas, and intentional human-review checkpoints with optional feedback targets. Validation rejects duplicate keys, aliases, anchors, unknown fields, unsupported versions and runners, malformed templates, undeclared inputs and outputs, invalid or unrelated step references, missing dependencies, cycles, hybrid review/agent shapes, excessive limits, oversized definitions and prompts, deeply nested output schemas, and output paths absent from explicitly declared schema properties. The pure planning engine coerces declared inputs, rejects blank numeric values, reapplies non-empty and prompt-size constraints after input rendering, produces a normalized content hash, deterministic topological order and concurrency-bounded execution waves, and retains deferred step-output expressions and output schemas for the executor without creating task, command, run, capability, or review state. Phase `5.2` now wraps that engine in an immutable approval-plan record while `fury validate` remains read-only. The npm build aliases the dependency's ESM implementation into the standalone bundle after package smoke exposed its default CommonJS dynamic-require shim. Coverage proves valid agent/review graphs, deterministic hashes and plans, syntax hazards, invalid graphs/references/shapes/limits/inputs, rendered-value constraints, declared output-path checks, file and schema bounds, concurrency batching, preview gating, CLI parser/JSON contracts, pure-engine workspace snapshot equality, and packed `fury validate`/`fury plan` execution. Automated verification passed with 636 tests via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `5.2` Automated verification passed for a preview-gated, restart-safe Fury runtime. The former swarm naming is removed from commands, domain types, directories, environment, events, and TUI language, with read-time migration for already-persisted task lineage and event journals. Authored YAML and content-addressed definitions, immutable resolved plans, human approvals, runs, and reviews live under `.craig/fury/`. Planning is capability-scoped to the planning agent's own task; concrete task targets are bound to that task; dynamic targets are limited to prior step task ids; plan content includes resolved inputs, root task, limits, runners, and steps; unchanged plans are idempotent; only the latest unapproved revision per source/root contributes TUI attention; only a human may approve the exact hash; tampering invalidates the record; and each approved plan creates at most one run under concurrent replay. Every Fury-created task is a direct child of the planning task even when DAG steps depend sequentially, while per-step runner selection remains independent. Versioned run, step, and review records use atomic writes and a crash-recoverable lock; the orchestration supervisor heartbeat reconciles claimed dispatches, prompt failures, deadlines, disappeared agent sessions, audit-event gaps, and ready work without replaying succeeded steps. Existing-task steps use durable prompt commands, child steps use bounded delegation with Fury lineage and launch environment, declared runners must match a concrete agent tab, and every mixed-runner agent tab receives its own scoped capability. Completion and failure are explicit and schema-validated; terminal silence never succeeds a step. Durable human checkpoints support human-only approve/reject/request-changes, scoped feedback delivery, attributable decision history, feedback-target resubmission, concurrent-decision serialization, timeouts, and downstream blocking. Run/status/watch/cancel/resume and review CLI surfaces are machine-readable; event retention preserves live Fury history; and one flat TUI attention row aggregates pending plan sign-offs and runtime reviews. The first manual bug-bash attempt exposed that an agent-context development TUI could silently attach to the live workspace, replace an incompatible daemon, and persist Fury command families into schema-version-1 capability records that stable Craig rejected. Recovery preserved task and token identity while removing only the incompatible grants. Hardening now persists only stable capability families, derives Fury authority from a valid task-scoped token after the preview gate, accepts well-formed future family names without granting them, requires an explicit workspace root for agent-launched interactive Craig, fails closed on live daemon protocol mismatch, and canonicalizes internal daemon paths so packaged smoke shuts down cleanly on macOS. Coverage includes the full agent-plan/human-approve/agent-run CLI path, definitions outside `.craig/fury/`, root-target containment, unsafe dynamic targets, unchanged/revised plan behavior, plan tampering, missing approval, agent self-approval denial, pending-plan attention, concurrent approval and single-run replay, sequential mixed-runner direct-child hierarchy, claimed-dispatch recovery, duplicate-command prevention, concurrent completion, invalid output, legacy-state migration, stable-only capability persistence, forward-compatible capability reads, explicit interactive workspace selection, incompatible-daemon non-eviction, per-tab capabilities, request-changes/resubmit, concurrent review decisions, run and review timeout, event retention, preview gating, sidebar rendering, and packed approval/runtime execution and cleanup. Automated verification passed with 656 tests across 67 files via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`. Manual verification remains open for the conversational planning-agent flow, a real mixed-runner multi-task Fury run, and an intentional human-review checkpoint driven through the TUI/CLI in an isolated workspace.
- `5.3` Deferred until fixed-DAG execution has production use.
- `5.4` Deferred until limits and cancellation are proven under fixed DAGs.

### Next resume point

Resume at the Phase `5.2` manual bug bash in a new explicitly selected isolated workspace, never through implicit agent-context inheritance. First confirm that starting and stopping the development TUI leaves the live Craig workspace and daemon untouched and that stable Craig can still load its state after preview use. Before starting Fury, dispatch a basic prompt to both an available Codex tab and Cursor tab and confirm the separately submitted prompt visibly starts work rather than merely reaching the `delivered` record state. From a fresh planning task in the isolated workspace, have the agent write YAML under `.craig/fury/`, validate it, create the immutable plan, and present its resolved waves/hash for sign-off. Approve the plan as a human, let the planning agent start it, and confirm mixed-runner child tasks appear as direct siblings beneath the planning task; each child must already be working from its initial prompt, remain reachable while unselected, and open into that same conversation when selected. Exercise status/watch, request-changes/resubmit, approval, cancellation, and a Craig restart while work or review is pending; record UX or contract adjustments before marking `5.2` verified. Do not begin `5.3` retries or conditions until this approved fixed-DAG flow is accepted in use.

### Skipped and deferred work

- Phase `1.3` PR worktree import is deferred until real usage shows that machine-ready `task pr link` cannot cover the workflow without branch or worktree replacement.
- Fork-origin PR import is deferred beyond `1.3`.
- Remote/network control is out of scope.
- Agent semantic acknowledgements are optional follow-up after reliable delivery.
- Fury retries, conditions, fan-out, and recursive delegation remain deferred through `5.2`.

### Phase execution and verification policy

Each sub-phase is complete only when:

- the full vertical slice is implemented through input, shell adapter, domain service, persistence, and human/machine output as applicable
- domain result types live in their owning domain and no lower layer imports `ui/` or `commands/`
- unit and integration tests for changed contracts pass
- relevant real-terminal E2E flows are exercised when PTY boot, delivery, or attach behavior changes
- JSON fixtures or schema assertions protect machine contracts
- failures outside the sub-phase are recorded in the verification summary with scope and disposition
- a user-visible CLI change includes a `craig-cli` Changeset in its shipping PR

During implementation tuning, run focused tests first and the relevant terminal E2E whenever PTY behavior changes. Before a sub-phase is marked verified, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`; also run packaging gates when the public CLI artifact changes.

Every implementation session resumes from the first sub-phase that is not both implemented and verified. When a session implements or verifies a sub-phase, update status summary, verification summary, and next resume point together. If work intentionally skips ahead, record why and preserve the earlier resume point.

## API and data model changes

The public API introduced by this RFC is the CLI, its exit codes, JSON/JSONL envelopes, event cursors, YAML schema, and persisted workspace records. There is no network API.

Task records gain optional, backward-compatible fields:

```ts
interface TaskRecord {
  worktreeOwnership?: "craig" | "external";
  taskOrigin?: { type: "created" } | {
    type: "pull_request";
    provider: "github";
    owner: string;
    repo: string;
    number: number;
  };
  parentTaskId?: string | null;
  rootTaskId?: string;
  delegationDepth?: number;
  furyRunId?: string | null;
  furyStepId?: string | null;
}
```

Existing records read as `worktreeOwnership: "craig"`, `taskOrigin: { type: "created" }`, no parent, self as root, and depth zero. Validation accepts missing fields for compatibility; the next task mutation writes the normalized shape. No bulk migration is required.

`CraigPaths` gains `commandsDir`, `eventsDir`, and `orchestrationDir`. `CraigConfig` gains the `agentOrchestration` preview plus bounded orchestration settings. New command and event result types live in `domain/orchestration/types.ts`; PR association/import results remain in `domain/task/types.ts`.

Daemon protocol additions are internal, versioned transport contracts. A client may reuse a compatible live daemon, but an incompatible live daemon fails closed and is never shut down or replaced implicitly. Persisted schemas and the public JSON envelope are versioned independently from the daemon protocol.

## Edge cases and failure modes

- Missing `gh` authentication fails before PR mutation and returns a retryable external-dependency error.
- A PR number without repo context fails as ambiguous; Craig never guesses across project targets.
- Branch or repository mismatch returns a conflict and leaves task state unchanged.
- A task may retain terminal PR history while linking a later active PR.
- Concurrent CLI, TUI, and heartbeat writes are serialized and use compare-after-lock semantics.
- A killed process after command persistence but before event append is repaired by reconciliation.
- A killed process after PTY delivery but before `delivered` persistence may cause uncertain delivery. The command becomes `failed` with `deliveryUncertain: true` and is never automatically replayed.
- Event watchers detect cursor expiration after retention and return the earliest available cursor.
- Daemon absence reports agents as `idle` only when no durable failure exists; known failed startup remains `error`.
- A target tab closed while a prompt is queued fails the command without selecting another tab implicitly.
- Cancellation races resolve through terminal-state idempotency; success already persisted wins over later cancellation.
- Importing an externally owned worktree never grants Craig cleanup ownership.
- Repeating `fury run` for the same approved plan returns the original run and cannot create a second task tree.
- Invalid YAML, unknown fields, cycles, missing references, excessive limits, unresolved templates, definitions outside `.craig/fury/`, and concrete task targets outside the planning task fail before approval or execution.
- Editing a plan record, resolved input, runner, root task, limit, or step invalidates its content hash and blocks approval/run.
- A Fury restart resumes from durable run and command state; it does not re-run succeeded steps.
- A restart preserves pending human review, its deadline, review round, decision history, and blocked downstream steps.
- Review mutations require the expected record version and use compare-after-lock semantics. The first valid write wins; stale concurrent decisions return a conflict, and approve/reject are terminal.
- Requesting changes without a configured feedback target returns a conflict and leaves the review waiting. If a configured target becomes unavailable after the decision is persisted, the review remains `changes_requested`, records the delivery failure, and requires human intervention; it never releases downstream work.
- A feedback target that completes revisions cannot approve the gate. It may only resubmit it for another human decision.
- A step timeout cancels its queued command and child task according to policy, but cannot claim a PTY process stopped until runtime termination is confirmed.
- Structured output that fails its declared schema fails the step with the validation details.

## Security and privacy

- All control remains local to the user account and workspace.
- Capability files use restrictive filesystem permissions and contain opaque random values.
- Base capability records persist only stable delegation families. Fury authorization is derived from the same valid task-scoped token under each command's preview and durable-recovery policy and never makes the record unreadable to stable Craig.
- Agent capabilities default to the current task and its children; cross-task prompt injection is opt-in.
- Agent capabilities never include human-review approve, reject, or request-changes permissions. A feedback-target capability may only read and resubmit its assigned review.
- Agent capabilities may create a plan only for their own task and may run it only after a separate human approval. Agents cannot approve Fury plans.
- Human review mutations require an interactive human CLI/TUI context without an agent capability. This is a workflow boundary, not a hard security boundary against a malicious process with unrestricted access to the same OS user and workspace.
- `--json` changes review-command output but does not waive the interactive human-context check. Non-interactive and remote approvals are out of scope.
- Prompt size, event payload size, output size, task count, depth, concurrency, and runtime duration have hard limits.
- Control characters are rejected or encoded by runner-specific prompt delivery.
- YAML cannot execute shell commands, read arbitrary environment variables, or reference undeclared files.
- `--prompt-file` and `--output-file` resolve explicitly supplied paths; fury templates cannot perform path traversal.
- Capability values, environment secrets, raw terminal buffers, and full prompts are excluded from event payloads by default.
- Human-readable audit history records actor, target, command type, timestamps, and disposition.
- PR link/import always verifies GitHub state through authenticated tooling rather than trusting caller-provided metadata.
- Imported external worktrees are never deleted by Craig.

## Observability

- Every durable mutation has a command id or event id and actor.
- JSON errors expose stable codes, retryability, and safe details.
- `craig events watch` is the canonical diagnostic stream for orchestration.
- `craig command show` explains delivery attempts and the last safe error.
- `fury.plan.created` and `fury.plan.approved` events record the exact plan id/hash, planning task, and attributable actor.
- `craig fury status` reports each step, dependency blockers, target task, command id, timestamps, and output-validation state.
- Human review emits `fury.review.requested`, `fury.review.changes_requested`, `fury.review.resubmitted`, `fury.review.approved`, `fury.review.rejected`, `fury.review.timed_out`, and `fury.review.cancelled` with review id, round, actor, and safe reason metadata.
- The TUI surfaces pending plan sign-offs and waiting reviews through one flat Fury attention state; it does not add nested navigation or disguise an approval gate as agent failure or completion.
- Heartbeat reconciliation logs job id, scanned count, repaired count, duration, and failures without logging prompt bodies.
- Event journal corruption, cursor expiration, uncertain prompt delivery, capability denial, and orphaned runtime sessions are surfaced as explicit events and error log entries.

## Rollout plan

- `1.1` and `1.2` are additive stable CLI capabilities and should ship without a feature preview once their machine contracts are tested.
- `1.3` ships as an explicit command with same-repository limitations documented; it does not alter normal task creation.
- `2.1` keeps the TUI dots behind the existing `agentActivityIndicators` preview. The additive read-only CLI commands ship stable because the TUI and CLI now derive their states from the same domain contract.
- `2.2`, `3.1`, `4.1`, and `5.x` are gated by a new `agentOrchestration` feature preview during initial use.
- Read-only validation, status, and event inspection may be enabled before mutating Fury execution. Planning persists only an immutable approval request and cannot create tasks, commands, or runs.
- Preview disablement stops new dispatch/run creation but does not abandon existing durable commands or runs; Craig continues status, cancellation, and safe reconciliation.
- Interactive Craig launched from agent context requires an explicit workspace root, preventing a development TUI from silently attaching to live state; an explicit different directory provides an isolated test workspace.
- The daemon supervisor is introduced dormant: it performs no orchestration work until the preview is enabled or unfinished durable work already exists.
- Each shipping sub-phase gets its own `craig-cli` Changeset and PR so value is collected independently.
- Promotion out of preview requires no unresolved uncertain-delivery bug, restart recovery tests, capability denial tests, human-review authorization and recovery tests, and successful real use across multiple tasks.

## Plan Mode handoff checklist and acceptance criteria

### 1.1 Handoff

#### Implementation

- replace ad hoc argv matching with a parser that supports global options consistently
- add JSON success/error envelopes, stable error codes, and exit-code mapping
- implement workspace and task context resolution with the documented precedence
- add `context show`, `task current`, and optional-context `task show`
- keep result types in task/workspace/config domains as owned

#### Verification

- cover flag order, no-input behavior, every exit-code category, and stdout/stderr separation
- cover explicit, environment, ancestor, Git-worktree, missing, and ambiguous context
- run standard gates and package smoke for the public CLI

#### Tracking update

- keep `1.1` open if automation must parse human tables or UI selection affects CLI targeting
- record any context topology not supported by the documented precedence

### 1.2 Handoff

#### Implementation

- add task-domain PR association services and result types
- expose show/discover/link/refresh/unlink for repo and project tasks
- add verified repository/branch matching, idempotency, locking, and artifact updates
- preserve sequential PR history and re-derive task status after mutations

#### Verification

- cover URL and numeric selectors, project ambiguity, mismatch rejection, duplicates, unlink, and concurrent writes
- use GitHub adapter fakes for domain tests and retain an authenticated manual smoke checklist
- run standard gates and package smoke

#### Tracking update

- keep `1.2` open if a missed association still requires editing task JSON
- record GitHub cases intentionally unsupported

### 1.3 Handoff

#### Implementation

- add same-repository PR import with task origin and worktree ownership metadata
- reuse or create the PR head worktree without creating an unrelated task branch
- make cleanup ownership-aware and runner launch recoverable
- reject fork-origin imports with an actionable error

#### Verification

- cover Craig-owned and external worktrees, duplicate import, branch-already-checked-out, launch failure, cleanup, and fork rejection
- add a real Git/worktree integration test and preserve terminal launcher harness coverage
- run standard and packaging gates

#### Tracking update

- keep `1.3` open if imported tasks cannot safely commit/push on the PR head or Craig can remove an external worktree

### 2.1 Handoff

#### Implementation

- move agent runtime types and state derivation behind a domain-owned contract
- implement a shell adapter for daemon snapshots without importing UI into domain
- expose agent list/status and race-free task wait
- keep TUI dots behaviorally identical

#### Verification

- cover all four states, task roll-up, daemon loss, successful/non-zero exit, timeout, and cancellation
- verify preview-off behavior and TUI regression coverage
- run terminal E2E if daemon protocol or PTY startup changes

#### Tracking update

- keep `2.1` open if CLI and sidebar can disagree for the same snapshot

### 2.2 Handoff

#### Implementation

- add locked append-only event storage, cursors, rotation, retention, and corruption handling
- emit coalesced semantic task, PR, and agent events
- expose event list/watch with filters and resumable JSONL
- add reconciliation for persist/event gaps

#### Verification

- cover concurrent append, monotonic sequence, replay, filter, reconnect, rotation, truncated tail, corruption, and cursor expiration
- manually verify watch reconnect during real agent state changes

#### Tracking update

- keep `2.2` open if watchers can miss a transition between initial read and subscription

### 3.1 Handoff

#### Implementation

- add durable prompt command records, idempotency, inspection, wait, and cancellation
- move the heartbeat implementation to the shell layer and add the daemon-hosted single-leader orchestration supervisor
- extend daemon transport with target-specific safe prompt delivery
- implement `when-ready` and authorized `immediate` delivery
- reconcile restart-safe queued commands and uncertain delivery

#### Verification

- cover duplicate requests, leader contention, wrong/closed tab, busy-to-ready transition, daemon restart, cancellation races, unsafe bytes, timeout, and uncertain delivery
- add a real-terminal E2E using a stub agent that proves exactly one prompt reaches the requested task/tab

#### Tracking update

- keep `3.1` open if delivery depends on the foreground-selected tab or can silently replay an uncertain prompt

### 4.1 Handoff

#### Implementation

- add capability issuance/validation/revocation and actor audit fields
- persist task lineage and delegation limits
- expose child create/list and tree cancellation
- propagate scoped environment context to Craig-launched agents

#### Verification

- cover permissions, expiry, revocation, max depth/count/concurrency, lineage, idempotency, partial launch failure, and cancellation races
- verify a child cannot target an unrelated task without capability

#### Tracking update

- keep `4.1` open if an agent can create unbounded work or erase lineage

### 5.1 Handoff

#### Implementation

- add a direct YAML parser dependency and strict versioned schema
- implement validate and side-effect-free plan
- validate DAG, references, limits, templates, human-review shapes, feedback targets, and unknown fields
- persist immutable normalized definitions by content hash only when a run starts

#### Verification

- cover valid examples, syntax errors, unknown fields, cycles, missing dependencies, invalid references, invalid human-review/agent hybrid steps, invalid feedback targets, excessive limits, and proof that plan makes no mutations

#### Tracking update

- keep `5.1` open if invalid definitions can create tasks or command records

### 5.2 Handoff

#### Implementation

- use Fury consistently in the CLI, domain, persistence, events, environment, and TUI language
- store authored definitions and durable plan/approval/run state under `.craig/fury/`
- bind each immutable resolved plan to its planning task and require attributable human approval of the exact plan hash before run creation
- make approved plans single-run and create every Fury child directly beneath the planning task regardless of DAG dependency depth
- persist fury runs and fixed-DAG step state
- schedule ready steps within limits through child creation and prompt dispatch
- add explicit schema-validated step complete/fail
- persist human review checkpoints and decision history, including approve, reject, request-changes, feedback delivery, and resubmit
- expose review list/show/actions in the CLI and a TUI attention surface for waiting checkpoints
- block downstream steps until human approval and report `waiting_for_review` at the run level when appropriate
- implement watch, status, cancel, resume, timeouts, and heartbeat reconciliation

#### Verification

- cover definitions outside `.craig/fury/`, unrelated root targets, plan tampering, missing approval, agent self-approval denial, concurrent approval/run, and single-run replay
- prove sequentially dependent `create_child` steps remain direct siblings beneath the planning task
- cover dependency ordering, parallel limits, success/failure/cancel/timeout, output validation, restart at every transition boundary, and no replay of succeeded steps
- cover approve/reject/request-changes/resubmit, feedback delivery failure, human-versus-agent authorization, concurrent decisions, review timeout, restart while waiting, and downstream blocking
- run a real multi-task fury with stub agents and then one manual Codex fury containing at least one human review checkpoint

#### Tracking update

- keep `5.2` open if terminal silence is treated as success, restart can duplicate a step, a plan can run without exact human sign-off, or downstream work can bypass an unapproved human checkpoint
- keep `5.2` open if a feedback-target agent can approve/reject its own review or review history is not durable and attributable
- leave retries, conditions, fan-out, and recursive delegation deferred unless separately approved

### Acceptance criteria

- `[1.1]` An agent can determine its workspace, task, and tab context and consume stable JSON without reading UI state or human-formatted output.
- `[1.2]` A user or agent can repair a missing PR association through supported idempotent CLI commands without editing `.craig` files.
- `[1.3]` A same-repository existing PR can become a safe Craig task on its real head branch, with cleanup ownership preserved.
- `[2.1]` CLI and TUI expose the same idle, working, ready, and error states for each agent tab and task roll-up.
- `[2.2]` Consumers can resume a filtered event stream from a cursor without a read/subscribe race.
- `[3.1]` A prompt can be durably and exactly targeted to another task's agent tab, inspected, waited on, and cancelled without relying on foreground selection.
- `[4.1]` An agent can create bounded child work with durable lineage while capabilities prevent unrelated or unbounded mutations.
- `[5.1]` A Fury YAML file, including human review gates and feedback targets, can be validated and resolved without creating tasks, commands, runs, capabilities, or reviews.
- `[5.2]` A bounded fixed DAG can execute, report structured outputs, cancel, and recover from restart without inferring success from terminal silence or duplicating completed work.
- `[5.2]` A fury can pause at a durable human review checkpoint, route requested changes back to a declared agent target, and release downstream work only after an attributable human approval.
