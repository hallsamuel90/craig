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

The product goal is to make `craig` usable by both people and agents as the local control plane for Craig. The first slices must solve problems that exist now, especially identifying task context and linking or importing PRs. Later slices build on those same contracts to observe agents, inject prompts across tasks, delegate bounded work, and run declarative swarms.

Goals:

- ship useful CLI primitives before building a swarm runtime
- make task and workspace context resolvable without scraping the TUI
- make every automation-facing command non-interactive and machine-readable
- explicitly repair, refresh, unlink, and inspect task-to-PR associations
- adopt a supported existing PR as a new task without manufacturing an unrelated branch
- expose task and agent runtime state through domain-owned contracts
- introduce a durable workspace event journal with resumable cursors
- deliver prompts to a specific task and agent tab through a durable, idempotent queue
- model parent/child delegation with limits, lineage, cancellation, and audit history
- define swarms as versioned YAML DAGs whose persisted runs survive Craig restarts
- allow swarm authors to place intentional, durable human review checkpoints before downstream work proceeds
- use events for normal orchestration transitions and heartbeat jobs only for reconciliation
- keep the TUI, human CLI, and agent CLI on the same domain services

## Non-goals

- a hosted Craig control plane or cross-machine coordinator
- arbitrary shell execution from swarm YAML
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
6. YAML swarm validation, execution, and intentional human review gates

The CLI primitives are the product foundation, not a temporary wrapper around swarm implementation.

### Architecture boundaries

Craig retains the dependency direction `input/ -> shell/ -> domain/`.

```text
TUI input ─────┐
human CLI ─────┼──> shell adapters ───> domain services ───> durable .craig state
agent CLI ─────┘       │                       │
                      ├── PTY daemon           ├── task / PR records
                      ├── Git / GitHub          ├── command records
                      └── clock / process       ├── event journal
                                                  └── swarm runs
```

Ownership rules:

- `domain/task/` continues to own task context, task lifecycle, and PR association result types.
- A new `domain/orchestration/` owns agent status, command records, event envelopes, prompt dispatch, delegation, and swarm definitions/runs.
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
- `CRAIG_SWARM_RUN_ID` and `CRAIG_SWARM_STEP_ID` for swarm workers
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

Task roll-up priority remains `error > ready > working > idle`, matching the sidebar indicator. Agent-tab status remains independently visible.

This state is an observation signal, not workflow completion. A quiet agent may still be reasoning, and `ready` never means that a swarm step succeeded.

Commands:

```text
craig agent list [--task <task-id>] --json
craig agent status [--task <task-id>] [--tab <tab-id>] --json
craig task wait [<task-id>] --state <state[,state...]> \
  [--tab <tab-id>] [--timeout <duration>] --json
```

`task wait` first reads current state, then subscribes from the returned event cursor, eliminating the read/subscribe race. It exits `6` on timeout and supports `SIGINT` cancellation without mutating the task.

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
  swarmRunId: string | null;
  swarmStepId: string | null;
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
- `swarm.run.*`, `swarm.step.*`, and `swarm.review.*`

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
- retention by rotated segment, never deletion of records still referenced by a live command or swarm run

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

Task records gain `parentTaskId`, `rootTaskId`, `delegationDepth`, and optional `swarmRunId`/`swarmStepId`. Cancellation is top-down and idempotent. A child failure does not silently cancel siblings; that decision belongs to the caller or swarm policy.

### Declarative swarm format

A swarm definition is immutable input. Runtime state is stored separately.

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

Commands:

```text
craig swarm validate <file> --json
craig swarm plan <file> [--input key=value] --json
craig swarm run <file> [--input key=value] [--idempotency-key <key>] --json
craig swarm status <run-id> --json
craig swarm watch <run-id> [--after <cursor>] --format jsonl
craig swarm cancel <run-id> --json
craig swarm resume <run-id> --json
craig swarm step complete --run <run-id> --step <step-id> \
  (--output <json> | --output-file <path> | --stdin) --json
craig swarm step fail --run <run-id> --step <step-id> --reason <text> --json
craig swarm reviews list [--run <run-id>] [--state <state>] --json
craig swarm review show <review-id> --json
craig swarm review approve <review-id> [--note <text>] --json
craig swarm review reject <review-id> --reason <text> --json
craig swarm review request-changes <review-id> --reason <text> --json
craig swarm review resubmit <review-id> [--summary <text>] --json
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

Conditions, retries, `foreach`, dynamic fan-out, and recursive child-created swarms are deferred until the fixed DAG is reliable.

### Persistence model

New workspace-local state:

```text
.craig/
  commands/<command-id>.json
  events/<segment>.jsonl
  orchestration/
    capabilities/<capability-id>.json
    definitions/<definition-hash>.yaml
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

