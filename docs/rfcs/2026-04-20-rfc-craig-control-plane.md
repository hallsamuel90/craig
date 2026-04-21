# RFC: Craig Local Control Plane

- **Date:** 2026-04-20
- **Status:** In Flight
- **Author:** Codex

---

## Context and goals

Craig is a terminal-first local control plane for agent runners. It is not a model, chatbot, hosted system, or replacement for runner CLIs. In this RFC, Craig is the local system that coordinates repo-backed development work on top of Cursor CLI first and Codex CLI later.

The Phase 1 vertical slice matters because raw agent CLI workflows leave the full developer loop fragmented across shell history, ad hoc branch naming, manual worktree setup, separate terminal sessions, and one-off review and merge steps. The missing system is not prompt generation. The missing system is a local control plane that owns task lifecycle, execution context, durable state, and review-to-merge workflow.

This RFC solves the concrete repo-task workflow problems that currently create friction:

- task state is implicit in shell history and branch names
- long-running agent sessions are hard to monitor and resume
- diffs, logs, and review checkpoints are spread across terminals
- pull request state and CI status have to be tracked manually outside the task workflow
- worktree setup and cleanup are manual and error-prone
- idea-to-merged-code is not represented as one coherent system

Goals for this RFC:

- ship a local control plane for repo-backed development tasks on top of Cursor CLI
- make the full developer loop first-class: create, run, inspect, check, commit, prepare PR artifacts, merge, and clean up
- keep state filesystem-backed under `.craig/` with no database, server, or daemon in the initial architecture
- use tmux as the execution/session layer while keeping Craig, not tmux, as the source of truth for task state
- define a runner abstraction that supports Cursor first and Codex second without over-generalizing for unsupported runners
- keep the interactive REPL as the primary UX and command mode as a thin wrapper over the same application services

## Non-goals

- supporting Claude Code in this RFC
- building hosted sync, remote coordination, or multi-user state
- introducing a database, background daemon, or queueing system in the initial implementation
- solving general non-repo tasks or scheduled jobs in Phase 1
- shipping a rich TUI dashboard before the core repo-task loop works end to end
- abstracting every possible runner capability up front

---

## Proposal

### System model

Craig is a local CLI application with three layers:

1. Control plane: owns task lifecycle, job lifecycle, prompt templating, review flow, runner selection, and command dispatch.
2. Runner layer: owns adapter-specific launch behavior and capability declarations for Cursor CLI first and Codex later.
3. State layer: owns durable filesystem state under `.craig/`, including task records, job records, worktree metadata, logs, and generated artifacts.

The primary operating model is:

1. User starts `craig`.
2. Craig loads or initializes `.craig/index.json`.
3. User creates a repo task with `new <task>`.
4. Craig allocates a task id, creates a git worktree, creates branch `craig/<task-id>`, creates a tmux target, and launches the configured runner in that worktree.
5. The runner executes in an isolated terminal context while Craig records metadata and surfaces logs, diff status, review state, and next actions.
6. Craig provides first-class commands for `list`, `show`, `logs`, `diff`, `focus`, `open`, `check`, `commit`, `pr`, and `merge`.
7. `pr <id>` creates or updates the pull request via GitHub CLI, persists the PR number, URL, head/base refs, and latest CI summary into the task record, and can optionally stay attached until required checks complete.
8. `merge <id>` refreshes PR state, verifies the PR is mergeable and required checks are green, performs the merge via GitHub CLI, records the merge result, and cleans up the worktree unless the user explicitly preserves it.

Craig is interactive-first. Command mode exists for scripts and direct invocations, but it must call the same service layer and produce the same task-state side effects as the REPL.

### Control plane responsibilities

The control plane exposes application services such as:

- `createTask`
- `listTasks`
- `showTask`
- `streamLogs`
- `showDiff`
- `focusTask`
- `runChecks`
- `commitTask`
- `openPullRequest`
- `refreshPullRequestStatus`
- `mergeTask`
- `cleanupTask`

The control plane owns lifecycle transitions and state updates. It does not infer task readiness solely from git cleanliness or passing checks. Commands must update both the underlying system state and the durable Craig task record.

### Runner model

Runner adapters implement a deliberately narrow contract:

- `prepare(task, context)`
- `launch(task, context)`
- `status(task, context)`
- `stop(task, context)`
- `collectArtifacts(task, context)`

`context` includes repo root, worktree path, tmux target, environment variables, and optional prompt file paths.

