# Craig

Craig is a local terminal control plane for repo-backed agent work.

## Install

```bash
npm install -g craig-cli
```

Craig requires Node 22 or newer.

## Setup

Run Craig from a git workspace:

```bash
cd path/to/your/repo
craig
```

Craig stores local workspace state under `.craig/` in the workspace where you run it. That state includes task records, worktrees, runtime UI state, logs, and review metadata.

## External Tools

Craig does not bundle agent CLIs. Install and authenticate the agent CLIs you want to use separately, such as Codex, Cursor, or Claude.

Craig also expects:

- `git` for workspace, branch, and worktree operations
- `gh` authenticated with GitHub for PR, check, and merge flows

## Commands

```bash
craig
craig repo add <path>
craig repo list
craig repo remove <repo-id>
craig workspace list
craig task new --repo <repo-id> "<task>"
craig task list
craig task show <task-id>
craig task logs <task-id>
craig task diff <task-id>
craig task check <task-id>
craig task pr <task-id> [--watch]
craig task merge <task-id> [--preserve-worktree]
```

## Configuration

Craig reads optional workspace-local config from `.craig/config.json`.

```json
{
  "runners": {
    "codex": { "enabled": true },
    "cursor": { "enabled": true },
    "claude": { "enabled": false }
  },
  "checks": {
    "commands": ["pnpm test", "pnpm typecheck", "pnpm lint"]
  },
  "github": {
    "mergeMethod": "squash",
    "watchIntervalSeconds": 10
  }
}
```
