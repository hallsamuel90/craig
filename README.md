# Craig

Craig is a local control plane for repo-backed agent work.

This repo currently implements RFC phase `1.1`: a bootstrap CLI that initializes local Craig state, renders the boot experience, starts a REPL, and supports shared command dispatch between interactive and command mode.

## Current status

Implemented in `1.1`:

- `craig` interactive boot flow
- `.craig/` state initialization
- atomic `.craig/index.json` creation
- green boot banner with workspace summary
- REPL commands: `list`, `help`, `exit`
- command mode: `craig task list`
- shared command routing for REPL and command mode

Not implemented yet:

- task creation
- worktrees and branches
- tmux integration
- Cursor launch
- checks, commit, PR, merge, cleanup

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
```

You can also run the built CLI directly:

```bash
node dist/cli.js
node dist/cli.js task list
```

## Commands

Interactive commands:

- `list`
- `help`
- `exit`

Command mode:

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

`index.json` is the first durable Craig state file and currently tracks:

- repo root
- Craig schema version
- task ids
- job ids
- create/update timestamps

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

The current implementation follows [docs/rfcs/2026-04-20-rfc-craig-control-plane.md](/Users/samhall/conductor/workspaces/craig/minsk/docs/rfcs/2026-04-20-rfc-craig-control-plane.md), specifically sub-phase `1.1`.
