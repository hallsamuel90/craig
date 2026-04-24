# Craig

Craig is a local control plane for repo-backed agent work.

This repo now ships an Ink-based interactive shell, hidden per-task tmux persistence, and a `node-pty` terminal bridge for embedded terminal mode. Automated verification is complete for the delivered shell and session contracts. Live manual verification is still pending for embedded terminal attach on a locally built `node-pty` binary and for the GitHub-backed PR-to-merge flow.

## Current status

- Ink owns the control-mode shell, overlay rendering, three-column layout, keyboard routing, and the compact/resize breakpoint behavior.
- `tmux` is hidden infrastructure only. Each Craig task now gets its own durable tmux session with one runner pane.
- `node-pty` owns terminal-mode IO by attaching a disposable tmux client for the selected task. The Craig detach chord is `Ctrl-]`.
- Command mode remains available through `craig <command>`.
- The legacy interactive REPL and the pre-banner startup path are gone.

## Requirements

- Node `22+`
- `pnpm`
- a git repository
- `gh` authenticated against GitHub for PR and merge flows
- `tmux`

Craig currently requires a git repo because it uses the repo root as the control-plane boundary and stores local state under `.craig/` in that repo.

`node-pty` is a native dependency. If your package manager skipped native build scripts, embedded terminal mode will not work until the dependency is built locally.

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

The interactive shell targets three viewport states:

- `full` at `>= 160x48`
- `compact` at `>= 120x36` and `< 160x48`
- resize overlay below `120x36`

Run command mode:

```bash
pnpm start -- task list
pnpm start -- task new --repo repo_app "refactor auth"
pnpm start -- task show task_20260421_01
pnpm start -- task logs task_20260421_01
pnpm start -- task check task_20260421_01
pnpm start -- task pr task_20260421_01 --watch
```

You can also run the built CLI directly:

```bash
node dist/cli.js
node dist/cli.js task list
node dist/cli.js task new --repo repo_app "refactor auth"
node dist/cli.js task diff task_20260421_01
node dist/cli.js task merge task_20260421_01 --preserve-worktree
```

## Commands

Interactive command bar:

- `repo add <path>`
- `repo list`
- `workspace list [--archived]`
- `task new --repo <repo-id> <prompt>`
- `task list [--repo <repo-id>]`
- `show [id]`
- `logs [id]`
- `diff [id]`
- `focus [id]`
- `open [id]`
- `check [id]`
- `commit [id]`
- `pr [id] [--watch]`
- `merge [id] [--preserve-worktree]`
- `refresh`
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
  repos/
  workspaces/
  sessions/
  runtime/
    ui-state.json
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
- prompt source
- runner-session metadata
- check results
- last commit metadata
- PR status and cleanup metadata
- artifact paths

Per-session records under `.craig/sessions/` now track the hidden tmux session name, pane target, attach metadata, lifecycle state, and last known terminal size.

`.craig/runtime/ui-state.json` tracks Craig UI state such as the selected repo, selected task, active surface, input mode, current context tab, command buffer, and recent command output.

## Current limitations

- `logs <id>` depends on local `tail` for live follow behavior.
- `focus <id>` and `task attach <id>` still depend on the underlying tmux session being available locally.
- `open <id>` prints the worktree path when no opener is configured.
- Embedded terminal mode requires a locally built `node-pty` binary. If install scripts were skipped, Craig will surface an explicit prerequisite error when you try to attach.
- Full live manual verification of the GitHub-backed `pr --watch` to `merge` flow requires a locally authenticated `gh` session and a real repo remote.
- Full live manual verification of the embedded terminal attach and detach flow still requires a real interactive terminal session.

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

The current implementation follows [docs/rfcs/2026-04-23-rfc-craig-multi-repo-control-plane.md](/Users/samhall/conductor/workspaces/craig/colombo/docs/rfcs/2026-04-23-rfc-craig-multi-repo-control-plane.md).
