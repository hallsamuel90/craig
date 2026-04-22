# RFC: Craig Local Control Plane

- **Date:** 2026-04-20
- **Status:** In Flight
- **Author:** Codex

---

## Context and goals

Craig is a terminal-native local control plane for repo-backed agent work. It is not a model, hosted system, generic shell wrapper, or replacement for vendor runner CLIs. Craig is the product and the orchestrator. It coordinates repo tasks, review flow, execution context, and durable state on top of runner backends such as Cursor CLI first and Codex CLI later.

The current implementation may begin with CLI and minimal-shell scaffolding, but that is not the intended product endpoint. Craig should evolve into an interactive terminal application with a TUI control surface that feels like mission control for repo tasks.

The terminal toolchain for this RFC is:

- Ghostty as the preferred terminal emulator, without making Craig depend on it programmatically
- Craig as the control plane and interactive terminal application
- tmux as the execution and session substrate for long-running task contexts
- `nvim` as the file viewer and editor surface
- Cursor CLI first and Codex CLI later as runner backends

The Phase 1 vertical slice matters because raw runner CLI workflows still leave the developer loop fragmented across shell history, manual branch and worktree setup, hard-to-resume long-running sessions, scattered logs and diffs, and PR and CI state that must be managed outside the task workflow.

This RFC solves the concrete workflow problems that currently create friction:

- task state is implicit in shell history and branch names
- worktree setup, branch setup, and cleanup are manual and error-prone
- long-running runner sessions are hard to monitor, resume, and navigate
- logs, diffs, review checkpoints, and PR state are spread across separate tools and terminals
- file inspection and editing require ad hoc context switches
- idea-to-merged-code is not represented as one coherent local system

Goals for this RFC:

- ship a terminal-native control plane for repo-backed development tasks
- make the full developer loop first-class: create, run, inspect, review, check, commit, open PR, watch CI, merge, and clean up
- keep state filesystem-backed under `.craig/` with no database, daemon, or hosted service initially
- keep worktrees as the core execution unit for repo tasks
- use tmux underneath as execution/session substrate while keeping Craig, not tmux, as the source of truth for task state
- evolve toward a TUI control surface while allowing the near-term implementation to begin with a minimal shell or REPL
- keep command mode available for scripts and automation
- define a thin runner abstraction that supports Cursor first and Codex second without over-generalizing

## Non-goals

- supporting Claude Code in this RFC
- building hosted sync, remote coordination, or multi-user state
- introducing a database, background daemon, or queueing system in the initial architecture
- building a full editor inside Craig
- broad general-task orchestration in Phase 1
- abstracting every possible runner capability up front
- making tmux itself the product UX
- treating the minimal shell or REPL as the final product surface

The TUI direction is intentional and product-defining, but the richer Craig UX should build on top of a proven repo-task workflow rather than replacing that workflow with UI ambition before the underlying loop works end to end.

## Proposal

Craig is an interactive terminal control plane with supporting command surfaces. The minimal shell or REPL is a bootstrap interaction surface, not the intended end-state product. Craig owns task lifecycle, durable state, orchestration, review flow, and operator visibility across the repo-backed development loop.

Craig uses tmux to host persistent runner execution contexts. Craig uses `nvim` to hand off deep file inspection and editing. Craig preserves command mode for scripting and automation. Craig should read as the terminal-native orchestrator that coordinates those components rather than a thin wrapper around Cursor and tmux.

## System model

Craig has five layers:

1. Control plane layer: owns task lifecycle, orchestration, review-to-merge workflow, UI/control-surface state, and command dispatch.
2. Runner layer: owns thin adapters for Cursor first and Codex later.
3. Session and execution substrate: uses tmux for long-running execution contexts, pane or window targeting, and session continuity.
4. State layer: owns durable filesystem state under `.craig/`, including task records, logs, artifacts, worktree metadata, and runtime metadata.
5. File surface: uses `nvim` as the file viewing and editing handoff surface.

The primary operating model is:

1. User starts `craig`.
2. Craig loads or initializes `.craig/index.json` and any related repo-local state.
3. Craig presents an interactive terminal control surface.
4. User creates or selects a repo task.
5. Craig allocates a task id, creates a git worktree, creates branch `craig/<task-id>`, provisions a persistent execution context through tmux, and launches the configured runner in that worktree.
6. Craig records metadata and surfaces status, logs, diff state, review state, and next actions through its interactive control surface.
7. Craig provides first-class actions for inspect, diff, focus, file drill-down, checks, commit, PR creation or refresh, CI watch, merge, and cleanup.
8. When the user needs deep file inspection or editing, Craig hands off to `nvim` in the correct worktree or file context.

Craig is interactive-first at the product level. Command mode remains required for scripts, automation, and direct invocation, but it should call the same service layer and produce the same task-state side effects as the interactive terminal application.

## UI and interaction model

Craig should evolve toward a TUI control surface that acts as mission control for repo tasks.

Near-term implementation direction:

- interactive terminal shell or minimal REPL
- task listing and task status rendering
- command entry and concise action feedback
- compact control-surface visibility over task execution resources

End-state product direction:

- TUI control surface
- panels for tasks and worktrees
- active work surface
- selected task details
- logs
- diff summary
- changed files
- review state
- task actions

Interaction model decisions:

