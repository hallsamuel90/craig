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

[craig-cli.com](https://craig-cli.com) · [Docs](https://craig-cli.com/docs) · [Quickstart](https://craig-cli.com/docs/quickstart)

</div>

---

Craig is a full-screen TUI that lets you run multiple AI agents across multiple repos at the same time — each in its own isolated git worktree, each with a live PTY, all from one terminal. Spin up Claude, Codex, and Cursor simultaneously. Watch them cook. Inspect diffs and review state while the agent handles repo actions from its PTY.

It’s like a game, except the PRs are real.

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

1. Press `n` to create a task — type a short task description, pick a runner, press `Enter`.
2. Craig creates the task record, branch, worktree, and agent tab automatically.
3. Press `Enter` on the task to attach its live PTY. `Ctrl+]` to return to control mode.
4. Give the runner its instructions in the agent PTY. The task description is Craig metadata; it is not pasted into the runner automatically.
5. Use the **Files**, **Changes**, and read-only **Review** inspector panels to check the diff, PR state, checks, and comments.

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
  Esc           pause
  Tab, ]        next panel
  Shift+Tab, [  previous panel
  Up/Down, j/k  move selection
  PgUp/PgDn, Wheel  scroll focused inspection or terminal view
  z             zoom center panel
  n             new task
  q             quit

Navigation
  Left/Right, h/l  switch tabs or inspector mode

Tasks
  Enter on + New Task       open task prompt
  Enter on + New Workspace  open workspace browser
  Enter on task             attach selected task PTY
  r on + New Task           cycle runner for next task
  X on task                 close selected task
  X on workspace            remove selected workspace

Center panel
  Enter         attach PTY
  +             create preferred tab kind
  a             new agent tab
  t             new terminal tab
  r             cycle runner for next agent tab
  x             close tab

Review
  Enter         refresh status or close task, depending on selected action
  R             refresh read-only PR/check state
  o             open tracked PR URL
  X             close task record

Task prompt
  Ctrl+R        cycle runner
  Enter         create task
  Esc           cancel

Workspace browser
  Up/Down, j/k  move selection
  Right, l      open directory
  Left, h       parent directory
  Enter         add selected path
  Esc           cancel

Terminal mode
  Ctrl+]        return to control mode
  Wheel, PgUp/PgDn  scroll terminal
```

## Command mode

```bash
craig repo add <path>
craig repo list
craig repo remove <repo-id>

craig workspace add <path>
craig workspace list
craig workspace list --archived
craig workspace archive <workspace-id>
craig workspace restore <workspace-id>
craig workspace remove <workspace-id>

craig task new --repo <repo-id> [--runner codex|cursor|claude] "<task>"
craig task new --workspace <workspace-id> [--runner codex|cursor|claude] "<task>"
craig task list
craig task list --repo <repo-id>
craig task show <task-id>
craig task attach <task-id>
craig task focus <task-id>
craig task open <task-id>
craig task logs <task-id>
craig task diff <task-id>
craig task check <task-id>
craig task commit <task-id>

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
