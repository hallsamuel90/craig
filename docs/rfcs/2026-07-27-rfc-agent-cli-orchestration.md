# RFC: Agent CLI Control Plane and Declarative Orchestration

- **Date:** 2026-07-27
- **Status:** In Flight
- **Author:** Sam / Codex
- **Amends:** 2026-05-01-rfc-craig-terminal-workspace-rewrite.md

---

## Context and goals

Craig already owns durable task records, worktrees, runner PTYs, GitHub pull-request metadata, a PTY daemon, a UI heartbeat, and agent activity indicators. These pieces are useful but are not yet a control plane:

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

### Starting a Fury from the current conversation

A primary entry point is an existing Craig-managed agent thread: after discussing or working on a task, the user asks that agent to spin off a Fury for a bounded goal. The current task becomes the planning/root task. The user does not need to create a fresh planning task, switch conversations, or author YAML manually.

The current agent must:

1. Turn the conversational goal into a bounded DAG, explicitly carrying relevant decisions, constraints, source references, and expected outputs into the definition's inputs and worker prompts. New workers do not automatically inherit the parent conversation transcript.
2. Resolve the existing workspace/task context through Craig's machine contract, author a new definition under that workspace's `.craig/fury/`, then invoke `fury validate` and `fury plan --json`. Omitted `--root-task` resolves to the current task; an agent cannot choose an unrelated root.
3. Present the resolved scope, runners, limits, dependencies, review gates, plan id, and exact hash for human sign-off. Creating/planning a Fury does not launch workers, and an agent cannot approve its own plan.
4. After the human approval is persisted through Craig, invoke `fury run <plan-id> --json` from the same conversation. The daemon starts the workflow and every created worker is a direct child of that current task. The parent agent can inspect and report progress through status/watch without becoming the workflow's runtime owner.

“Create a Fury” describes this user intent; the current CLI realizes it through definition authoring, validation, immutable planning, human approval, and run creation. A separate `fury create` command is not required by this contract. Context captured from the conversation must be sufficient for independent workers; merely naming the discussion or depending on its unsaved chat history is insufficient.

This flow also applies when the current task already owns another Fury: each distinct approved plan has its own single-run identity, and all existing capability and delegation limits continue to apply. Starting from an arbitrary external chat without Craig task/capability context is outside this entry point and requires an explicit workspace/task attachment.

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
craig task create-child --parent <task-id> [--repo <repo-id> | --workspace <workspace-id>] \
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
    create_child: {}
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
- `2.1` Extract domain-owned agent status and expose list/status/wait: `implemented, verified, and graduated to stable default TUI behavior`
- `2.2` Add the durable event journal and event list/watch: `implemented, live TUI invalidation hardened, and verified`
- `3.1` Add durable, target-specific prompt dispatch and command inspection/wait/cancel: `implemented, review-hardened, runner-submission, supervisor-wake, and daemon-only launch hardened, and verified`
- `4.1` Add capability-scoped parent/child delegation and tree cancellation: `implemented, project-scope, linked-repo, durable-startup, and daemon-only launch hardened, and verified`
- `5.1` Add fury YAML parsing, validation, and dry-run planning: `implemented, review-hardened, and verified`
- `5.2` Execute and recover an approved Fury DAG with structured completion and intentional human review gates: `implemented; daemon-owned scheduling, sandbox-compatible notification, output draining, preview-off recovery, cleanup retry, rejected-review cleanup notification, latest-main compatibility, and startup-dialog hardening verified; real three-child Codex/review workflow succeeded; mixed-runner and project acceptance remain open`
- `5.3` Add guarded retry policies and conditional steps: `deferred`
- `5.4` Add bounded `foreach` fan-out and dynamic delegation: `deferred`

### Verification summary