- Craig remains the visible mission-control surface
- task execution remains long-running, persistent, and inspectable underneath
- file-level drill-down launches `nvim`
- command mode remains available outside the TUI
- tmux may continue to host persistent execution contexts, but the UX should be described in Craig terms rather than tmux terms
- movement should require as little mode switching, typing, and context reloading as possible
- the default screen should privilege orientation and actionability over raw information density
- visual noise should stay low: status should be legible at a glance without turning the interface into a dashboard of constant motion

Craig should feel more like:

- `lazygit`
- `k9s`
- a conductor-like mission-control UI in the terminal

Craig should feel less like:

- a basic shell prompt
- a pile of subcommands
- tmux with helper scripts around it

Minimum interaction contract for the richer Craig TUI:

- the left column is the task and worktree list and owns the primary selection cursor
- the middle column is the active work surface and is where the user actually types, triggers actions, and interacts with Craig for the selected task
- the right column is the context surface and shows selected-task summary, lifecycle state, runner state, checks, PR state, next actions, and switchable detail tabs for logs, diff summary, changed files, and review details
- Craig keeps exactly one selected task, one active work surface, and one active context tab at a time
- if the previously selected task still exists, Craig should restore that task, the last work-surface mode, and the last active context tab before applying any default-selection logic
- if there is no restorable task selection, the default landing view should preselect the highest-priority non-terminal task in this order: `merge_ready`, `pr_open`, `checked`, `review`, `running`, `draft`; ties are broken by most recently updated, and if only terminal tasks remain Craig selects the most recently updated task
- the default action path should be obvious from the selected task summary without requiring the user to open a secondary menu first
- `j` and `k` or the arrow keys move the current list selection
- `tab` and `shift-tab` cycle focus between the task list, work surface, and context surface
- `enter` executes the default action for the current focus target
- `l` opens the logs view for the selected task
- `d` opens the diff-summary view for the selected task
- `f` opens the changed-files view for the selected task
- `a` opens inline action mode for the selected task in the middle work surface
- `:` opens the Craig command bar inside the middle work surface
- `o` opens the selected task or file in the configured opener, with explicit `nvim` handoff supported once file-level drill-down lands
- `/` filters the task list
- `esc` clears transient UI state in order of least-destructive unwinding: close inline overlays first, clear filter second, return focus to the task list last
- there should be no deep modal stacks; at most one transient overlay such as command help, attach confirmation, or a confirm dialog may be open at a time
- expensive or noisy views must not steal focus automatically; logs and status refresh in place without yanking the cursor away from the current task
- status updates should feel calm rather than chatty: no spinner storm, no excessive color churn, and no reflow that makes the selection jump
- the right-column context tabs should keep stable ordering so muscle memory can form around logs, diff, files, and review; task actions live in the middle work surface instead of becoming a fifth context tab
- if the richer TUI renderer is unavailable or fails, Craig falls back to the minimal interactive shell without changing task lifecycle behavior or command semantics

Work-surface decisions:

- the middle work surface is not just status; it is the primary input area for Craig
- when the user is focused in the middle surface, typed input goes to Craig rather than directly to the runner session unless the user explicitly enters a passthrough or attach action
- the middle surface supports at least three modes:
  - command bar mode for terse Craig commands and action dispatch
  - inline action mode for task-specific actions such as check, commit, PR, merge, open, and focus
  - attach mode for intentionally dropping into the live task execution context when the user wants direct terminal interaction
- command bar mode is the default work-surface mode because it keeps Craig visible and in control
- attach mode is entered only through an explicit attach action in inline action mode or an explicit Craig command such as `attach <task-id>`; selection changes, refreshes, and log updates must never enter attach mode implicitly
- attach mode must be explicit and reversible so the user does not accidentally lose the mission-control shell
- while attached, Craig reserves a detach chord such as `ctrl-]` to return to the same selected task, the prior middle-surface mode, and the prior context tab without relying on tmux-specific user knowledge
- when the selected task changes, the middle work surface updates to that task’s current command and action context without requiring a full screen reset
- the middle work surface should make it obvious whether the user is talking to Craig, choosing an action, or attached to the task terminal
- the middle work surface should support immediate, low-friction action on the selected task without forcing the user to bounce back to a raw shell prompt

Visual and motion constraints for the TUI:

- use a restrained visual hierarchy: one primary accent, one warning accent, one success accent, and otherwise quiet terminal-native styling
- use color to reinforce lifecycle and action readiness, not to decorate every row
- avoid live-updating regions that cause the whole screen to re-render or flicker
- keep persistent chrome minimal so the majority of the screen belongs to task state, logs, diff, and files
- reserve animation or cursor movement effects for meaningful transitions only, and prefer no animation over distracting animation
- keep key actions visible in-context so the user rarely needs to remember hidden commands or open a help screen

## Runner model

Runner adapters implement a deliberately narrow contract:

- `prepare(task, context)`
- `launch(task, context)`
- `status(task, context)`
- `stop(task, context)`
- `collectArtifacts(task, context)`

`context` includes repo root, worktree path, tmux target metadata, environment variables, and optional prompt file paths.

Runners are execution backends, not the product UX. Craig supervises runner sessions, artifacts, and lifecycle transitions. Craig does not attempt to reimplement runner cognition, planning, prompt semantics, tool behavior, or review logic that belongs to the underlying CLI.

Phase 1 includes only the Cursor adapter using `cursor agent` as the concrete launch contract. Phase 3 adds Codex on the same task model and runner-session boundary after the mission-control UX is stable enough to validate a second runner cleanly. Claude Code remains explicitly out of scope.