interface SwarmRun {
  schemaVersion: 1;
  id: string;
  definitionHash: string;
  state: "pending" | "running" | "waiting_for_review" | "succeeded" | "failed" | "cancelled" | "timed_out";
  inputs: Record<string, unknown>;
  limits: SwarmLimits;
  stepRuns: Record<string, SwarmStepRun>;
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

Records carry a schema version. Readers migrate supported older versions in memory and rewrite only during an explicit mutation. Secrets and capability values are never copied into events, logs, JSON output, or swarm definitions.

## Implementation tracker

### Status summary

- `1.1` Add machine-readable command output and deterministic workspace/task context: `verified; regression hardening complete`
- `1.2` Add explicit PR show/discover/link/refresh/unlink repair commands: `pending`
- `1.3` Import an existing same-repository PR as a Craig task: `pending`
- `2.1` Extract domain-owned agent status and expose list/status/wait: `pending`
- `2.2` Add the durable event journal and event list/watch: `pending`
- `3.1` Add durable, target-specific prompt dispatch and command inspection/wait/cancel: `pending`
- `4.1` Add capability-scoped parent/child delegation and tree cancellation: `pending`
- `5.1` Add swarm YAML parsing, validation, and dry-run planning: `pending`
- `5.2` Execute and recover a fixed DAG with structured completion and intentional human review gates: `pending`
- `5.3` Add guarded retry policies and conditional steps: `deferred`
- `5.4` Add bounded `foreach` fan-out and dynamic delegation: `deferred`

### Verification summary

- `1.1` Verified by replacing ad hoc argv matching with a structured parser for order-independent global options; adding versioned JSON success/error envelopes, an authoritative error-code-to-exit-code mapping, non-interactive guards, and stable exit categories; resolving workspace context through explicit flags, environment, ancestors, and Git common-worktree discovery; resolving task and agent-tab context through explicit flags, environment, and task filesystem topology without UI selection; exposing `context show`, `task current`, and optional-context `task show`; and propagating Craig identity into task PTYs. Coverage includes every pre-existing parser command with global options before and after the command, flag separators, stdout/stderr isolation, no-input behavior, optional-context task-show execution, task/repo/workspace not-found exits, corrupt-record classification, precedence, missing/invalid/ambiguous/conflicting context, macOS canonical path aliases, project task bundles and repo targets, ambient-context isolation, and packed-artifact JSON success and failure execution. Automated verification passed with 515 tests via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `1.2` Not yet verified.
- `1.3` Not yet verified.
- `2.1` Not yet verified.
- `2.2` Not yet verified.
- `3.1` Not yet verified.
- `4.1` Not yet verified.
- `5.1` Not yet verified.
- `5.2` Not yet verified.
- `5.3` Deferred until fixed-DAG execution has production use.
- `5.4` Deferred until limits and cancellation are proven under fixed DAGs.

### Next resume point

Resume at `1.2`. Treat the regression-hardened Phase `1.1` parser, JSON envelopes, centralized exit mapping, packed-artifact contracts, and deterministic context resolver as the stable CLI foundation for explicit PR show/discover/link/refresh/unlink repair commands. Keep repository and branch verification in task-domain services, preserve PR history, and do not make later dispatch, eventing, or swarm phases prerequisites for collecting this repair value.

### Skipped and deferred work

- Fork-origin PR import is deferred beyond `1.3`.
- Remote/network control is out of scope.
- Agent semantic acknowledgements are optional follow-up after reliable delivery.
- Swarm retries, conditions, fan-out, and recursive delegation remain deferred through `5.2`.

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
  swarmRunId?: string | null;
  swarmStepId?: string | null;
}
```

Existing records read as `worktreeOwnership: "craig"`, `taskOrigin: { type: "created" }`, no parent, self as root, and depth zero. Validation accepts missing fields for compatibility; the next task mutation writes the normalized shape. No bulk migration is required.

`CraigPaths` gains `commandsDir`, `eventsDir`, and `orchestrationDir`. `CraigConfig` gains the `agentOrchestration` preview plus bounded orchestration settings. New command and event result types live in `domain/orchestration/types.ts`; PR association/import results remain in `domain/task/types.ts`.

Daemon protocol additions are internal, versioned transport contracts. A protocol mismatch triggers the existing compatible-daemon restart path. Persisted schemas and the public JSON envelope are versioned independently from the daemon protocol.

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
- Duplicate swarm run idempotency keys return the original run.
- Invalid YAML, unknown fields, cycles, missing references, excessive limits, and unresolved templates fail during `validate`/`plan` before mutations.
- A swarm restart resumes from durable run and command state; it does not re-run succeeded steps.
- A restart preserves pending human review, its deadline, review round, decision history, and blocked downstream steps.
- Review mutations require the expected record version and use compare-after-lock semantics. The first valid write wins; stale concurrent decisions return a conflict, and approve/reject are terminal.
- Requesting changes without a configured feedback target returns a conflict and leaves the review waiting. If a configured target becomes unavailable after the decision is persisted, the review remains `changes_requested`, records the delivery failure, and requires human intervention; it never releases downstream work.
- A feedback target that completes revisions cannot approve the gate. It may only resubmit it for another human decision.
- A step timeout cancels its queued command and child task according to policy, but cannot claim a PTY process stopped until runtime termination is confirmed.
- Structured output that fails its declared schema fails the step with the validation details.

## Security and privacy

- All control remains local to the user account and workspace.
- Capability files use restrictive filesystem permissions and contain opaque random values.
- Agent capabilities default to the current task and its children; cross-task prompt injection is opt-in.
- Agent capabilities never include human-review approve, reject, or request-changes permissions. A feedback-target capability may only read and resubmit its assigned review.
- Human review mutations require an interactive human CLI/TUI context without an agent capability. This is a workflow boundary, not a hard security boundary against a malicious process with unrestricted access to the same OS user and workspace.
- `--json` changes review-command output but does not waive the interactive human-context check. Non-interactive and remote approvals are out of scope.
- Prompt size, event payload size, output size, task count, depth, concurrency, and runtime duration have hard limits.
- Control characters are rejected or encoded by runner-specific prompt delivery.
- YAML cannot execute shell commands, read arbitrary environment variables, or reference undeclared files.
- `--prompt-file` and `--output-file` resolve explicitly supplied paths; swarm templates cannot perform path traversal.
- Capability values, environment secrets, raw terminal buffers, and full prompts are excluded from event payloads by default.
- Human-readable audit history records actor, target, command type, timestamps, and disposition.
- PR link/import always verifies GitHub state through authenticated tooling rather than trusting caller-provided metadata.
- Imported external worktrees are never deleted by Craig.

## Observability

- Every durable mutation has a command id or event id and actor.
- JSON errors expose stable codes, retryability, and safe details.
- `craig events watch` is the canonical diagnostic stream for orchestration.
- `craig command show` explains delivery attempts and the last safe error.
- `craig swarm status` reports each step, dependency blockers, target task, command id, timestamps, and output-validation state.
- Human review emits `swarm.review.requested`, `swarm.review.changes_requested`, `swarm.review.resubmitted`, `swarm.review.approved`, `swarm.review.rejected`, `swarm.review.timed_out`, and `swarm.review.cancelled` with review id, round, actor, and safe reason metadata.
- The TUI surfaces waiting reviews as an explicit attention state with review title, run/step context, elapsed time, and available human actions; it does not disguise a review gate as agent failure or completion.
- Heartbeat reconciliation logs job id, scanned count, repaired count, duration, and failures without logging prompt bodies.
- Event journal corruption, cursor expiration, uncertain prompt delivery, capability denial, and orphaned runtime sessions are surfaced as explicit events and error log entries.

## Rollout plan

- `1.1` and `1.2` are additive stable CLI capabilities and should ship without a feature preview once their machine contracts are tested.
- `1.3` ships as an explicit command with same-repository limitations documented; it does not alter normal task creation.
- `2.1` reuses the existing `agentActivityIndicators` preview while the domain extraction lands. CLI status may be marked preview until TUI and CLI report identical results.
- `2.2`, `3.1`, `4.1`, and `5.x` are gated by a new `agentOrchestration` feature preview during initial use.
- Read-only validation, planning, status, and event inspection may be enabled before mutating swarm execution.
- Preview disablement stops new dispatch/run creation but does not abandon existing durable commands or runs; Craig continues status, cancellation, and safe reconciliation.
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

- persist swarm runs and fixed-DAG step state
- schedule ready steps within limits through child creation and prompt dispatch
- add explicit schema-validated step complete/fail
- persist human review checkpoints and decision history, including approve, reject, request-changes, feedback delivery, and resubmit
- expose review list/show/actions in the CLI and a TUI attention surface for waiting checkpoints
- block downstream steps until human approval and report `waiting_for_review` at the run level when appropriate
- implement watch, status, cancel, resume, timeouts, and heartbeat reconciliation

#### Verification

- cover dependency ordering, parallel limits, success/failure/cancel/timeout, output validation, restart at every transition boundary, and no replay of succeeded steps
- cover approve/reject/request-changes/resubmit, feedback delivery failure, human-versus-agent authorization, concurrent decisions, review timeout, restart while waiting, and downstream blocking
- run a real multi-task swarm with stub agents and then one manual Codex swarm containing at least one human review checkpoint

#### Tracking update

- keep `5.2` open if terminal silence is treated as success, restart can duplicate a step, or downstream work can bypass an unapproved human checkpoint
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
- `[5.1]` A swarm YAML file, including human review gates and feedback targets, can be validated and planned with zero runtime mutations.
- `[5.2]` A bounded fixed DAG can execute, report structured outputs, cancel, and recover from restart without inferring success from terminal silence or duplicating completed work.
- `[5.2]` A swarm can pause at a durable human review checkpoint, route requested changes back to a declared agent target, and release downstream work only after an attributable human approval.
