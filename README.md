# Craig

Craig is a local control plane for repo-backed agent work.

This repo currently implements verified RFC phase `1.2`: the `1.1` bootstrap CLI plus pane-based repo task creation on Cursor.

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

Not implemented yet:

- checks, commit, PR, merge, cleanup
- task inspection commands beyond `list`
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
```

You can also run the built CLI directly:

```bash
node dist/cli.js
node dist/cli.js task list
node dist/cli.js task new "refactor auth"
```

## Commands

Interactive commands:

- `new <task>`
- `list`
- `help`
- `exit`

Command mode:

- `task new "<task>"`
- `task list`

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

The current implementation follows [docs/rfcs/2026-04-20-rfc-craig-control-plane.md](/Users/samhall/conductor/workspaces/craig/la-paz/docs/rfcs/2026-04-20-rfc-craig-control-plane.md), with `1.1` complete and `1.2` implemented in code.