Runner design principles:

- `Thin wrapper`: adapt process and session behavior only
- `Vendor-native behavior`: do not override how the underlying runner plans or works
- `Stable control-plane contract`: Craig needs one lifecycle boundary across runners
- `Capability-driven differences`: expose runner-specific limits rather than hiding them behind fake uniformity

Conceptually, `launch` and `status` must surface enough runner-session information for Craig to supervise live execution resources even when the underlying CLI remains vendor-native. At minimum, the runner boundary must be able to provide:

- launch timestamp
- resolved runner command
- pid when available from the local platform or session manager
- substrate target metadata such as tmux target
- worktree path
- log path
- last known runner state
- optional exit code and exit timestamp

Craig persists that runner-session metadata for orchestration and inspection. It is not intended to mirror vendor-internal state.

## State model and filesystem layout

Craig stores durable local state under:

```text
.craig/
  index.json
  config.json
  runtime/
    session.json
  tasks/
    <task-id>.json
  jobs/
    <job-id>.json
  worktrees/
    <task-id>/
  logs/
    <task-id>.log
  artifacts/
    <task-id>/
      pr.md
      pr-status.json
      check-summary.json
```

State model decisions:

- `.craig/` is the Craig-owned durable state root
- `index.json` is a lightweight registry for task ids, job ids, and path references
- per-task JSON files are authoritative for task details to avoid large index rewrites
- logs are append-only text files
- artifacts have stable paths so `pr` and `check` can update them idempotently
- `.craig/runtime/` may store UI, session, and runtime metadata needed by Craig
- worktrees should live under `.craig/worktrees/` when git supports that cleanly; if git requires or benefits from an external path, the resolved path must be stored explicitly in the task record
- JSON writes should be atomic to prevent corruption on interruption

Task records may include execution substrate metadata such as tmux targets, `tmuxWindowTarget`, `tmuxPage`, and `layoutSlot`, but Craig state remains authoritative. Those fields are runtime and navigation metadata in support of Craig, not the primary product abstraction.

## Task lifecycle

Craig owns this repo-task lifecycle:

`draft -> running -> review -> checked -> pr_open -> merge_ready -> merged`

Lifecycle decisions:

- `draft` exists for newly created or partially provisioned tasks that are not yet actively running
- `running` means the runner session is provisioned and Craig considers the task active
- `review` means the task has code changes ready for inspection
- `checked` means Craig has completed configured checks and persisted their results
- `pr_open` means Craig has created or attached a pull request and is tracking remote review and CI state
- `merge_ready` means the tracked pull request is mergeable and all required remote checks are green
- `merged` means the merge succeeded even if cleanup later reports warnings

Lifecycle transition decisions:

- task creation failure returns the task to `draft` with a recorded failure reason
- `commit <id>` is allowed only from `review` or `checked`
- `pr <id>` is allowed only from `checked` and transitions the task to `pr_open` after the PR is successfully created or attached
- Craig refreshes PR state during `show <id>`, `pr <id> --watch`, and `merge <id>`; a task moves from `pr_open` to `merge_ready` only when the PR is mergeable and required remote checks are green
- `merge <id>` is allowed only from `merge_ready` and transitions to `merged` only after the underlying GitHub merge succeeds
- Craig blocks invalid transitions by default unless a later implementation explicitly adds override flags

Lifecycle state is owned by Craig, not inferred from tmux layout or runner internals. Different Craig UI surfaces may render different slices of lifecycle information, but they share the same durable task state.

## CLI and terminal surfaces

Craig has three surface types in this RFC.

### Interactive terminal application

The primary product surface is the interactive terminal application.

In the current implementation shape, that may begin as a minimal shell or REPL with commands such as:

- `new <task>`
- `list`
- `show <id>`
- `logs <id>`
- `diff <id>`
- `focus <id>`
- `open <id>`
- `check <id>`
- `commit <id>`
- `pr <id>`
- `merge <id>`

That minimal shell is the initial implementation shape, not the end-state product. The intended direction is a richer TUI control surface that still supports the same lifecycle and command model.

### Command mode

Command mode remains secondary but first-class for automation and scripting.

Examples:

- `craig task new "refactor auth"`
- `craig task list`
- `craig task check <id>`
- `craig task pr <id> --watch`
- `craig task merge <id>`

Command mode decisions:

- command mode uses namespaced forms for clarity in scripts
- both command mode and the interactive application must call the same service layer
- task ids are Craig-generated and opaque

### File surface handoff

Craig does not build an editor. `nvim` is the file viewer and editor surface.

File-surface decisions:

- `open <id>` opens the task worktree in the user’s configured tool or prints the resolved path when no opener is configured
- Craig should be able to open the selected worktree in `nvim`
- Craig should be able to open selected changed files in `nvim`
- near-term phases may still rely on the configured opener or printed path for worktree-level inspection
- explicit selected-file `nvim` handoff is a first-class UX goal for the richer Craig mission-control phases rather than a blocker for the initial workflow slice
- Craig may later expose explicit actions such as opening the current task or the selected changed file in `nvim`

The interactive boot flow should present Craig as a local control plane and render a boot sequence consistent with the product brief, including the ASCII banner and current workspace summary.

Boot experience decisions:

- the `CRAIG` ASCII art should render in slime-green or matrix-green terminal styling rather than default monochrome output
- the banner styling should work in common ANSI-capable terminals without requiring a custom font or truecolor-only features
- supporting text under the banner should stay visually subordinate to the green ASCII mark
- the banner support copy should include the easter egg line `crAIg is that you?`

## Developer workflow

Phase 1 must support this repo-task flow end to end:

1. create task id
2. create worktree
3. create branch
4. launch the runner in a persistent execution context
5. monitor logs and agent progress
6. inspect task state and diff state
7. drill into worktree inspection through the current opener flow when needed
8. run checks
9. commit changes
10. open or update PR
11. wait for or inspect CI status
12. merge
13. clean up worktree and execution resources

Craig should treat these steps as one connected system. Users should not need ad hoc shell scripting for the normal repo-task workflow, and Craig should reduce context switching across git state, runner state, terminal navigation, review readiness, and PR status. Richer in-terminal file and diff navigation, including first-class selected-file `nvim` handoff, should follow immediately after the workflow foundation as the next UX priority.

## Implementation tracker

### Status summary

- `1.1` Bootstrap CLI shell, shared control-plane services, and interactive terminal foundation: `implemented and verified`
- `1.2` Repo task creation with worktree, branch, execution substrate, and Cursor launch: `implemented and verified`
- `1.3` Task inspection, logs, diff, focus, and open flows: `implemented and verified`
- `1.4` Checks, commit, PR creation, CI tracking, merge, and cleanup: `implemented; automated verification complete; manual GitHub flow verification pending`
- `2.1` Terminal control-surface foundation on top of tmux-backed execution contexts: `implemented; automated verification complete; live tmux-backed control-surface verification pending`
- `2.2` Richer Craig TUI navigation and task inspection: `pending`
- `2.3` Review, file, and diff navigation improvements with mission-control polish: `pending`
- `3.1` Codex runner adapter on the same task model: `pending`
- `4.1` General tasks and scheduled jobs: `pending`

### Verification summary

- `1.1` Verified via shared command-dispatch tests plus passing `pnpm test`, `pnpm typecheck`, and `pnpm lint`.
- `1.2` Verified via automated coverage, passing `pnpm test`, `pnpm typecheck`, and `pnpm lint`, plus a live manual run of `craig task new "manual verification task"` that created the worktree, provisioned the execution context, persisted runner-session metadata, and launched Cursor in the correct worktree.
- `1.3` Verified via parser, service, and minimal-shell coverage for `show`, `logs`, `diff`, `focus`, and `open`, plus passing `pnpm test`, `pnpm typecheck`, and `pnpm lint`, plus a manual built-CLI run in a temporary git repo that confirmed `show`, `diff`, `open`, and `focus` against durable task state and recorded substrate metadata. Current limitations: `logs` depends on local `tail`, focus still depends on persisted tmux metadata, and `open` prints the path when no opener is configured.
- `1.4` Automated verification completed via parser and lifecycle-service coverage for `check`, `commit`, `pr`, `merge`, cleanup preservation, and tracked-PR refresh behavior, plus passing `pnpm test`, `pnpm typecheck`, and `pnpm lint`. Manual authenticated GitHub verification of the full `new` to `pr --watch` to `merge` flow is still pending in a real repo and remote environment.
- `2.1` Automated verification completed via new runtime-store, layout-renderer, and interactive-app coverage for persisted UI state, three-zone or stacked rendering, command-buffer execution, task reselection, and log-stream suspend or resume behavior, plus the existing tmux-service, create-task, focus, and command-router coverage, and passing `pnpm test`, `pnpm typecheck`, and `pnpm lint`. Live interactive verification of the revised three-zone control surface with tmux-backed tasks is still pending.

### Next resume point

Resume at the first sub-phase that is not both implemented and verified. The current resume point is `1.4` to complete live manual GitHub verification, then `2.1` to complete live tmux-backed control-surface verification for the new three-zone interactive surface, then `2.2`.

### Deferred phases

- `2.2` Deferred until the terminal control-surface foundation is stable enough to support richer TUI navigation cleanly.
- `2.3` Deferred until task navigation and inspection are stable enough to justify deeper review and file-navigation workflows.
- `3.1` Deferred until the workflow foundation and UX direction are stable enough to validate a second runner cleanly.
- `4.1` Deferred until repo tasks and UX navigation are stable enough to relax repo-specific assumptions intentionally.

### Phase execution and verification policy

Each sub-phase is complete only when:

- its in-scope implementation items are landed in a coherent state
- its required tests and evals pass
- covered end-to-end flows are exercised during tuning when applicable
- any out-of-scope failures are recorded explicitly in the tracker or handoff section

Every implementation session must resume from the first sub-phase that is not both implemented and verified. Skipped or intentionally deferred work must be recorded explicitly rather than implied.

## API and data model changes

The external API surface in Phase 1 is the CLI and terminal command contract. There is no network API in this RFC.

### Interactive command contract

Interactive commands in the minimal shell include:

- `new <task>`
- `list`
- `show <id>`
- `logs <id>`
- `diff <id>`
- `focus <id>`
- `open <id>`
- `check <id>`
- `commit <id>`
- `pr <id>`
- `merge <id>`

### Command mode examples

- `craig task new "refactor auth"`
- `craig task list`
- `craig task check <id>`
- `craig task pr <id> --watch`
- `craig task merge <id>`

### Task record contract

Initial task record schema contract:

```json
{
  "id": "task_20260420_01",
  "title": "refactor auth",
  "slug": "refactor-auth",
  "type": "repo",
  "status": "running",
  "runner": "cursor",
  "repoRoot": "/path/to/repo",
  "worktreePath": "/path/to/repo/.craig/worktrees/task_20260420_01",
  "branch": "craig/task_20260420_01",
  "tmuxTarget": "%1",
  "tmuxWindowTarget": "@1",
  "tmuxPage": 1,
  "layoutSlot": 2,
  "runnerSession": {
    "command": ["cursor", "agent", "refactor auth"],
    "tmuxTarget": "%1",
    "pid": 12345,
    "startedAt": "2026-04-20T20:01:00Z",
    "lastKnownState": "running",
    "exitCode": null,
    "exitedAt": null
  },
  "prompt": {
    "source": "inline",
    "value": "refactor auth"
  },
  "checks": {
    "source": {
      "type": "repo_config",
      "path": ".craig/config.json"
    },
    "lastRunAt": null,
    "status": "not_run",
    "commands": []
  },
  "pullRequest": {
    "provider": "github",
    "number": 123,
    "url": "https://github.com/org/repo/pull/123",
    "baseBranch": "main",
    "headBranch": "craig/task_20260420_01",
    "status": "open",
    "mergeable": false,
    "requiredChecks": [
      {
        "name": "ci / test",
        "status": "pending",
        "conclusion": null
      }
    ],
    "lastSyncedAt": "2026-04-20T20:15:00Z"
  },
  "artifacts": {
    "logPath": ".craig/logs/task_20260420_01.log",
    "prDraftPath": null,
    "prStatusPath": ".craig/artifacts/task_20260420_01/pr-status.json"
  },
  "createdAt": "2026-04-20T20:00:00Z",
  "updatedAt": "2026-04-20T20:00:00Z"
}
```

Required task record fields:

- stable task id
- title and normalized slug
- task type
- lifecycle status
- runner
- repo root
- resolved worktree path
- branch name
- substrate target metadata when needed for execution and navigation
- runner-session metadata sufficient for Craig to supervise and inspect the launched runner
- prompt source metadata
- latest check summary metadata
- tracked pull request metadata
- artifact references
- creation and update timestamps

Substrate metadata such as `tmuxTarget`, `tmuxWindowTarget`, `tmuxPage`, and `layoutSlot` exists to help Craig supervise execution resources and navigation. Those fields are subordinate to Craig-owned lifecycle and orchestration state.

### Runner adapter contract

Runner adapters must implement:

- `prepare(task, context)`
- `launch(task, context)`
- `status(task, context)`
- `stop(task, context)`
- `collectArtifacts(task, context)`

`launch` and `status` must be able to surface the runner-session metadata Craig needs to supervise a live runner without depending on vendor-internal state. That includes the resolved command, substrate target metadata, start time, last known runner state, and optional pid and exit metadata when the platform exposes them cleanly.

### State directory contract

Craig introduces:

- `.craig/index.json`
- `.craig/runtime/session.json`
- `.craig/tasks/<task-id>.json`
- `.craig/jobs/<job-id>.json`
- `.craig/logs/<task-id>.log`
- `.craig/artifacts/<task-id>/...`
- `.craig/worktrees/<task-id>/...` or a resolved external path recorded in the task record

### Check execution contract

Phase 1 check commands come from Craig repo configuration.

- `.craig/config.json` may define an ordered list of shell commands under a repo-level `checks.commands` key
- `check <id>` runs exactly that ordered list inside the task worktree and persists command, exit code, start and end times, and aggregate status
- if no check commands are configured, `check <id>` fails with a clear configuration error and the task remains in `review`
- a task may enter `checked` only when every configured check command exits successfully

### Pull request contract

Craig owns pull request bookkeeping for Phase 1 using GitHub CLI.

- `pr <id>` creates the PR when none exists, or refreshes the existing PR when one is already tracked
- Craig persists the PR number, URL, base branch, head branch, latest mergeability result, and required-check summary in the task record and `.craig/artifacts/<task-id>/pr-status.json`
- `pr <id> --watch` polls GitHub for required-check updates until all required checks succeed, one fails, or the user interrupts the watch
- `show <id>` and `list` surface the latest known PR and CI status so the user can see when a task is ready to merge
- `merge <id>` refreshes PR state immediately before merging and fails closed if the PR is not mergeable or any required check is not green

### Lifecycle status contract

Task lifecycle statuses in scope for Phase 1:

- `draft`
- `running`
- `review`
- `checked`
- `pr_open`
- `merge_ready`
- `merged`

### Terminal toolchain contract

- Ghostty is the preferred terminal emulator, but Craig must not depend on it programmatically
- tmux is required for managed runner sessions in the current phases
- `nvim` is optional but first-class for file drill-down and editing handoff
- command mode remains scriptable without requiring tmux-attached interaction

## Edge cases and failure modes

