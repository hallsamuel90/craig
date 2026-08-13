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

**An agnostic orchestrator TUI, for the people.**

[![npm](https://img.shields.io/npm/v/craig-cli)](https://www.npmjs.com/package/craig-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/hallsamuel90/craig/blob/main/LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)

[Website](https://craig-cli.com) · [Quickstart](https://craig-cli.com/docs/quickstart/) · [Documentation](https://craig-cli.com/docs/) · [CLI reference](https://craig-cli.com/docs/cli/)

</div>

<a href="https://craig-cli.com">
  <img src="https://craig-cli.com/craig-agent.gif" alt="Craig running parallel coding agents in its terminal UI">
</a>

Craig gives every task its own Git branch, isolated worktree, and live PTY, then keeps the agents, changes, pull requests, and checks together in one keyboard-driven workspace.

Bring the agent CLIs you already use—Claude Code, Codex, or Cursor. Craig is not another coding agent; it is the heads-up display and controls around them.

_It's like a game, except the PRs are real._

## Why Craig?

- **Run agents in parallel.** Each task works in an isolated Git worktree, so one agent does not overwrite another.
- **Keep the native agent experience.** Every runner opens in a real PTY instead of a lowest-common-denominator chat wrapper.
- **Stay in flow.** Launch agents, move between tasks, inspect changes, and watch PR checks without leaving the keyboard.
- **Work across repositories.** Treat one repo or a directory of repos as a workspace while preserving real repository boundaries.
- **Let agents operate the workspace.** The same task model backs the TUI and CLI, so agents and scripts can inspect context and perform Craig actions directly.
- **Leave and come back.** A local daemon keeps agent sessions and PR synchronization alive when the foreground TUI closes.

## Install

```bash
npm install -g craig-cli
```

Craig requires Node.js 22+ and `git`. Install and authenticate at least one supported runner: Claude Code, Codex, or Cursor. Pull request discovery and review status also require an authenticated `gh` CLI.

## Quick start

```bash
cd path/to/your/project
craig
```

Then:

1. Press `n`, describe the task, and choose a runner.
2. Craig creates the branch, worktree, task record, and agent session.
3. Work with the agent in its PTY. Press `Ctrl+]` to return to Craig control mode.
4. Use **Files** and **Review** to inspect files and diffs, then follow the PR through checks and review.

For a project spread across several repositories, launch Craig from their parent directory. A project task gets a coordinated worktree bundle while each repository keeps its own branch and PR state.

Read the [Quickstart](https://craig-cli.com/docs/quickstart/) for the complete first-run walkthrough.

## Local by default

Craig stores workspace state, task records, worktrees, and runtime metadata under `.craig/` at the workspace root. Do not commit this directory; ignore `.craig/` when the workspace root is itself a Git repository. Craig does not require an account or hosted control plane. Your agent CLIs still use their own authentication and network services.

## Go deeper

- [TUI reference](https://craig-cli.com/docs/tui/) — layout, controls, and task navigation
- [Runners](https://craig-cli.com/docs/runners/) — Claude Code, Codex, and Cursor setup
- [CLI reference](https://craig-cli.com/docs/cli/) — commands for humans, scripts, and agents
- [Configuration](https://craig-cli.com/docs/config/) — runners, checks, GitHub polling, and previews
- [Agent orchestration](https://craig-cli.com/docs/orchestration/) — delegation, durable prompts, events, and Fury workflows

## Contributing

Craig is open source under the [MIT License](https://github.com/hallsamuel90/craig/blob/main/LICENSE), but it is not a community-maintained project. Bug reports and focused questions are welcome. Please read the [contribution guide](https://github.com/hallsamuel90/craig/blob/main/CONTRIBUTING.md) before proposing a change and report security issues through the [security policy](https://github.com/hallsamuel90/craig/blob/main/SECURITY.md).

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

The npm package is published as [`craig-cli`](https://www.npmjs.com/package/craig-cli) from `packages/cli`.
