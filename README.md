<div align="center">
<pre>
  ▄████▄   ██▀███   ▄▄▄       ██▓  ▄████
  ▒██▀ ▀█  ▓██ ▒ ██▒▒████▄    ▓██▒ ██▒ ▀█▒
  ▒▓█    ▄ ▓██ ░▄█ ▒▒██  ▀█▄  ▒██▒▒██░▄▄▄░
  ▒▓▓▄ ▄██▒▒██▀▀█▄  ░██▄▄▄▄██ ░██░░▓█  ██▓
  ▒ ▓███▀ ░░██▓ ▒██▒ ▓█   ▓██▒░██░░▒▓███▀▒
  ░ ░▒ ▒  ░░ ▒▓ ░▒▓░ ▒▒   ▓▒█░░▓   ░▒   ▒
    ░  ▒     ░▒ ░ ▒░  ▒   ▒▒ ░ ▒ ░  ░   ░
  ░          ░░   ░   ░   ▒    ▒ ░░ ░   ░
  ░ ░         ░           ░  ░ ░        ░

         crAIg is that you?

</pre>

**An agnostic agent orchestrator. For the people.**

[![npm](https://img.shields.io/npm/v/craig-cli)](https://www.npmjs.com/package/craig-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)

[craig.beer](https://craig.beer) · [Docs](https://craig.beer/docs) · [Quickstart](https://craig.beer/docs/quickstart)

</div>

---

Craig is a full-screen TUI that lets you run multiple AI agents across multiple repos at the same time — each in its own isolated git worktree, each with a live PTY, all from one terminal. Spin up Claude, Codex, and Cursor simultaneously. Watch them cook. Review diffs, run checks, and merge PRs without ever leaving Craig.

it's like a game, except the PRs are real.

## Install

```bash
npm install -g craig-cli
```

Requires Node 22+, `git`, and `gh` (authenticated). Bring your own agent CLI — Claude Code, Codex, or Cursor.

## Start

```bash
cd path/to/your/workspace
craig
```

The TUI opens with a boot overlay, then a three-panel workspace: task navigation on the left, live agent PTY in the center, file/diff/review inspector on the right.

Craig writes all local state under `.craig/` — worktrees, logs, task records, PR metadata. Don't commit it.

## Workflow

1. Press `n` to create a task — type a prompt, pick a runner, press `Enter`.
2. Craig creates the branch, worktree, and agent tab automatically.
3. Press `Enter` on the task to attach its live PTY. `Ctrl+]` to return to control mode.
4. Use the **Files**, **Changes**, and **Review** inspector panels to check the diff and CI status.
5. `craig task pr <task-id> --watch` — creates the PR and waits for checks before merging.

## Polyrepo support

Point Craig at a directory containing multiple repos and it treats them as a single workspace. Create a task once — Craig provisions a worktree for each repo and runs the agent across all of them in one pass.

```bash
cd path/to/your/projects   # contains repo-a/, repo-b/, repo-c/
craig
```

## TUI Keys

```
Global
  ?             help
  Esc           pause / back
  Tab, ]        next panel
  Shift+Tab, [  previous panel
  q             quit

Navigation
  Up/Down, j/k  move selection
  Left/Right, h/l  switch tabs or inspector mode

Tasks
  n             new task
  Enter         attach selected task PTY
  X             close selected task

Center panel
  Enter         attach PTY
  +             new tab
  a             new agent tab
  t             new terminal tab
  x             close tab
  z             zoom center panel

Review
  R             sync PR / refresh checks
  X             close task

Terminal mode
  Ctrl+]        return to control mode
  Wheel, PgUp/PgDn  scroll terminal
```

## Command mode

```bash
craig repo add <path>
craig repo list
craig repo remove <repo-id>

craig workspace list
craig workspace archive <workspace-id>
craig workspace restore <workspace-id>
craig workspace remove <workspace-id>

craig task new --repo <repo-id> [--runner codex|cursor|claude] "<task>"
craig task list
craig task show <task-id>
craig task attach <task-id>
craig task logs <task-id>
craig task diff <task-id>
craig task check <task-id>
craig task commit <task-id>
craig task pr <task-id> [--watch]
craig task merge <task-id> [--preserve-worktree]

craig link add <task-id> <repo-id>
craig link list <task-id>
```

## Config

Optional workspace-local config at `.craig/config.json`:

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
    "watchIntervalSeconds": 5
  }
}
```

## Contributing

Craig is open source under MIT, but not a community-maintained project. Bug reports and focused questions are welcome. PRs should be discussed with the maintainer first — unsolicited PRs may be closed without review.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm build:npm
pnpm package:audit
pnpm package:smoke
```

The npm package is published as `craig-cli` from `packages/cli`.