Phase 1 includes only the Cursor adapter. Phase 2 adds Codex on the same task model. The interface is shaped by what Cursor and planned Codex integration both need, not by hypothetical future runners. Craig owns task lifecycle and state transitions; runners report launch success, exit status, and capability metadata.

Runner abstraction decisions:

- the runner layer must stay as light as possible and should not add heavy orchestration logic on top of model CLIs
- Craig should launch model CLIs in the right directory, with the right environment and session context, then let them behave as intended
- adapters should translate Craig task context into CLI invocation details, not re-implement agent behavior, prompt semantics, planning models, or review logic that already belongs to the underlying CLI
- if a capability requires deep CLI-specific behavior that cannot fit the narrow adapter contract cleanly, Craig should prefer exposing that limitation over growing a heavy abstraction layer

### State model and filesystem layout

Craig stores durable local state under:

```text
.craig/
  index.json
  config.json
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

- `.craig/` is the only Craig-owned durable state root
- `index.json` is a lightweight registry for task ids, job ids, and path references
- per-task JSON files are authoritative for task details to avoid large index rewrites
- logs are append-only text files
- artifacts have stable paths so `pr` and `check` can update them idempotently
- worktrees should live under `.craig/worktrees/` when git supports that layout cleanly; if git requires or benefits from an external path, the resolved path must be stored explicitly in the task record
- JSON writes should be atomic to prevent corruption on interruption

### Task lifecycle

Craig owns this repo-task lifecycle:

`draft -> running -> review -> checked -> pr_open -> merge_ready -> merged`

Lifecycle decisions:

- `draft` exists for newly created or partially provisioned tasks that are not yet actively running
- `running` means the runner session is provisioned and Craig considers the task active
- `review` means the task has code changes ready for inspection
- `checked` means Craig has completed configured checks and persisted their results
- `pr_open` means Craig has created or attached a pull request and is tracking remote review and CI state for the task
- `merge_ready` means the tracked pull request is mergeable and all required remote checks are green
- `merged` means the merge succeeded even if cleanup later reports warnings

Lifecycle transition decisions:

- task creation failure returns the task to `draft` with a recorded failure reason; Phase 1 does not introduce a separate failure status
- `commit <id>` is allowed only from `review` or `checked`
- `pr <id>` is allowed only from `checked` and transitions the task to `pr_open` after the PR is successfully created or attached
- Craig refreshes PR state during `show <id>`, `pr <id> --watch`, and `merge <id>`; a task moves from `pr_open` to `merge_ready` only when the PR is mergeable and required remote checks are green
- `merge <id>` is allowed only from `merge_ready` and transitions to `merged` only after the underlying GitHub merge succeeds
- Craig must block invalid transitions by default, such as merge before checks, PR creation before commit, or commit with no diff, unless a later implementation explicitly adds override flags

### CLI surfaces

The primary interface is the `craig` REPL with these commands:

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

Command mode is secondary and mirrors the same operations:

- `craig task new "refactor auth"`
- `craig task list`
- `craig task check <id>`
- `craig task pr <id> --watch`
- `craig task merge <id>`

CLI surface decisions:

- REPL commands remain terse verbs because the REPL is the primary UX
- command mode uses namespaced forms for clarity in scripts
- both surfaces must call the same service layer
- task ids are Craig-generated and opaque; normal flow does not require the user to choose branch names
- `open <id>` opens the worktree in the user’s configured tool or prints the resolved path when no opener is configured
- `pr <id>` is the CLI-owned entrypoint for PR creation and PR status refresh; `pr <id> --watch` may remain attached and poll until required remote checks reach a terminal state
- `merge <id>` performs the actual merge through GitHub CLI after revalidating mergeability and required remote checks

The interactive boot flow should present Craig as a local control plane and render a boot sequence consistent with the product brief, including the ASCII banner and current workspace summary.

Boot experience decisions:

- the `CRAIG` ASCII art should render in slime-green or matrix-green terminal styling rather than default monochrome output
- the banner styling should work in common ANSI-capable terminals without requiring a custom font or truecolor-only features
- supporting text under the banner should stay visually subordinate to the green ASCII mark so the boot experience reads as one branded unit
- the banner support copy should include the easter egg line `crAIg is that you?`

### tmux execution model

Craig uses tmux as the execution/session layer and runs inside tmux session `craig`. Each task maps to exactly one tmux target.

Phase 1 must support:

- window mode: one task per tmux window
- pane mode: one task per pane in a managed layout

tmux decisions:

- Craig creates and focuses tmux targets as execution resources
- Craig does not treat tmux layout metadata as the source of truth for task state
- losing a pane title, renaming a window, or manually moving windows must not erase Craig task metadata
- `focus <id>` switches the user to the mapped tmux target

### Phase 1 developer workflow

Phase 1 must support this repo-task flow end to end:

1. create task id
2. create worktree
3. create branch
4. open tmux pane or window
5. run Cursor CLI in that context
6. monitor logs and agent progress
7. inspect diff
8. run checks
9. commit changes
10. open or update PR
11. wait for or inspect CI status
12. merge
13. clean up worktree and tmux resources

Craig should treat these steps as one connected system. Users should not need ad hoc shell scripting for the normal repo-task workflow.

### Deferred capabilities and explicit exclusions

Phase 1 is limited to repo tasks plus Cursor. The following remain deferred or excluded:

- Codex support is deferred to Phase 2 on the same runner boundary
- general tasks and scheduled jobs are deferred to Phase 3
- richer TUI and orchestration dashboards are deferred to Phase 4
- Claude Code is explicitly out of scope
- hosted services, daemons, remote sync, and database-backed state are out of scope

### Open questions

- What is the minimal stable Cursor invocation contract Craig can depend on across local environments?
- Should `commit <id>` synthesize commit messages from task artifacts, runner output, or user prompts by default?
- Which PR merge strategy should Craig default to when multiple GitHub merge methods are allowed for the repo?

## Implementation tracker

### Status summary

- `1.1` Bootstrap CLI shell, state store, and REPL scaffolding: `pending`
- `1.2` Repo task creation with worktree, branch, tmux, and Cursor launch: `pending`
- `1.3` Task inspection, logs, diff, and focus/open flows: `pending`
- `1.4` Checks, commit, PR creation, CI tracking, merge, and cleanup: `pending`
- `2.1` Codex runner adapter on the same task model: `pending`
- `3.1` General tasks and scheduled jobs: `pending`
- `4.1` Rich TUI and orchestration visibility: `pending`

### Verification summary

- No sub-phases verified yet.

### Next resume point

Resume at the first sub-phase that is not both implemented and verified. The current resume point is `1.1`. If a later session partially completes `1.1`, update this tracker and keep `1.1` as the resume point until both implementation and verification are complete.

### Deferred phases

- `2.1` Deferred until the Cursor vertical slice validates the shared runner boundary.
- `3.1` Deferred until repo tasks are end-to-end complete.
- `4.1` Deferred until the control plane is stable enough to justify richer UI investment.

### Phase execution and verification policy

Each sub-phase is complete only when:

- its in-scope implementation items are landed in a coherent state
- its required tests and evals pass
- covered end-to-end flows are exercised during tuning when applicable
- any out-of-scope failures are recorded explicitly in the tracker or handoff section

Every implementation session must resume from the first sub-phase that is not both implemented and verified. Skipped or intentionally deferred work must be recorded explicitly rather than implied.

## API and data model changes

The external API surface in Phase 1 is the CLI command contract. There is no network API in this RFC.

### CLI command contract

Interactive commands:

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

Command mode examples:

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
  "tmuxTarget": "craig:task_20260420_01",
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
- tmux target metadata
- prompt source metadata
- latest check summary metadata
- tracked pull request metadata
- artifact references
- creation and update timestamps

### Runner adapter contract

Runner adapters must implement:

- `prepare(task, context)`
- `launch(task, context)`
- `status(task, context)`
- `stop(task, context)`
- `collectArtifacts(task, context)`

### State directory contract

Craig introduces:

- `.craig/index.json`
- `.craig/tasks/<task-id>.json`
- `.craig/jobs/<job-id>.json`
- `.craig/logs/<task-id>.log`
- `.craig/artifacts/<task-id>/...`
- `.craig/worktrees/<task-id>/...` or a resolved external path recorded in the task record

### Check execution contract

Phase 1 check commands come from Craig repo configuration.

- `.craig/config.json` may define an ordered list of shell commands under a repo-level `checks.commands` key
- `check <id>` runs exactly that ordered list inside the task worktree and persists command, exit code, start/end times, and aggregate status
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

## Edge cases and failure modes

- git worktree creation fails because of dirty or incompatible repo state: Craig stops task creation, records the failure, and leaves no partial task marked as running
- branch creation collides with an existing `craig/<task-id>` reference: Craig allocates a new task id and retries before surfacing failure
- tmux is unavailable or the `craig` session cannot be created: Craig fails fast with a prerequisite error
- Cursor launch fails after worktree creation: Craig marks the task `draft`, records the failure reason, and keeps the worktree available for inspection
- log streaming encounters truncation or rotation: Craig treats Craig-managed logs as append-only and surfaces any mismatch as an operator-visible error
- checks pass but the diff is empty: Craig blocks `commit` and `pr` by default
- the user manually edits or deletes the worktree: Craig detects the mismatch during `show`, `check`, `commit`, and `merge` and surfaces repair guidance
- PR creation succeeds but local artifact persistence fails: Craig warns immediately, re-syncs PR state on the next `show`, `pr`, or `merge`, and does not assume the local record is complete until the resync succeeds
- remote CI reports a failing or missing required check: Craig keeps the task in `pr_open`, surfaces the failing check names, and blocks `merge <id>`
- GitHub marks the PR unmergeable because the branch is behind or has conflicts: Craig surfaces the reason, keeps the task out of `merge_ready`, and requires the user to update the branch before retrying merge
- merge succeeds but cleanup fails: Craig records the task as `merged` with a cleanup warning instead of downgrading merge state

## Security and privacy

Craig is local-only, but it still manages potentially sensitive code, prompts, and command output.

- all state remains on the local filesystem by default
- no background telemetry or hosted sync is introduced in this RFC
- logs may contain prompts, code snippets, and command output, so Craig should rely on user-default filesystem permissions and avoid accidental world-readable writes
- PR artifacts are generated locally and are not transmitted automatically
- GitHub CLI authentication and PR metadata access should use the user’s existing local auth context and avoid storing tokens inside `.craig/`
- runner adapters should pass through only the environment variables they need rather than inheriting an unconstrained environment by default

## Observability

Craig needs local observability rather than fleet telemetry.

- structured task records make current and historical state introspectable
- append-only task logs support `logs <id>` and post-failure diagnosis
- command results should emit concise terminal feedback and persist machine-readable summaries for checks and merge outcomes
- persisted PR status snapshots make CI and mergeability visible without forcing the user to query GitHub manually
- the boot banner color treatment provides an immediate visual confirmation that the user is inside Craig rather than a generic shell flow
- a later `doctor` or `debug` command is reasonable, but not required for Phase 1

Manual success indicators for early implementation:

- time from task creation to runner launch
- time from runner-complete to review-ready
- successful idea-to-merge runs without manual shell intervention
- cleanup success rate for completed tasks
- runner integrations remain thin and do not override the normal behavior model of the underlying CLI tools

## Rollout plan

### Phase 1: Cursor dev workflow vertical slice

#### 1.1 Bootstrap CLI shell, state store, and REPL scaffolding

Deliver a `craig` executable that initializes `.craig/`, renders the boot experience, loads config, and dispatches shared control-plane services from both REPL and command mode.

#### 1.2 Repo task creation with worktree, branch, tmux, and Cursor launch

Deliver end-to-end task creation for repo tasks on Cursor, including task ids, branch creation, worktree provisioning, tmux target creation, runner launch, and durable task records.

#### 1.3 Task inspection, logs, diff, and focus/open flows

Deliver the command surface needed to observe and navigate active tasks without leaving Craig.

#### 1.4 Checks, commit, PR creation, CI tracking, merge, and cleanup

Deliver the rest of the developer loop so a user can go from generated code to opened PR, green CI, and merged change from inside Craig.

### Phase 2: Codex vertical slice

#### 2.1 Codex runner adapter on the same task model

Add a Codex runner adapter with the same task lifecycle, artifact model, and command behavior, validating that the runner boundary is real.

### Phase 3: General tasks and jobs

#### 3.1 General tasks and scheduled jobs

Expand beyond repo tasks into general tasks and recurring jobs while reusing the existing control-plane and artifact model where possible.

### Phase 4: Rich UX

#### 4.1 Rich TUI and orchestration visibility

Add richer dashboards, status panes, and orchestration views after the workflow model is proven.

Later phases may add prompt templating, richer artifact browsers, policy hooks for checks and merge strategy, and other UX improvements, but they do not change the Phase 1 requirement to prove the full Cursor-based repo-task workflow first.

## Plan Mode handoff checklist and acceptance criteria

### 1.1 Handoff

#### Implementation

- Add a `craig` CLI entrypoint and boot sequence.
- Initialize `.craig/` and `index.json` on first run.
- Implement a shared command-dispatch layer used by REPL and command mode.
- Render the boot banner in slime-green or matrix-green terminal styling, include the `crAIg is that you?` easter egg line, and include the current workspace summary.
- Define the base task record schema and atomic JSON write helpers.

#### Verification

- Run unit coverage for state initialization and command dispatch.
- Manually verify `craig` launches into the REPL in a repo without `.craig/`.
- Manually verify `craig task list` and `list` both hit the same logic path.

#### Tracking update

- Mark `1.1` implemented and verified only after the CLI entrypoint, state initialization, and shared dispatch are all working.
- If banner rendering lands without shared dispatch, leave `1.1` in progress and note the gap.

### 1.2 Handoff

#### Implementation

- Implement task-id allocation and repo-task creation flow.
- Create git worktrees and `craig/<task-id>` branches.
- Create or attach tmux session `craig` and provision window or pane targets.
- Implement the Cursor runner adapter and launch flow.
- Persist worktree path, branch, tmux target, and runner metadata into the task record.

#### Verification

- Run automated tests around task-id allocation and task record persistence.
- Manually run `new <task>` in both window and pane modes.
- Verify the worktree exists, the branch is checked out, the tmux target is live, and Cursor starts in the correct directory.

#### Tracking update

- Mark `1.2` verified only when task creation works end to end from Craig command to live Cursor session.
- Record any known limitations around tmux layouts or Cursor startup assumptions explicitly.

### 1.3 Handoff

#### Implementation

- Implement `list`, `show`, `logs`, `diff`, `focus`, and `open`.
- Add log streaming or tailing support from Craig-managed log files.
- Add git diff inspection for task worktrees.
- Surface lifecycle status, runner metadata, and recent check state in `show`.

#### Verification

- Run automated coverage for task lookup and diff/log command behavior.
- Manually verify a running task can be inspected from a separate Craig session.
- Confirm `focus <id>` targets the correct tmux window or pane and `open <id>` resolves the worktree path.

#### Tracking update

- Keep `1.3` open if any core inspection command exists only in REPL or only in command mode.
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

- Add a Codex runner adapter using the existing task model and lifecycle hooks.
- Reuse the same worktree, tmux, and artifact infrastructure.
- Add runner selection config and CLI affordances where needed.

#### Verification

- Run adapter-level tests for launch and status handling.
- Manually verify one repo task completes on Codex with the same inspect/check/commit flow.

#### Tracking update

- Keep `2.1` blocked if Codex requires lifecycle exceptions that would weaken the shared runner contract.

### 3.1 Handoff

#### Implementation

- Add general-task and job schemas.
- Implement job definitions and scheduled execution triggers.
- Extend artifact handling for non-repo outputs.

#### Verification

- Run automated coverage for schedule parsing and job persistence.
- Manually verify at least one scheduled workflow produces a durable artifact.

#### Tracking update

- Record which existing repo-task assumptions had to be relaxed before marking this sub-phase complete.

### 4.1 Handoff

#### Implementation

- Add richer TUI surfaces for task lists, detail views, and orchestration visibility.
- Keep the existing command surfaces functional for automation and fallback.

#### Verification

- Run UI-level tests where practical.
- Manually verify the TUI still supports the full Phase 1 flow without hiding critical state.

#### Tracking update

- Leave `4.1` pending if the richer UX reduces observability or scriptability relative to the REPL baseline.

### Acceptance criteria

- `[1.1]` Running `craig` in a repo initializes local Craig state and enters a working REPL.
- `[1.1]` REPL commands and command-mode invocations share the same underlying control-plane services.
- `[1.2]` `new <task>` creates a durable task record, a git worktree, a `craig/<task-id>` branch, a tmux target, and launches Cursor in that context.
- `[1.3]` Users can inspect task status, logs, diffs, and terminal focus for active tasks from Craig commands alone.
- `[1.4]` Users can run configured checks, commit changes, open a PR, inspect or watch required CI status, merge, and clean up without falling back to ad hoc shell scripts for the normal flow.
- `[1.4]` `merge <id>` performs the actual GitHub merge only after Craig verifies the tracked PR is mergeable and all required remote checks are green.
- `[2.1]` Adding Codex does not require a second task model or a separate lifecycle implementation.
- `[3.1]` Craig can run at least one non-repo scheduled workflow that produces a durable artifact.
- `[4.1]` A richer UX preserves the same task lifecycle, command semantics, and underlying control-plane model while exposing task and PR state more directly.
