# Craig

Craig is a local control plane for repo-backed agent work.

This repo currently implements verified RFC phase `1.3`: the `1.1` bootstrap CLI, `1.2` pane-based repo task creation on Cursor, and `1.3` inspection/navigation commands.

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

Not implemented yet:

- checks, commit, PR, merge, cleanup
- Codex and multi-runner support

## Requirements

- Node `22+`
- `pnpm`
- a git repository

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

Start the interactive REPL from the repo root:

```bash
pnpm start
```

Run command mode:

```bash
pnpm start -- task list
pnpm start -- task new "refactor auth"
pnpm start -- task show task_20260421_01
pnpm start -- task logs task_20260421_01
```

You can also run the built CLI directly:

```bash
node dist/cli.js
node dist/cli.js task list
node dist/cli.js task new "refactor auth"
node dist/cli.js task diff task_20260421_01
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

## Config

Craig reads optional repo-local config from `.craig/config.json`.

`open.command` is an argv array. Craig appends the resolved task worktree path as the final argument.

Example:

```json
{
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
- artifact paths

## Current limitations

- `logs <id>` depends on local `tail` for live follow behavior.
- `focus <id>` depends on tmux target state that Craig recorded during task creation.
- `open <id>` prints the worktree path when no opener is configured.
- The `1.4` workflow is still pending, so checks, commit, PR, merge, and cleanup are not available yet.

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

The current implementation follows [docs/rfcs/2026-04-20-rfc-craig-control-plane.md](/Users/samhall/conductor/workspaces/craig/buffalo-v1/docs/rfcs/2026-04-20-rfc-craig-control-plane.md), with `1.1`, `1.2`, and `1.3` implemented and verified.