- git worktree creation fails because of dirty or incompatible repo state: Craig stops task creation, records the failure, and leaves no partial task marked as running
- branch creation collides with an existing `craig/<task-id>` reference: Craig allocates a new task id and retries before surfacing failure
- tmux is unavailable or the Craig execution session cannot be created: Craig fails fast with a prerequisite error and surfaces it as substrate failure rather than task-state corruption
- Cursor launch fails after worktree creation: Craig marks the task `draft`, records the failure reason, and keeps the worktree available for inspection
- log streaming encounters truncation or rotation: Craig treats Craig-managed logs as append-only and surfaces any mismatch as an operator-visible error
- checks pass but the diff is empty: Craig blocks `commit` and `pr` by default
- the user manually edits or deletes the worktree: Craig detects the mismatch during `show`, `check`, `commit`, and `merge` and surfaces repair guidance
- PR creation succeeds but local artifact persistence fails: Craig warns immediately, re-syncs PR state on the next `show`, `pr`, or `merge`, and does not assume the local record is complete until the resync succeeds
- remote CI reports a failing or missing required check: Craig keeps the task in `pr_open`, surfaces the failing check names, and blocks `merge <id>`
- GitHub marks the PR unmergeable because the branch is behind or has conflicts: Craig surfaces the reason, keeps the task out of `merge_ready`, and requires the user to update the branch before retrying merge
- merge succeeds but cleanup fails: Craig records the task as `merged` with a cleanup warning instead of downgrading merge state
- `nvim` is unavailable when Craig tries to launch deep file inspection: Craig fails clearly and preserves task context
- TUI or control-surface rendering fails: Craig degrades to minimal shell output rather than blocking lifecycle commands

## Security and privacy

Craig is local-only, but it still manages potentially sensitive code, prompts, and command output.

- all state remains on the local filesystem by default
- no background telemetry or hosted sync is introduced in this RFC
- logs may contain prompts, code snippets, and command output, so Craig should rely on user-default filesystem permissions and avoid accidental world-readable writes
- PR artifacts are generated locally and are not transmitted automatically
- GitHub CLI authentication and PR metadata access should use the user’s existing local auth context and avoid storing tokens inside `.craig/`
- runner adapters should pass through only the environment variables they need rather than inheriting an unconstrained environment by default
- launching `nvim` or other local tooling should use the user’s local environment without persisting secrets into Craig-managed state

## Observability

Craig needs local observability rather than fleet telemetry.

- structured task records make current and historical state introspectable
- append-only task logs support `logs <id>` and post-failure diagnosis
- persisted runner-session metadata makes live execution resources inspectable without requiring Craig to understand vendor-internal chat state
- command results should emit concise terminal feedback and persist machine-readable summaries for checks and merge outcomes
- persisted PR status snapshots make CI and mergeability visible without forcing the user to query GitHub manually
- the boot banner color treatment provides an immediate visual confirmation that the user is inside Craig rather than a generic shell flow
- the interactive terminal control surface should make task state, execution visibility, review readiness, file-change visibility, and PR or CI visibility legible inside Craig
- a later `doctor` or `debug` command is reasonable, but not required for Phase 1

Manual success indicators for early implementation:

- time from task creation to runner launch
- time from runner-complete to review-ready
- successful idea-to-merge runs without manual shell intervention
- cleanup success rate for completed tasks
- runner integrations remain thin and do not override the normal behavior model of the underlying CLI tools

## Rollout plan

### Phase 1: Cursor repo-task workflow vertical slice

#### 1.1 Bootstrap CLI shell, shared control-plane services, and interactive terminal foundation

Deliver a `craig` executable that initializes `.craig/`, renders the boot experience, loads config, and dispatches shared control-plane services from both the minimal interactive shell and command mode.

#### 1.2 Repo task creation with worktree, branch, execution substrate, and Cursor launch

Deliver end-to-end task creation for repo tasks on Cursor, including task ids, branch creation, worktree provisioning, substrate-backed execution context creation, runner launch through the thin runner wrapper boundary, runner-session persistence, and durable task records.

#### 1.3 Task inspection, logs, diff, focus, and open flows

Deliver the command surface needed to observe and navigate active tasks without leaving Craig.

#### 1.4 Checks, commit, PR creation, CI tracking, merge, and cleanup

Deliver the rest of the developer loop so a user can go from generated code to opened PR, green CI, and merged change from inside Craig.

### Phase 2: Richer Craig terminal mission control

#### 2.1 Interactive terminal control-surface foundation

Stabilize Craig as the visible terminal control surface while using tmux-backed execution contexts underneath. This includes control-surface visibility, runtime metadata, and session layout improvements that support Craig-first interaction.

#### 2.2 Richer TUI navigation, status panels, and orchestration visibility

Add richer Craig TUI navigation and inspection panels so task selection, task details, logs, and task actions no longer depend on typed commands for every move.

#### 2.3 File, diff, and review workflows with stronger mission-control feel

Add changed-file navigation, diff-summary navigation, explicit `nvim` handoff from selected task or file context, stronger review workflows, and later MCP-facing integration points where appropriate.

tmux layout improvements may continue in Phase 2, but they are subordinate to Craig UX goals rather than the primary definition of the phase.

### Phase 3: Codex vertical slice

#### 3.1 Codex runner adapter on the same task model

Add a Codex runner adapter with the same task lifecycle, runner-session boundary, artifact model, and command behavior, validating that the thin runner wrapper is real.

### Phase 4: General tasks and jobs

#### 4.1 General tasks and scheduled jobs

Expand beyond repo tasks into general tasks and recurring jobs while reusing the existing control-plane and artifact model where possible.

## Plan Mode handoff checklist and acceptance criteria

### 1.1 Handoff

#### Implementation

- Add a `craig` CLI entrypoint and boot sequence.
- Initialize `.craig/` and `index.json` on first run.
- Implement a shared command-dispatch layer used by the minimal interactive shell and command mode.
- Render the boot banner in slime-green or matrix-green terminal styling, include the `crAIg is that you?` easter egg line, and include the current workspace summary.
- Define the base task record schema and atomic JSON write helpers.

