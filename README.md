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
  ░

         crAIg is that you?
</pre>
</div>

# Craig

Craig is a local terminal control plane for repo-backed agent work. The primary interface is the full-screen terminal UI launched with `craig`; command-mode entry points are available for automation and debugging.

## Install

```bash
npm install -g craig-cli
```

Craig requires Node 22 or newer.

External tools:

- `git` for repo, branch, and worktree operations
- `gh` authenticated with GitHub for PR, check, and merge flows
- an agent CLI such as Codex, Cursor, or Claude

## Start Craig

Run Craig from the workspace where you want `.craig/` state to live:

```bash
cd path/to/your/workspace
craig
```

The TUI opens with a boot overlay, then a workspace shell with task navigation, center work tabs, and an inspector panel.

Craig stores task records, worktrees, runtime UI state, logs, and review metadata under `.craig/`.

## TUI Workflow

1. Launch `craig`.
2. Add or select a workspace/repo from the left side. You can also pre-register one with `craig repo add <path>`.
3. Press `n` to create a task from the TUI.
4. Type the task prompt and press `Enter`.
5. Craig creates the branch, task worktree, and agent tab.
6. Press `Enter` on an agent or terminal tab to attach the live PTY.
7. Use `Ctrl+]` to return from terminal mode to Craig control mode.
8. Use the Files, Changes, and Review inspector modes to inspect work without leaving Craig.

## TUI Keys

```text
Global
  ?             help
  Esc           pause / back
  Tab, ]        next panel
  Shift+Tab, [  previous panel
  q             quit

Navigation
  Up/Down, j/k  move selection
  Left/Right,
  h/l           switch tabs or inspector mode

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
  Wheel,
  PgUp/PgDn     scroll terminal
```

## Command Mode

Use command mode when scripting, debugging, or working outside the TUI.

```bash
craig

craig repo add <path>
craig repo list
craig repo remove <repo-id>

craig workspace list
craig workspace list --archived
craig workspace archive <workspace-id>
craig workspace restore <workspace-id>

craig task new --repo <repo-id> [--runner codex|cursor|claude] "<task>"
craig task list
craig task list --repo <repo-id>
craig task show <task-id>
craig task attach <task-id>
craig task open <task-id>
craig task logs <task-id>
craig task diff <task-id>
craig task check <task-id>
craig task commit <task-id>
craig task pr <task-id> [--watch]
craig task merge <task-id> [--preserve-worktree]

craig link add <task-id> <repo-id>
craig link list <task-id>
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

`checks.commands` defines commands for `craig task check`. `runners.<id>` controls whether Codex, Cursor, or Claude appears as a task runner and can override that runner's executable path. Runner path changes apply to newly created task sessions.

## Local State

Craig writes local state under `.craig/`:

```text
.craig/
  artifacts/
  logs/
  runtime/
  tasks/
  workspaces/
  worktrees/
```

Treat `.craig/` as private developer state. It can contain task prompts, logs, local paths, PR metadata, and worktrees.

## License

Craig is proprietary software. All rights reserved.

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
