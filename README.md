# Craig

Craig is a local control plane for repo-backed agent work.

This repo now implements RFC phase `2.1` with automated verification complete. Live manual verification is still pending for the GitHub-backed `1.4` flow and the tmux-backed `2.1` control surface.

## Current status

Implemented in `1.1`:

- `craig` interactive boot flow
- `.craig/` state initialization
- atomic `.craig/index.json` creation
- green boot banner with workspace summary
- REPL commands: `list`, `help`, `exit`
- command mode: `craig task list`
- shared command routing for REPL and command mode

Implemented in `1.2`:

- `new <task>` in the REPL
- `craig task new "<task>"` in command mode
- durable task records under `.craig/tasks/`
- git worktree creation on `craig/<task-id>` from `main`
- tmux pane provisioning in session `craig`
- thin `cursor agent` runner launch wrapper
- runner-session metadata persisted in each task record

Implemented in `1.3`:

- `show <id>`, `logs <id>`, `diff <id>`, `focus <id>`, and `open <id>` in the REPL
- `craig task show|logs|diff|focus|open <id>` in command mode
- task inspection output with lifecycle, runner, branch, worktree, tmux, check, and PR metadata
- Craig-managed log streaming via local `tail`
- worktree diff inspection for active tasks
- tmux focus handoff for existing tasks
- optional `open.command` config with path-print fallback when unset

Implemented in `1.4`:

- `check <id>`, `commit <id>`, `pr <id>`, and `merge <id>` in the REPL
- `craig task check|commit|pr|merge <id>` in command mode
- persistent check results, commit metadata, PR metadata, and cleanup state in task records
- GitHub CLI-backed PR creation, PR refresh, CI watch, and merge support
- post-merge cleanup with optional `--preserve-worktree`
- `show <id>` live PR refresh for tracked tasks

Implemented in `2.1`:

- `craig` now prefers a Craig-owned full-screen terminal control surface in interactive mode
- the interactive surface renders a three-zone layout with task list, Craig command surface, and selected-task context
- the middle work surface stays Craig-controlled by default and reuses the existing command parser and service layer
- Craig persists UI runtime state in `.craig/runtime/session.json` when tmux session metadata exists
- `logs <id>` temporarily suspends the full-screen surface and restores Craig afterward
- interactive mode falls back to the legacy prompt REPL automatically when the richer terminal surface cannot start

Still deferred:

- Codex and multi-runner support

## Requirements

- Node `22+`
- `pnpm`
- a git repository
- `gh` authenticated against GitHub for PR and merge flows

Craig currently requires a git repo because it uses the repo root as the control-plane boundary and stores local state under `.craig/` in that repo.

## Install

```bash
pnpm install
```

## Build

```bash
pnpm build
```

## Run

Start the interactive Craig control surface from the repo root:

```bash
pnpm start
```

Run command mode:

```bash
pnpm start -- task list
pnpm start -- task new "refactor auth"
pnpm start -- task show task_20260421_01
pnpm start -- task logs task_20260421_01
pnpm start -- task check task_20260421_01
pnpm start -- task pr task_20260421_01 --watch
```

You can also run the built CLI directly:

```bash
node dist/cli.js
node dist/cli.js task list
node dist/cli.js task new "refactor auth"
node dist/cli.js task diff task_20260421_01
node dist/cli.js task merge task_20260421_01 --preserve-worktree
```

## Commands

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
- `pr <id> [--watch]`
- `merge <id> [--preserve-worktree]`
- `help`
- `exit`

Command mode:

- `task new "<task>"`
- `task list`
- `task show <id>`
- `task logs <id>`
- `task diff <id>`
- `task focus <id>`
- `task open <id>`
- `task check <id>`
- `task commit <id>`
- `task pr <id> [--watch]`
- `task merge <id> [--preserve-worktree]`

## Config

Craig reads optional repo-local config from `.craig/config.json`.

`checks.commands` is an ordered list of shell commands. `check <id>` runs them in the task worktree.
`open.command` is an argv array. Craig appends the resolved task worktree path as the final argument.
`github.mergeMethod` defaults to `squash`, and `github.watchIntervalSeconds` defaults to `10`.

Example:

```json
{
  "checks": {
    "commands": ["pnpm test", "pnpm typecheck", "pnpm lint"]
  },
  "github": {
    "mergeMethod": "squash",
    "watchIntervalSeconds": 10
  },
  "open": {
    "command": ["code", "-n"]
  }
}
```

If `open.command` is unset, `open <id>` prints the resolved worktree path instead of launching a tool.

## Local state

On first run, Craig creates:

```text
.craig/
  index.json
  runtime/
  tasks/
  jobs/
  logs/
  artifacts/
  worktrees/
```

`index.json` tracks:

- repo root
- Craig schema version
- task ids
- job ids
- create/update timestamps

Per-task records under `.craig/tasks/` now track:

- branch and worktree paths
- tmux pane targets
- prompt source
- runner-session metadata
- check results
- last commit metadata
- PR status and cleanup metadata
- artifact paths

`.craig/runtime/session.json` tracks Craig session metadata plus persisted UI state such as the last selected task and recent control-surface output when a tmux-backed session has been created.

## Current limitations

- `logs <id>` depends on local `tail` for live follow behavior.
- `focus <id>` depends on tmux target state that Craig recorded during task creation.
- `open <id>` prints the worktree path when no opener is configured.
- Full live manual verification of the GitHub-backed `pr --watch` to `merge` flow still depends on a locally authenticated `gh` session and a real repo remote.
- Full live manual verification of the new tmux-backed three-zone control surface is still pending.

## Development

Run the quality gates from the repo root:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Rebuild after source changes:

```bash
pnpm build
```

## RFC

The current implementation follows [docs/rfcs/2026-04-20-rfc-craig-control-plane.md](/Users/samhall/conductor/workspaces/craig/hanoi/docs/rfcs/2026-04-20-rfc-craig-control-plane.md), with `1.1` through `1.3` implemented and verified and `1.4` implemented with automated verification complete.