#### Verification

- Run unit coverage for state initialization and command dispatch.
- Manually verify `craig` launches into the interactive shell in a repo without `.craig/`.
- Manually verify `craig task list` and `list` both hit the same logic path.

#### Tracking update

- Mark `1.1` implemented and verified only after the CLI entrypoint, state initialization, and shared dispatch are all working.
- If banner rendering lands without shared dispatch, leave `1.1` in progress and note the gap.

### 1.2 Handoff

#### Implementation

- Implement task-id allocation and repo-task creation flow.
- Create git worktrees and `craig/<task-id>` branches.
- Create or attach tmux-backed execution contexts.
- Implement the Cursor runner adapter and `cursor agent` launch flow through the thin runner wrapper boundary.
- Persist worktree path, branch, substrate metadata, runner metadata, and runner-session metadata into the task record.

#### Verification

- Run automated tests around task-id allocation and task record persistence.
- Manually run `new <task>` in pane-first substrate mode.
- Verify the worktree exists, the branch is checked out, the execution context is live, Cursor starts in the correct directory, and Craig persists enough runner-session metadata to identify the launched Cursor process.

#### Tracking update

- Mark `1.2` verified only when task creation works end to end from Craig command to live Cursor session.
- Record that `1.2` is substrate-backed and note any known limitations around session layout assumptions or Cursor startup assumptions explicitly.

### 1.3 Handoff

#### Implementation

- Implement `list`, `show`, `logs`, `diff`, `focus`, and `open`.
- Add log streaming or tailing support from Craig-managed log files.
- Add git diff inspection for task worktrees.
- Surface lifecycle status, runner metadata, and recent check state in `show`.

#### Verification

- Run automated coverage for task lookup and diff and log command behavior.
- Manually verify a running task can be inspected from a separate Craig session.
- Confirm `focus <id>` targets the correct execution context and `open <id>` resolves the worktree path.

#### Tracking update

- Keep `1.3` open if any core inspection command exists only in the interactive shell or only in command mode.
- Note any log-streaming limitations or diff edge cases found during verification.

### 1.4 Handoff

#### Implementation

- Implement `check`, `commit`, `pr`, and `merge`.
- Read `check <id>` commands from `.craig/config.json` and fail clearly when no checks are configured.
- Implement PR creation and PR status refresh through GitHub CLI.
- Persist check summaries and PR artifacts under `.craig/artifacts/`.
- Add merge-state tracking and post-merge cleanup.
- Prevent invalid transitions such as merge before green required checks, PR creation before commit, or commit with no diff, unless explicitly overridden.

#### Verification

- Run automated coverage for lifecycle transitions, check execution, PR status persistence, and merge gating.
- Manually execute the full flow from `new <task>` to `pr <id> --watch` to `merge <id>` on a small repo change.
- Confirm merged tasks are marked `merged` and cleanup status is recorded accurately.

#### Tracking update

- Mark Phase 1 complete only when the full idea-to-merge workflow works without ad hoc shell steps.
- Record any intentionally deferred merge-strategy or cleanup behaviors before advancing to Phase 2.

### 2.1 Handoff

#### Implementation

- Stabilize the terminal control-surface foundation.
- Keep Craig visible while runners execute in substrate-backed sessions.
- Persist runtime and session metadata.
- Keep command mode and scripting surfaces intact.
- Establish the three-zone layout foundation: task navigator on the left, active work surface in the middle, context surface on the right.
- Ensure the middle work surface remains Craig-controlled by default rather than collapsing back into a raw task terminal.

#### Verification

- Run the current automated coverage around control-surface foundation behavior.
- Manually verify the interactive terminal control surface, three-zone layout foundation, and Craig-controlled default work-surface behavior together with live execution.

#### Tracking update

- Keep `2.1` open until the revised three-zone layout foundation lands, the middle work surface stays Craig-controlled by default, and live interactive verification passes.

### 2.2 Handoff

#### Implementation

- Add richer TUI panels for tasks, an active middle work surface, and a right-hand context surface with selected-task summary plus stable tabs for logs, diff summary, changed files, and review details.
- Implement the keyboard interaction contract from the UI section, including list selection, panel switching, filtering, per-view shortcuts, middle-surface command bar behavior, and inline action mode.
- Add task navigation that does not depend on typed commands for every move.
- Preserve user orientation across refreshes by keeping the selected task, work-surface mode, and active context tab stable whenever that state is still valid.
- Make the default state low-friction: restore the last selected task, last work-surface mode, and last active context tab when they are still valid; otherwise preselect the highest-priority non-terminal task using the documented lifecycle ordering, with the next action visible and no required setup clicks or transient prompts.
- Keep visual distraction low by avoiding unnecessary redraws, moving focus only on explicit user action, and limiting simultaneous status motion.
- Add a compact always-visible action hint area so common actions are discoverable without opening a modal help sheet.
- Ensure the TUI remains fast enough that keyboard navigation feels immediate on repos with many tasks; sluggishness is a UX failure for this phase.
- Make the middle work surface feel like the place work happens: command entry, task actions, and intentional attach behavior should all originate there.
- Enter attach mode only through an explicit action or command, and provide a Craig-owned detach chord that returns the user to the prior work-surface mode and context for the same task.

#### Verification