- `2026-10-28` PR regression review integrated current `main`, resolved concurrent daemon-test additions by preserving both regressions, and passed all seven release gates plus the site build with **766 tests across 68 files**. Added rejected-review unavailable-supervisor coverage and verified disabled-preview loading ignores pending plans. Shared-path coverage includes real-process output draining, selected-task PTY attachment, direct new-task launch, runner startup guards, and daemon restart recovery. Both `craig-cli` Changesets remain `patch`; the preview stays enabled only by explicit opt-in.
- `2026-10-28` Hardening passed all seven release gates: `pnpm test` (748 tests across 67 files), `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`. The original three-child real-Codex graph completed all five steps, including request-changes/resubmit/approve and a final brief. A separate native macOS sandbox with all network access denied submitted a run and cancellation successfully through the fresh-leader polling fallback. See the dated evidence below; Phase `5.2` remains open for mixed-runner/project acceptance.
- `2026-10-26` Isolated real-agent bug bash found and fixed a daemon wake/delegation circular wait. The new daemon-backed Fury-child regression fails on the original behavior and passes with asynchronous wake acknowledgement. All seven release gates passed: `pnpm test` (734 tests across 66 files), `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`. See the bug-bash evidence below; Phase `5.2` remains open.
- Current daemon-only task launch, durable child startup, supervisor wake, sandbox-compatible scheduling/notification, linked-project-repo targeting, live TUI invalidation, and legacy-record migration hardening passed with 766 tests across 68 files via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `1.1` Verified by replacing ad hoc argv matching with a structured parser for order-independent global options; adding versioned JSON success/error envelopes, an authoritative error-code-to-exit-code mapping, non-interactive guards, and stable exit categories; resolving workspace context through explicit flags, environment, ancestors, and Git common-worktree discovery; resolving task and agent-tab context through explicit flags, environment, and task filesystem topology without UI selection; exposing `context show`, `task current`, and optional-context `task show`; and propagating Craig identity into task PTYs. Coverage includes every pre-existing parser command with global options before and after the command, flag separators, stdout/stderr isolation, no-input behavior, optional-context task-show execution, task/repo/workspace not-found exits, corrupt-record classification, precedence, missing/invalid/ambiguous/conflicting context, macOS canonical path aliases, project task bundles and repo targets, ambient-context isolation, and packed-artifact JSON success and failure execution. Automated verification passed with 515 tests via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `1.2` Verified by adding task-domain `show`, `discover`, `link`, `refresh`, and `unlink` association services and matching `craig task pr` commands; accepting numeric and GitHub URL selectors; resolving repo-task and explicit or URL-inferred project targets; fetching before link; rejecting repository, branch, and task-target mismatches with stable PR-specific conflict codes; preserving sequential repo-qualified PR history; keeping project target mirrors and PR status artifacts synchronized; re-deriving task status after mutations; and serializing PR, heartbeat, lifecycle, check, commit, cleanup, link, and UI task persistence through the same crash-recoverable task-scoped workspace lock. Review hardening also made unlink independent of a live local Git remote, promotes the preceding project PR when the active association is removed, and emits warnings only once at the stable JSON envelope level. Coverage includes invalid and duplicate options, global and positional task context, stable JSON envelopes and warnings, URL and numeric selectors, no-result discovery, idempotent duplicate link and unlink, offline unlink, active-PR replacement warnings and rollback, project ambiguity, repository and branch mismatch rejection, same-number PRs in different project repositories, concurrent CLI links, concurrent heartbeat/CLI and ordinary task/CLI persistence, stale-lock recovery, and exit `7` partial-result reporting when the task persists but its artifact write fails. Automated verification passed with 536 tests via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`. An authenticated disposable-workspace smoke against GitHub PR `hallsamuel90/craig#176` verified packed `link`, `show`, `refresh`, and numeric `unlink` JSON flows without modifying a real Craig task.
- `1.3` Deferred after confirming the Phase `1.2` machine-ready `task pr link` flow already addresses the current association-repair use case. Revisit only if real usage demonstrates that linking must safely replace a task branch or worktree.
- `2.1` Verified by moving PTY activity snapshots and the `idle | working | ready | error` derivation into a domain-owned agent contract; keeping animation presentation in the UI; adding a shell-owned daemon protocol and activity adapter that observes, reconciles, and reconnects to the existing daemon without starting it as a read side effect; and exposing `agent list`, `agent status`, and `task wait` with versioned JSON results, global task filtering, per-tab selection, task roll-ups, duration parsing, timeout exit `6`, and distinct machine-readable `SIGINT` cancellation. The CLI and sidebar now call the same state and priority functions. Coverage includes all four states, multiple-agent task roll-up, ignored terminal tabs, correctly scoped durable startup failure, successful and non-zero exits, absent daemon behavior with preview disabled, workspace-wide listing from inside a task worktree, missing or cross-task tabs, subscription-before-snapshot race prevention, the shell-owned daemon client's snapshot and connection-loss behavior, timeout, cancellation, and parser/JSON contracts. The stable graduation removed the TUI preview toggle and makes activity subscriptions, roll-ups, and animation active by default while accepting the retired `previews.agentActivityIndicators` key as a no-op for workspace compatibility. Graduation verification passed with 666 tests across 66 files via `pnpm test`, including the PTY daemon and real-terminal E2E suites, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `2.2` Verified by adding a generic domain-owned, workspace-scoped event contract and fsynced append-only JSONL segments under `.craig/events/`; serializing appenders with a crash-recoverable workspace lock; enforcing monotonic sequences, record limits, sensitive-field redaction, deterministic idempotency, atomic rotation, bounded segment retention, replay by sequence or event id, glob/task filters, cursor expiration details, truncated-active-tail repair, and hard failure for all other corruption. A shell reconciler emits coalesced `task.created | updated | closed`, `task.pr.linked | unlinked | refreshed`, and `agent.state.changed` transitions, using a compact atomic checkpoint to prevent retained-history rotation from manufacturing duplicate lifecycle events while deterministic ids repair append/checkpoint crash gaps. The daemon now treats coalesced task lifecycle events as client invalidations independently of PR synchronization, broadcasts affected task IDs through the existing workspace socket, and lets connected TUIs reload only those records and rerender agent-created children without user input. `events list` returns versioned JSON envelopes; `events watch` supports resumable human or JSONL streams without a read/subscribe race; and preview-enabled `task wait` advances the same cursor while retaining its stable Phase `2.1` contract when the preview is disabled. The new `agentOrchestration` preview gates event commands, while stable daemon lifecycle reconciliation continues to drive internal invalidation. Coverage includes concurrent append, sequence monotonicity, idempotency, replay, filtering, rotation, retention, redaction, sequence and event-id expiration, truncated-tail recovery, corruption, concurrent reconciliation, checkpoint survival across retention, semantic task/PR/agent transitions, coalesced lifecycle invalidation, connected-daemon notification, targeted TUI child insertion, preview gating, parser/JSON/JSONL contracts, cursor-backed wait, and a real daemon-backed watch through working, connection-loss error, daemon restart, and working-again transitions. Full gate results are recorded with the current hardening change.
- `3.1` Verified by adding domain-owned, versioned prompt command records under `.craig/commands/` with crash-safe atomic persistence, a workspace command lock, bounded prompt/idempotency/timeout validation, path-safe identifiers, idempotent creation, explicit state transitions, queued-only cancellation, stable not-found/invalid/conflict errors, and partial-result reporting when durable mutation succeeds but event append fails. `craig agent send` accepts inline, file, or stdin prompts with default `when-ready` and explicit `immediate` delivery; `craig command show`, `list`, `wait`, and `cancel` inspect and control durable work even after preview disablement. The heartbeat implementation now lives in the shell layer, and the daemon hosts a single-leader orchestration supervisor that wakes on mutations, reconciles missed signals and deadlines, keeps activity observation alive independently of TUI subscribers, targets a concrete task/tab without using foreground selection, and never replays an interrupted `delivering` command. Supervisor startup is serialized across concurrent wake requests, startup success/failure is logged, and a failed wake now transitions a persisted command to an explicit retryable `ORCHESTRATION_UNAVAILABLE` failure instead of silently leaving `attempts: 0`. Runner-aware shell encoding uses bracketed paste followed by a separately timed submit event so Codex, Cursor, and Claude do not discard a same-batch submission, while the PTY runtime exposes only a target-specific write port. A failed submit write remains delivery-uncertain and cannot be reported as delivered. Command event reconciliation repairs record/event crash gaps without recreating retained history, and journal retention preserves segments referenced by live commands. Coverage includes preview gating, JSON contracts, inline/file/stdin parsing, idempotency conflicts, unsafe bytes, hard limits, path traversal, corrupted event partial results, unavailable-supervisor persistence, wait timeout/cancellation states, leader contention, concurrent supervisor wake, busy-to-ready delivery, closed and expired targets, first- and second-write transport exceptions, uncertain restart recovery, cancellation conflicts, retained live-command events, protocol compatibility, runner-specific submission sequences, four concurrent initial commands, and a real-node-PTY path that accepts only a separate submit event while proving exactly one initial and one follow-up prompt reach an unselected delegated Cursor child. Full gate results are recorded with this hardening change.
- `4.1` Verified by adding orchestration-domain capability issuance, validation, expiry, revocation, actor audit, and restrictive `0700`/`0600` workspace-local persistence; preview-enabled root and interactive agent launches receive an opaque bearer token through scoped PTY environment context while task records retain only a non-authorizing capability reference. Task records now carry normalized parent/root/depth, idempotency, and optional fury lineage without introducing orchestration or UI imports into the task domain. `craig task create-child`, `task children`, and `task cancel-tree` expose bounded child creation, durable direct-child inspection, and serialized top-down idempotent cancellation; capability targets are limited to the owning task subtree, repo targets are limited to the parent task's repo scope, and creation is capped by prompt bytes, depth, total children, and concurrent children. Child targets may inherit their parent, select the same project workspace, or select an allowed repo; project-level children no longer require a standalone repo workspace, and explicitly linked repo children remain owned by the project workspace even when that repo was registered after project discovery. The TUI uses one state-owned ordering contract for both sidebar rendering and keyboard navigation, grouping every visible descendant beneath its root while flattening all delegation depths to exactly one visual child level, including legacy cross-workspace lineage; task dots remain scoped to each task's own agent tabs. A crash-recoverable delegation lock closes idempotency and cancellation races, partial launch failures retain a replayable draft child, capability revocation follows tree cancellation, lineage cycles fail closed, daemon-owned agent sessions are terminated, and mutation events retain the responsible actor with partial-result errors if audit persistence fails. Review hardening denies unscoped legacy agent sessions, passes bearer values only through a private daemon environment handoff, serializes issuance against stale snapshots, revokes orphaned task-bound capabilities, and keeps sidebar grouping and tree cancellation linear. Session-ownership hardening routes root, CLI-, and Fury-created tasks through a shell-owned daemon launch port. Delegated and Fury child runners now start without embedding work in process argv; their initial prompt is a durable `when-ready` command, and the task remains draft with a starting runner until the supervisor records an actual submission attempt. Successful submission promotes the task to running, while timeout, target loss, or uncertain delivery persists an actionable startup failure. Follow-up dispatch targets that same tab while it is unselected, and later TUI navigation reattaches instead of spawning a second runner. Interactive task creation reloads its canonical capability-bearing task before opening the initial PTY, preventing a newly created first agent tab from launching without delegation authority. The legacy tmux adapters and session schema were removed while read-time task normalization strips supported legacy fields. New child creation is gated by `agentOrchestration`, while inspection and cancellation remain available after preview disablement for recovery. Coverage includes command-family permission denial, restrictive file modes, bearer/reference separation and non-exposure, missing agent capability denial, stale-snapshot issuance, orphan revocation, expiry, unrelated-target denial, descendant authorization, discovered and newly linked project repo targets, project-owned repo provisioning, four concurrent Cursor-style initial submissions, depth/count/concurrency limits, lineage, idempotent replay and conflict handling, partial launch failure, concurrent tree cancellation, preview gating, parser/JSON contracts, one-level child/grandchild and legacy cross-workspace rendering and navigation, initial interactive-agent capability propagation, scoped daemon PTY context, legacy task migration, and a real-terminal delegated Cursor flow proving durable initial launch, unselected follow-up dispatch, and navigation all reuse one daemon process. Full gate results are recorded with this hardening change.
- `5.1` Verified by adding a direct `yaml` dependency and an orchestration-domain version `1` definition contract for typed inputs, required static limits, agent steps, child-task targets, explicit output schemas, and intentional human-review checkpoints with optional feedback targets. Validation rejects duplicate keys, aliases, anchors, unknown fields, unsupported versions and runners, malformed templates, undeclared inputs and outputs, invalid or unrelated step references, missing dependencies, cycles, hybrid review/agent shapes, excessive limits, oversized definitions and prompts, deeply nested output schemas, and output paths absent from explicitly declared schema properties. The pure planning engine coerces declared inputs, rejects blank numeric values, reapplies non-empty and prompt-size constraints after input rendering, produces a normalized content hash, deterministic topological order and concurrency-bounded execution waves, and retains deferred step-output expressions and output schemas for the executor without creating task, command, run, capability, or review state. Phase `5.2` now wraps that engine in an immutable approval-plan record while `fury validate` remains read-only. The npm build aliases the dependency's ESM implementation into the standalone bundle after package smoke exposed its default CommonJS dynamic-require shim. Coverage proves valid agent/review graphs, deterministic hashes and plans, syntax hazards, invalid graphs/references/shapes/limits/inputs, rendered-value constraints, declared output-path checks, file and schema bounds, concurrency batching, preview gating, CLI parser/JSON contracts, pure-engine workspace snapshot equality, and packed `fury validate`/`fury plan` execution. Automated verification passed with 636 tests via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `5.2` Automated verification passed for a preview-gated, restart-safe Fury runtime. The former swarm naming is removed from commands, domain types, directories, environment, events, and TUI language, with read-time migration for already-persisted task lineage and event journals. Authored YAML and content-addressed definitions, immutable resolved plans, human approvals, runs, and reviews live under `.craig/fury/`. Planning is capability-scoped to the planning agent's own task; concrete task targets are bound to that task; dynamic targets are limited to prior step task ids; plan content includes resolved inputs, root task, limits, runners, and steps; unchanged plans are idempotent; only the latest unapproved revision per source/root contributes TUI attention; only a human may approve the exact hash; tampering invalidates the record; and each approved plan creates at most one run under concurrent replay. Every Fury-created task is a direct child of the planning task even when DAG steps depend sequentially, while per-step runner selection remains independent. Versioned run, step, and review records use atomic writes and a crash-recoverable lock; the orchestration supervisor heartbeat reconciles claimed dispatches, prompt failures, deadlines, disappeared agent sessions, audit-event gaps, and ready work without replaying succeeded steps. Existing-task steps use durable prompt commands, child steps use bounded delegation with Fury lineage and launch environment, declared runners must match a concrete agent tab, and every mixed-runner agent tab receives its own scoped capability. Completion and failure are explicit and schema-validated; terminal silence never succeeds a step. Durable human checkpoints support human-only approve/reject/request-changes, scoped feedback delivery, attributable decision history, feedback-target resubmission, concurrent-decision serialization, timeouts, and downstream blocking. Run/status/watch/cancel/resume and review CLI surfaces are machine-readable; event retention preserves live Fury history; and one flat TUI attention row aggregates pending plan sign-offs and runtime reviews. The first manual bug-bash attempt exposed that an agent-context development TUI could silently attach to the live workspace, replace an incompatible daemon, and persist Fury command families into schema-version-1 capability records that stable Craig rejected. Recovery preserved task and token identity while removing only the incompatible grants. Hardening now persists only stable capability families, derives Fury authority from a valid task-scoped token after the preview gate, accepts well-formed future family names without granting them, requires an explicit workspace root for agent-launched interactive Craig, fails closed on live daemon protocol mismatch, and canonicalizes internal daemon paths so packaged smoke shuts down cleanly on macOS. Coverage includes the full agent-plan/human-approve/agent-run CLI path, definitions outside `.craig/fury/`, root-target containment, unsafe dynamic targets, unchanged/revised plan behavior, plan tampering, missing approval, agent self-approval denial, pending-plan attention, concurrent approval and single-run replay, sequential mixed-runner direct-child hierarchy, claimed-dispatch recovery, duplicate-command prevention, concurrent completion, invalid output, legacy-state migration, stable-only capability persistence, forward-compatible capability reads, explicit interactive workspace selection, incompatible-daemon non-eviction, per-tab capabilities, request-changes/resubmit, concurrent review decisions, run and review timeout, event retention, preview gating, sidebar rendering, and packed approval/runtime execution and cleanup. Automated verification passed with 656 tests across 67 files via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`. The dated bug bash below adds conversational planning, real Codex multi-task execution, and a TUI/CLI human-review loop in an isolated workspace. Mixed-runner execution, project-target cases, and the recorded failure modes still prevent full Phase `5.2` acceptance.
- `5.3` Deferred until fixed-DAG execution has production use.
- `5.4` Deferred until limits and cancellation are proven under fixed DAGs.

### 2026-10-26 isolated real-agent bug bash

The test used a disposable local Git repository containing `library.js`, `library.test.js`, a README, and fixture instructions. It used the bundled development CLI and daemon with explicit workspace selection and cleared inherited `CRAIG_*` context. Codex ran interactively in real daemon-owned PTYs with workspace-write permissions; an additional writable directory covered only the disposable workspace. The test harness exercised human-role approval commands in this isolated fixture; the workers performed actual model-driven inspection, completion, and resubmission. No external publishing or messaging was performed. Fixture source remained unchanged after the completed run. The isolated daemon was stopped after testing, retaining records for inspection.

#### Setup and observed workflow

1. Enable `agentOrchestration` in the isolated workspace and launch a fresh planning task. Supply the Fury contract and ask the agent to author, validate, and plan a workflow under the workspace's `.craig/fury/` directory.
2. The actual planning agent produced a valid immutable plan. A run before approval was rejected with `FURY_APPROVAL_REQUIRED`; repeating an approved run returned the same run with `created: false`.
3. Run two independent Codex children inspecting implementation and tests, each returning a declared `findings: string[]` output. Pass both outputs through templates to a synthesis step. Pause at a human review with a feedback target; leave a final brief step dependent on approval.
4. Request changes, including the review id and explicit resubmission command in the feedback. The synthesis worker printed a revised brief and resubmitted using its scoped agent identity. The final step remained pending through request-changes and resubmission. A harness-issued human approval released it, and the worker printed `FINAL_BRIEF` and explicitly completed the run.
5. Because downstream child creation failed inside the completing worker's sandbox, the successful variant reused the test child for synthesis and the final brief. This is a valid existing-target graph, not proof that a three-child graph works.

| Check | Observed result |
| --- | --- |
| Agent authors YAML, validates, and plans | Passed after resolving the development CLI in its shell |
| Approval required; approved plan replay is single-run | Passed |
| Parallel children visibly process initial prompts | Passed after the wake fix; initial commands delivered with one attempt |
| Structured outputs and dependent prompt interpolation | Passed; workers identified actual fixture behavior and missing coverage |
| Review, feedback, agent resubmission, human approval, final completion | Passed for run `fury_831d5949-2e5c-469a-b35a-ad8a93aef707`; all five steps succeeded |
| Direct-child lineage | Both children remained direct children of the planning task |
| TUI approval attention and client exit | Approval attention rendered in a real terminal; exiting the client left the daemon and pending run intact |
| Invalid output rejection | `FURY_OUTPUT_INVALID`, exit 4; the step remained available for cancellation |
| Cancellation | A live child became closed, its PTY became idle, and repeated cancellation returned `changed: false` |
| Daemon restart during review | A separate review-only run remained `waiting_for_review` with the same review id and 17 task records before/after; cancellation remained available |
| Mixed Codex/Cursor run | Incomplete: Cursor displayed its login screen; the run was cancelled without initiating login |
| Project and linked-repo scenarios | Not exercised in this session |

#### Findings

- **Fixed: supervisor wake circular wait.** Original run `fury_8dfbed03-c465-4eac-9066-b206a67d7f0e` created both children but failed their initial commands with `ORCHESTRATION_UNAVAILABLE`, `attempts: 0`. A synchronous wake waits for reconciliation, while reconciliation can itself create a child and request a wake, or wait for a delegation lock held by the caller. Wake requests now acknowledge scheduling after supervisor startup, with reconciliation errors logged asynchronously and the heartbeat retaining responsibility for durable work. The regression uses the real daemon/socket/delegation path with fake PTY processes rather than mocking the wake adapter.
- **Found (fixed in the 2026-10-28 hardening): scheduling executes inside the completing worker.** In run `fury_64f727aa-5f60-4fe6-afe6-54af0dc80805`, both real inspections succeeded, then synthesis child creation failed with `git worktree add` unable to lock a ref (`Operation not permitted`). `completeFuryStep` calls reconciliation in the worker process, so control-plane Git mutations inherit the worker sandbox. `runFury`, status, resume, and review actions also need an audit for the same boundary. The worker reported successful completion while the returned run had failed downstream; this also needs an actionable presentation.
- **Found (fixed in the 2026-10-28 hardening): large piped JSON truncation.** With 17 accumulated task records and prompt/schema text included in task records, `craig task list --json` exited 0 but emitted exactly 65,536 characters of incomplete JSON. Smaller output after closing a task parsed successfully. Check output draining before the explicit `process.exit` in `src/cli.ts`, and add a pipe-backed regression exceeding that size. This matters for agent consumers even though small JSON contract tests pass.
- **Found (fixed in the 2026-10-28 hardening): disabling the preview hides recovery inspection.** With a pending real review, disabling `agentOrchestration` made `fury status` return `CLI_USAGE`, exit 2. Source inspection also shows the preview gate stops Fury heartbeat reconciliation and hides approval attention. Restore the preview after reproducing; do not treat disablement as cancellation.
- **Setup friction: development binary resolution.** A Codex command shell initially selected the installed stable Craig, which did not recognize Fury. The planning agent recovered by resolving the fixture's preview executable; later workers used a fixture instruction with its absolute path. A reproducible walkthrough must explicitly establish which Craig executable the agent uses.
- **Review setup friction.** Feedback currently contains the supplied reason but does not append its review id or resubmission instructions automatically. This bash supplied both explicitly. Resubmission recorded the revised summary in decision history; the original structured synthesis output and review summary remained unchanged. Any future workflow must define which revised artifact downstream steps should consume.

### 2026-10-28 hardening and follow-up bug bash

The next pass used a new disposable reading-list repository, the bundled development CLI, real interactive Codex workers with workspace-write permissions, and explicit workspace selection. The test harness supplied human-role plan/review approvals. The actual planning agent authored, validated, and persisted plan `fury_plan_6991e63b-9dab-43f2-a41c-ea2367ff6d0e`. Its later start turn stalled before invoking a tool, including after one interrupted retry, so the harness started the approved workflow. This is not evidence of a fully unattended conversational plan/approve/agent-start flow.

#### Delivered fixes and automated evidence

- Run/start, completion, resume, and review commands persist state and notify the daemon. Status and watch are read-only. Scheduling and worktree creation occur only during supervisor reconciliation. An unavailable supervisor produces an attributable partial result with the persisted run id. Command-side mutations are tested without scheduling side effects; a process-backed worker completion with a deliberately failing `git` on its PATH still lets the real daemon create the downstream child. Initial child prompt ids are attached to their Fury step so delivery failures cannot disappear from run reconciliation.
- A protocol-compatible leader updates its lease timestamp independently of long reconciliation passes. When a sandbox cannot connect to Unix sockets, a fresh lease plus a live owner permits durable submission for heartbeat pickup. Missing, dead, stale, or incompatible supervisors are not accepted through this fallback. The native macOS sandbox test denied all networking, submitted run `fury_242e5514-ff68-42ba-b45d-d8ed49813402`, observed daemon advancement to review, submitted cancellation from that same sandbox, and observed `cleanupPending: false` afterward. That isolated daemon was stopped.
- Large CLI stdout/stderr pipes drain before exit. A real-process regression uses a 512 KiB task title and a large error envelope. It fails at the original 65,536-character truncation with the old exit behavior and passes with draining. Interactive no-output startup retains its existing behavior.
- Disabling the preview preserves run/review inspection and review attention, including requested changes. The daemon continues deadlines, committed commands, and cleanup while pausing new agent-step scheduling. A daemon restart test with no queued commands and the preview disabled proves a persisted review still expires and cleans up. New plans, plan approvals, and run creation remain gated.
- Cancellation persists stop intent. The daemon closes owned children and cancels queued commands; transport/cleanup errors remain visible as `cleanupError` with `cleanupPending: true`, and subsequent passes retry them. Failed and timed-out runs retain cleanup intent too. Failure injection proves a failed PTY stop cannot be reported as completed cleanup, and retry does not create another task. Terminal-state guards prevent dispatch/timeout recovery from overwriting cancellation.
- Review feedback now supplies the review id and resubmission command automatically. Existing checkpoint history is reused after a crash before step binding; durable decisions are reconciled after interrupted run updates. Tests cover both gaps, late completion/approval rejection, and an omitted optional output becoming an explicit dependent-step failure instead of a permanently claimed step.
- Embedded Codex sessions disable startup update checks. Known Codex trust/update and Cursor login dialogs fail prompt submission before any input is written, with zero delivery attempts and `PROMPT_STARTUP_BLOCKED`. Tests cover the screen adapter, removal of a dialog, and immediate delivery; an ordinary update announcement banner is not treated as a blocking menu.

#### Real-agent result and limitations

The successful run was `fury_8947c86d-ff78-40b0-8b6e-0a2bb930438e`. It created **three distinct children**, with both inspectors and the dependent synthesis task as direct children of the planning task. Both inspectors submitted real findings, the daemon created synthesis after those completions, and synthesis consumed their structured outputs. The review paused downstream work, delivered a plain requested-changes reason with generated resubmission instructions, recorded an agent resubmission in round 2, and released the final step only after a harness-issued human approval. The synthesis worker printed a final brief and explicitly completed the last step after one interrupted/retried final turn. All five steps reached `succeeded`; repository source files remained unchanged.

This live run exposed the socket restriction before the liveness fallback was loaded into its daemon: worker mutations persisted successfully and the daemon advanced the graph, but those CLI calls incorrectly returned supervisor-unavailable partial results. The subsequent native sandbox test validated the final fallback with the new daemon. Repeat the full conversational flow on one final-version daemon before graduation; do not count a native sandbox test as a second model-driven run.

The first attempt also exposed a startup-dialog incident. Initial task input selected Codex's update menu instead of reaching agent input. One global npm update completed (the resulting CLI reported `0.165.0`); the concurrent update failed with `ENOTEMPTY`. That run was cancelled and its children cleaned up. The global installation was left alone afterward. The new embedded update setting removed the menu on the next real launches, and the dialog guard provides an additional no-input failure path. Do not consider ordinary PTY quietness sufficient evidence that an arbitrary runner is at agent input.

Both isolated daemons were stopped after testing, and the fixture retained its plan/run/review records and a compact result manifest. Mixed-runner authentication, project/linked-repo scenarios, a no-intervention conversational start, a single final-version full workflow, and broader active-work restart/soak coverage remain unverified. No preview graduation or version bump was performed.

### Next resume point

Keep Phase `5.2` open. First start from an existing Craig-managed agent conversation with prior task context, ask that agent to spin off a new Fury, and repeat the complete author/validate/plan, human approval, same-agent start, three-child execution, review/revision/resubmission, and final completion flow on one daemon built from the final hardening change, without a fresh planning task, harness start, or turn interruption. Verify that the agent explicitly carries relevant conversational decisions into worker prompts/inputs rather than assuming shared chat history. Preserve ordinary worker sandbox restrictions and verify that accepted mutations return successful machine envelopes through the polling fallback rather than false unavailable-supervisor errors.

Then repeat mixed Codex/Cursor acceptance with an authenticated Cursor installation; the earlier session stopped at Cursor's login screen and did not initiate authentication. Cover four concurrent mixed-runner launches, project inheritance, a repo registered after project discovery, project-owned repo children, already-open TUI insertion, and selecting/reattaching each child into its existing conversation. Complete active-agent daemon-restart and concurrency/failure-injection checks for review feedback, cancellation during dispatch, and runner startup surfaces, followed by a bounded soak. The code fixes, 766-test integrated regression gate pass, successful real three-child run, and native sandbox acceptance are evidence for those checks, not a substitute for them. Keep all workspaces explicitly isolated and verify the development executable resolves inside each runner's command shell. Do not begin `5.3` retries/conditions or `5.4` dynamic fan-out, or remove the preview gate, until this fixed-DAG flow is accepted.

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
- `2.1` initially kept the TUI dots behind the `agentActivityIndicators` preview. After production hardening and shared-contract verification, the indicators graduated to stable default behavior; the retired config key remains accepted as a no-op for compatibility.
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
- start a new Fury from an already-active Craig agent conversation: infer the current root task, capture the discussed context in the definition, obtain human sign-off, and let that same agent start the run without requiring the user to write YAML or create a separate planning task

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
- `[5.2]` From an existing Craig-managed agent thread, a user can ask the current agent to spin off a new Fury; that agent authors and plans the workflow rooted at its current task, explicitly packages relevant conversational context for workers, and starts the approved plan through the CLI without requiring a separate planning conversation or user-authored YAML.
- `[5.2]` A bounded fixed DAG can execute, report structured outputs, cancel, and recover from restart without inferring success from terminal silence or duplicating completed work.
- `[5.2]` A fury can pause at a durable human review checkpoint, route requested changes back to a declared agent target, and release downstream work only after an attributable human approval.
