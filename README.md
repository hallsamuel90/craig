# Craig

Craig is a local control plane for repo-backed agent work.

This repo is in rewrite phase `1.1`. Craig now boots into a mock `terminal-kit` workspace shell that establishes the new terminal-native layout and branding while command-mode scaffolding remains in place underneath it.

## Current status

- No-arg startup opens the new mock CRAIG shell with a boot overlay, pause overlay, and three-column workspace layout.
- Command mode remains available through `craig <command>`.
- Existing repo, workspace, task, and GitHub task actions remain as scaffolding for the rewrite.
- `tmux` may still be used by surviving non-interactive task/session commands during the rewrite transition.

## Requirements

- Node `22+`
- `pnpm`
- a git repository
- `gh` authenticated against GitHub for PR and merge flows
- `tmux`

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

Run Craig from the repo root:

```bash
pnpm start
```

No-arg startup now opens the phase `1.1` mock workspace shell. Command mode remains available:

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

Command mode:

- `repo add <path>`
- `repo list`
- `repo remove <repo-id>`
- `workspace list [--archived]`
- `workspace archive <workspace-id>`
- `workspace restore <workspace-id>`
- `task new --repo <repo-id> "<task>"`
- `task list`
- `task list --repo <repo-id>`
- `task show <task-id>`
- `task logs <task-id>`
- `task diff <task-id>`
- `task attach <task-id>`
- `task focus <task-id>`
- `task open <task-id>`
- `task check <task-id>`
- `task commit <task-id>`
- `task pr <task-id> [--watch]`
- `task merge <task-id> [--preserve-worktree]`
- `link add <task-id> <repo-id>`
- `link list <task-id>`

## Config

Craig reads optional repo-local config from `.craig/config.json`.

`checks.commands` is an ordered list of shell commands. `check <id>` runs them in the task worktree.
`runners.<id>.enabled` controls whether `codex`, `cursor`, or `claude` appears as a new-task runner. Disabled runners cannot be launched. If Codex is disabled, Craig defaults new tasks to the first enabled runner.
`runners.<id>.path` overrides the executable path for that runner while keeping the built-in default when unset.
`open.command` is an argv array. Craig appends the resolved task worktree path as the final argument.
`github.mergeMethod` defaults to `squash`, and `github.watchIntervalSeconds` defaults to `10`.

Example:

```json
{
  "runners": {
    "codex": { "enabled": false },
    "cursor": { "enabled": true, "path": "/Users/me/.cursor/bin/cursor-agent" },
    "claude": { "enabled": false }
  },
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

Per-task records under `.craig/tasks/` track:

- branch and worktree paths
- prompt source
- runner-session metadata
- check results
- last commit metadata
- PR status and cleanup metadata
- artifact paths

Per-session records under `.craig/sessions/` track surviving command-mode session metadata used by the pre-PTY scaffolding.

`.craig/runtime/ui-state.json` currently tracks lightweight selection state such as the selected repo, workspace, and task.

## Current limitations

- `logs <id>` depends on local `tail` for live follow behavior.
- `focus <id>` and `task attach <id>` still depend on the underlying tmux session being available locally.
- `open <id>` prints the worktree path when no opener is configured.
- The phase `1.1` shell is still mock-data driven and does not yet wire the visible workspace UI to real repo or task state.
- Full live manual verification of the GitHub-backed `pr --watch` to `merge` flow requires a locally authenticated `gh` session and a real repo remote.

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

The active rewrite plan lives in [docs/rfcs/2026-05-01-rfc-craig-terminal-workspace-rewrite.md](/Users/samhall/conductor/workspaces/craig/boston-v2/docs/rfcs/2026-05-01-rfc-craig-terminal-workspace-rewrite.md).