- Run UI-level or renderer-level coverage where practical.
- Manually validate the richer interactive terminal experience against the documented keyboard model.
- Manually validate that navigation, refresh behavior, and selection persistence feel calm and predictable during active task updates.
- Manually validate that the middle work surface feels like the primary working area rather than a decorative prompt.
- Manually validate restore precedence on startup: previous selection, work-surface mode, and context tab win when still valid, otherwise the documented lifecycle ranking wins without selection jumps.
- Manually validate inline action mode and explicit attach-entry/detach behavior.

#### Tracking update

- Keep `2.2` open if the richer UI regresses scriptability, breaks the documented keyboard model, or hides critical state.

### 2.3 Handoff

#### Implementation

- Add changed-file navigation.
- Add diff-summary navigation.
- Add explicit `nvim` handoff from selected task or file context.
- Add stronger review and mission-control workflows.
- Call out later MCP-facing follow-ons explicitly instead of implying they are already in scope.
- Make file and diff drill-down one or two keystrokes from the selected task rather than a multi-step workflow.
- Keep review flow linear: task selection -> diff or files or review state -> open in `nvim` or take next action, without bouncing the user through unrelated panels.
- Ensure returning from `nvim` drops the user back into the same selected task and same review context when practical.
- Ensure attach-mode detach and `nvim` handoff both return the user to the middle work surface and preserved context instead of dropping them into a disconnected shell state.

#### Verification

- Manually validate the review workflow.
- Manually validate file-navigation and `nvim` handoff flows.
- Manually validate that moving from task list to diff or files to `nvim` and back feels continuous rather than like switching between separate tools.
- Manually validate that moving between middle work surface, attach mode, and `nvim` handoff preserves orientation and does not feel like leaving Craig accidentally.

#### Tracking update

- Keep `2.3` open until Craig supports review and file-inspection flows without forcing users back to ad hoc shell navigation.

### 3.1 Handoff

#### Implementation

- Add a Codex runner adapter using the existing task model, lifecycle hooks, and runner-session boundary.
- Reuse the same worktree, substrate, and artifact infrastructure.
- Add runner selection config and CLI affordances where needed.

#### Verification

- Run adapter-level tests for launch and status handling.
- Manually verify one repo task completes on Codex with the same inspect, check, and commit flow.

#### Tracking update

- Keep `3.1` blocked if Codex requires lifecycle exceptions that would weaken the shared runner contract.

### 4.1 Handoff

#### Implementation

- Add general-task and job schemas.
- Implement job definitions and scheduled execution triggers.
- Extend artifact handling for non-repo outputs.

#### Verification

- Run automated coverage for schedule parsing and job persistence.
- Manually verify at least one scheduled workflow produces a durable artifact.

#### Tracking update

- Record which existing repo-task assumptions had to be relaxed before marking this sub-phase complete.

### Acceptance criteria

- `[1.1]` Running `craig` in a repo initializes local Craig state and enters a working interactive shell.
- `[1.1]` Interactive commands and command-mode invocations share the same underlying control-plane services.
- `[1.2]` `new <task>` creates a durable task record, a git worktree, a `craig/<task-id>` branch, a persistent execution context, and launches Cursor in that context.
- `[1.2]` Craig persists enough runner-session metadata to identify and inspect the launched Cursor agent.
- `[1.3]` Users can inspect task status, logs, diffs, and execution focus for active tasks from Craig commands alone.
- `[1.4]` Users can run configured checks, commit changes, open a PR, inspect or watch required CI status, merge, and clean up without falling back to ad hoc shell scripts for the normal flow.
- `[1.4]` `merge <id>` performs the actual GitHub merge only after Craig verifies the tracked PR is mergeable and all required remote checks are green.
- `[2.1]` Craig remains the visible terminal control surface while execution contexts stay persistent underneath.
- `[2.1]` Craig establishes a three-zone layout with task navigation on the left, active work surface in the middle, and context on the right.
- `[2.1]` The middle work surface remains Craig-controlled by default instead of dropping the user into a raw task terminal implicitly.
- `[2.2]` Craig exposes richer task and orchestration visibility through a TUI-style control surface that matches the documented panel and keyboard model.
- `[2.2]` Craig navigation and refresh behavior feel immediate, stable, and low-distraction during active task updates.
- `[2.2]` Craig restores the prior task selection, work-surface mode, and active context tab when that state is still valid and otherwise falls back to the documented non-terminal task ranking.
- `[2.2]` Task actions live in the middle work surface, while the right-hand context surface keeps stable tabs for logs, diff, files, and review.
- `[2.2]` The middle work surface is the primary place the user types to Craig, triggers actions, and stays oriented while working on the selected task.
- `[2.2]` Attach mode is entered only through an explicit action or command and detaches back to Craig through a documented chord.
- `[2.3]` Craig supports file, diff, and review navigation with explicit `nvim` handoff and a stronger mission-control flow.
- `[2.3]` Moving from selected task to diff or files to `nvim` and back preserves user orientation instead of forcing repeated context rebuilding.
- `[2.3]` Explicit attach mode and `nvim` handoff both return the user to the same selected task and middle work surface context when practical.
- `[3.1]` Adding Codex does not require a second task model, a separate lifecycle implementation, or a different runner-session boundary.
- `[3.x+]` Future vendor additions do not require a second control-plane lifecycle or a separate task model.
- `[4.1]` Craig can run at least one non-repo scheduled workflow that produces a durable artifact.
