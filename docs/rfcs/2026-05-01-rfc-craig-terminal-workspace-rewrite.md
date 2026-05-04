# RFC: Craig Terminal Workspace Rewrite

- **Date:** 2026-05-01
- **Status:** In Flight
- **Author:** Sam / Codex
- **Supersedes:** 2026-04-23-rfc-craig-multi-repo-control-plane.md

---

## Context and goals

Craig should be rewritten as a keyboard-first terminal webapp rendered entirely inside the terminal. It is not a CLI-with-an-interactive-mode, not a REPL shell, and not a thin wrapper around `tmux`. The product is one full-screen terminal workspace that owns navigation, state, agent execution, inspection, and the review lifecycle.

The current codebase is built around an Ink shell, REPL-era command assumptions, and hidden `tmux` session management. That architecture no longer matches the intended product:

- the visible UX still reads as a command surface with embedded shell behavior instead of a cohesive terminal app
- execution and restore semantics depend on `tmux` concepts that should not define the user model
- layout and navigation are constrained by a React-for-TTY approach rather than a purpose-built terminal renderer
- the rewrite target is a workspace product, while the current structure still carries over CLI and bootstrap assumptions

This RFC makes the following product decisions explicit:

- Craig will render with `terminal-kit`, not Ink
- Craig will present one Craig-owned full-screen app from boot onward
- Craig will support only two input modes: Craig control mode and raw PTY terminal mode
- a task remains the primary execution unit and owns one repo, one worktree, one branch, one runner identity, and one or more PTY-backed runtime tabs
- the first rewrite milestone is visual and interaction fidelity, not backward compatibility with the old UI architecture
- GitHub-backed review flows can land after the workspace shell and real task model are stable

Goals for this RFC:

- establish a Craig-owned terminal application shell with a strong visual identity
- simplify the interaction model to explicit control mode versus terminal mode ownership
- model the product around workspace -> repos -> tasks, with task = worktree = execution unit
- preserve durable local state for repos, tasks, tabs, and session metadata
- make agent execution, file inspection, diff review, checks, and next actions feel like one product
- replace the existing UI architecture rather than layering another shell on top of it

## Non-goals

- preserving the current Ink component tree or REPL parser abstractions
- preserving `tmux` as either visible UX or required substrate
- shipping every GitHub PR and merge workflow in the first rewrite slice
- building a text editor inside Craig
- designing for mouse interaction or mixed input ownership
- maintaining compatibility with the prior phase numbering or tracker states
- broad runner abstraction work before the Codex-first flow is stable on the new shell

## Proposal

Craig becomes a terminal-native workspace application with a small number of product primitives and hard interaction rules.

### CRAIG identity

The CRAIG logo must be rendered exactly as:

```text
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
```

Identity rules locked by this RFC:

- the logo is centered horizontally
- the logo is rendered in green
- the subtitle is dimmer than the logo
- the logo treatment is reused in the boot screen and pause overlay

### Product model

- `workspace`: the Craig root and durable local state boundary
- `repo`: one registered source repository inside the workspace
- `task`: one execution unit bound to one repo, one worktree, one branch, and one runner identity
- `pty tab`: one task-scoped PTY-backed runtime surface such as an auto-booted `agent` tab or a plain `terminal` tab
- `surface`: one center-panel view such as `agent`, `files`, `diff`, `terminal`, or `logs`
- `overlay`: one full-screen Craig-owned modal state such as boot, pause, or resize warning

### Interaction model

Craig supports exactly two input modes:

- `control` mode: Craig owns keyboard input and dispatches navigation or actions
- `terminal` mode: the selected PTY owns keyboard input until the Craig detach chord returns control

Rules:

- there is no REPL
- there is no competing stdin consumer
- terminal mode exits on `Ctrl + ]`
- entering terminal mode is explicit and always task-scoped
- switching tabs does not implicitly change input ownership

### Screen model

Craig has two top-level UI states:

- overlay state for boot, pause, and resize blocking
- main workspace state for day-to-day execution and inspection

The overlay is a full-screen modal with:

- CRAIG logo
- subtitle
- caret-only menu
- dimmed background

The main workspace is a three-column layout:

- left: navigation
- center: workspace
- right: inspector

Layout rules:

- no gaps between panels
- left panel uses a grey block treatment
- center and right panels use near-black backgrounds
- center and right are separated by a thin divider
- the center panel is visually dominant
- a thin global status rail spans the top and carries workspace, task-count, agent, branch, version, and liveness context
- panel chrome should stay dense and understated rather than card-heavy or padded

The center surface supports these tabs:

- `Agent`
- `Files`
- `Diff`
- `Terminal`
- `Logs`
- file tabs created dynamically from file-open actions

The right inspector is organized into these sections:

- `Task`
- `Checks`
- `PR`
- `Setup / Run`
- `Actions`
- `Next action`

Actions render as rows, not button widgets.

### Visual direction

The provided Craig renderings and the Superset screenshot establish a clear interaction and density target:

- Craig should feel like a dense terminal-native control plane, not a spacious desktop app
- the left column should read as a stacked workspace and task tree with strong scanability for status
- the center panel should use a lightweight top tab strip and keep the active surface visually quiet
- the right panel should read like an always-available operational sidebar rather than a modal review flow
- status indicators should be sparse and legible: green for live or healthy, amber for pending, red only for failures or negative diff counts
- the overall shell should favor thin separators, restrained borders, and high information density over decorative framing
- Superset is a useful structural influence for panel hierarchy and review-side density, but Craig should keep its own terminal-first look and not inherit desktop-window affordances such as rounded cards, browser chrome, or large inactive gutters

### Visual references

Current visual references available in-repo:

- boot and pause overlay: `docs/rfcs/assets/craig-boot-overlay.png`
- main workspace shell: `docs/rfcs/assets/craig-control-plane-shell.png`

Additional references supplied in the session and now treated as implementation guidance:

- Craig shell variants covering agent, diff, terminal, files, and logs surfaces
- a Superset screenshot that reinforces the desired three-pane hierarchy and dense right-side review rail

The attached references are not durable repo assets, so the concrete takeaways are captured directly in this RFC:

- keep the top rail compact and always visible
- keep task rows dense and status-forward
- keep tabs flat and text-led
- keep the right inspector continuously visible during core workflows
- keep diff and file views inside the center workspace rather than turning them into separate full-screen modes

Additional durable repo references are still desirable for future polish work:

- a dedicated right-panel detail reference
- a dedicated diff or file-view reference produced from the chosen Craig direction

These references drive layout and feel, not pixel-perfect reproduction.

### Rewrite architecture

The rewrite should converge on six layers:

1. terminal app shell and screen compositor
2. input router and mode ownership
3. workspace, repo, and task state services
4. PTY session lifecycle and terminal rendering bridge
5. Git and worktree orchestration services
6. review and action services

Dependency direction stays one-way:

- UI depends on application services
- application services depend on state, PTY, and Git services
- PTY and Git services do not depend on UI
- state persistence does not depend on rendering details

### Session strategy

This rewrite removes `tmux` as an architectural requirement.

Session decisions:

- the active terminal experience is powered by `node-pty`
- each task may own multiple PTY-backed runtime tabs
- each PTY-backed runtime tab owns at most one live process-local PTY session at a time
- `agent` and `terminal` are distinct PTY-backed runtime tab kinds even though both render through the same terminal surface
- Craig stores enough session metadata to restore orientation after restart
- Craig may later introduce a persistence substrate for background survival, but that is not a prerequisite for the rewrite foundation
- the user model remains Craig session, never tmux session or pane

### State model

Craig persists workspace-local state under `.craig/`.

Required durable concerns:

- registered repos
- task records
- branch and worktree metadata
- selected repo and task
- selected PTY tab for the selected task when applicable
- active center tab
- open file tabs
- inspector selection state
- recent logs, check summaries, and review metadata when available

## Implementation tracker

### Status summary

- `0.1` Remove the old interactive architecture and leave a runnable placeholder shell: `implemented and verified`
- `1.1` Build the CRAIG overlay and three-column mock workspace shell in `terminal-kit`: `implemented and verified`
- `1.2` Add keyboard navigation, tab state, and explicit control-mode ownership on mock data: `implemented and verified`
- `2.1` Add PTY-backed terminal mode with explicit attach and `Ctrl + ]` detach: `implemented and verified`
- `2.2` Replace the PTY line buffer with a real xterm-style terminal emulator surface: `implemented and verified`
- `3.1` Replace mock repos and tasks with real repo, branch, worktree, persisted task state, and auto-booted Codex agent startup on create: `implemented and verified`
- `3.2` Restore selected task, tabs, inspector state, and selected PTY tab across restarts: `pending`
- `3.3` Add explicit multi-tab task runtime management on top of the multi-PTY task model: `pending`
- `4.1` Add files, diff, checks, and next-action inspection on top of the real task model: `pending`
- `4.2` Add PR-oriented review actions and GitHub CLI integration where available: `pending`

### Verification summary

- `0.1` Verified by removing the Ink renderer, REPL parser, and interactive-only runtime store; shrinking persisted UI state to command-mode selection metadata; removing `ink`, `react`, `ink-testing-library`, and `node-pty` from the package graph; and replacing no-arg startup with a placeholder message. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification passed by running the built CLI with no arguments and confirming it prints the phase `0.1` placeholder instead of opening the old shell.
- `1.1` Verified by replacing the phase `0.1` placeholder with a `terminal-kit` app entrypoint; rendering the CRAIG boot and pause overlays from the shared banner source; adding a three-column mock workspace shell with a top status rail, tab strip, and inspector sections; and keeping argv command mode intact for explicit commands. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification passed in a real TTY by running `node dist/cli.js`, confirming the boot overlay appears first, `Start` enters the shell, `Esc` opens the pause overlay, and `Exit` closes the app cleanly.
- `1.2` Verified by adding Craig-owned control-mode key routing for focus regions, mock task/action selection, center tab state, overlay actions, and non-destructive mock action feedback; deriving mock shell rendering from explicit shell state; and persisting restorable mock orientation fields in the workspace UI runtime state. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification passed in a real TTY by running `node dist/cli.js`, confirming boot Start enters the shell, `Tab`/`[`/`]` changes focus, arrow and Vim keys move selections, tabs change visible center content, `Enter` on actions shows placeholder feedback, `Esc` pauses/resumes, and `q` exits. No second stdin owner or keybinding conflict was observed during control mode.
- `2.1` Verified by adding a UI-only `node-pty` runtime that lazily spawns one process-local shell per selected mock task, derives PTY size from the center terminal surface, keeps PTY output in a bounded sanitized line buffer, forwards keys only while `inputMode` is `terminal`, intercepts `Ctrl + ]` to detach back to Craig control mode, disposes PTYs on app exit, and renders recoverable spawn errors in the Terminal tab. Automated verification covers reducer attach/detach transitions, selected task/tab preservation, PTY key mapping, output buffering, renderer terminal-mode states, startup option plumbing, app-level Enter aliases, and a real PTY E2E that launches Craig, enters terminal mode, and runs `echo craig_e2e_terminal_ok` through the shell. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed locally. Manual built-CLI verification also passed by launching `dist/cli.js` inside a real pseudo-terminal, pressing Enter into the Terminal tab, and observing `echo craig_dist_terminal_ok` render from the PTY. Native dependency note: `node-pty@1.1.0` failed to spawn on this macOS/Node 24 workspace with `posix_spawnp failed`; pinning `node-pty@0.10.1` and approving its build script resolved real PTY spawning.
- `2.2` Verified by adding an `@xterm/headless` emulator per process-local PTY session, feeding all PTY output into the emulator, resizing the emulator and PTY together, rendering styled emulator screen rows inside the center Terminal surface, and preserving the existing Craig control-mode versus terminal-mode ownership boundary. Follow-up hardening also makes reattach restart an exited PTY with a fresh shell and resolves each attached task shell to the recorded `worktreePath` when a task record exists, instead of always spawning in the workspace root. Automated verification covers SGR color cells, clear-screen behavior, carriage-return prompt redraw, cursor movement, wrapping, resize, styled renderer output, raw terminal-kit `unknown` Ctrl+] detach handling, detach/reattach session preservation, exited-session restart, exact task-worktree cwd resolution at spawn time, and a real PTY E2E that launches Craig, enters terminal mode, verifies the attached shell prompt is rooted in the selected task worktree, verifies color rendering, verifies `clear` removes prior visible terminal content, verifies cursor-addressed output, detaches with `Ctrl + ]`, re-enters the same live terminal surface, exits the shell process, and reattaches into a fresh shell successfully.
- `3.1` Verified by replacing mock shell repo/task fixtures with real `.craig` repo and task records at startup; reconciling shell selection against persisted repo, task, and PTY-tab ids; adding a minimal in-shell task prompt flow; provisioning new tasks through real branch and worktree creation; persisting default `agent` and `terminal` PTY tab metadata on each task; auto-selecting the created task; and immediately booting the initial Codex agent PTY tab in that task worktree. Automated verification covers control-state resolution on real ids, renderer output on real task context, PTY runtime tab-keyed session reuse, app-level terminal attach on real task selection, app-level create-task auto-bootstrap into the `agent` PTY tab, command-mode task creation compatibility, and a real PTY E2E rooted in a persisted task worktree. `pnpm test`, `pnpm typecheck`, and `pnpm lint` passed locally.
- `3.2` Not yet verified.
- `3.3` Not yet verified.
- `4.1` Not yet verified.
- `4.2` Not yet verified.

### Next resume point

Resume at the first sub-phase that is not both implemented and verified. The current resume point is `3.2`, which restores selected repo, task, center-tab, inspector, and PTY-tab orientation safely across restart now that the shell is running on real repo/task state and task creation auto-boots the initial Codex agent tab.

### Deferred phases

- background session persistence beyond the local Craig process is deferred until the PTY-based shell and task model are stable
- multi-runner expansion beyond Codex is deferred until the new workspace shell and task lifecycle are proven

### Phase execution and verification policy

Each sub-phase is complete only when:

- its in-scope implementation items are landed coherently on the rewrite architecture
- automated tests covering the changed contracts pass
- any relevant end-to-end terminal flows for that sub-phase are exercised manually
- out-of-scope breakage and deferred follow-up work are recorded explicitly in this tracker

Every implementation session must resume from the first sub-phase that is not both implemented and verified. When a session advances or verifies a sub-phase, this RFC's status summary, verification summary, and next resume point must all be updated in the same change.

## API and data model changes

There is no network API in this RFC. The external contract is the Craig binary, the full-screen terminal UI, and the workspace-local state it manages.

### CLI contract

The rewrite keeps command-mode entry points for automation and debugging, but interactive startup must land in the Craig-owned shell rather than a REPL.

Expected command surface after the rewrite stabilizes:

- `craig`
- `craig repo add <path>`
- `craig repo list`
- `craig task new --repo <repo-id> "<prompt>"`
- `craig task list [--repo <repo-id>]`
- `craig task open <task-id>`
- `craig task diff <task-id>`
- `craig task attach <task-id>`
- `craig task check <task-id>`
- `craig task pr <task-id>`

This command surface is subordinate to the application model. Services should not depend on a REPL parser shape.

### Core record contracts

Representative task record:

```json
{
  "id": "task_20260501_01",
  "repoId": "repo_app",
  "title": "rewrite the workspace shell",
  "branch": "craig/workspace-shell",
  "worktreePath": "/workspace/.craig/worktrees/repo_app/task_20260501_01",
  "runner": "codex",
  "selectedPtyTabId": "task_20260501_01:agent",
  "ptyTabs": [
    {
      "id": "task_20260501_01:agent",
      "kind": "agent",
      "title": "Codex",
      "command": ["codex", "rewrite the workspace shell"]
    },
    {
      "id": "task_20260501_01:terminal",
      "kind": "terminal",
      "title": "Terminal",
      "command": []
    }
  ],
  "surfaceState": {
    "activeTab": "agent",
    "openFileTabs": [],
    "inspectorSection": "task"
  },
  "createdAt": "2026-05-01T15:00:00Z",
  "updatedAt": "2026-05-01T15:00:00Z"
}
```

Representative UI state record:

```json
{
  "selectedRepoId": "repo_app",
  "selectedTaskId": "task_20260501_01",
  "selectedPtyTabId": "task_20260501_01:agent",
  "activeOverlay": null,
  "inputMode": "control",
  "centerTab": "agent",
  "inspectorSection": "task"
}
```

State model decisions locked by this RFC:

- task records carry PTY-tab metadata independently from any deferred substrate-specific session details
- UI restore state is explicit and versioned
- task runtime state is PTY-oriented and Craig-owned
- open file tabs and inspector selection are durable enough to restore orientation
- all state writes must remain atomic

### Filesystem layout

```text
.craig/
  repos/
    <repo-id>.json
  tasks/
    <task-id>.json
  runtime/
    ui-state.json
  artifacts/
    <task-id>/
      checks.json
      diff-summary.json
      review.json
  logs/
    <task-id>.log
  worktrees/
    <repo-id>/
      <task-id>/
```

## Edge cases and failure modes

- if the terminal is smaller than the supported minimum size, Craig renders a blocking resize overlay instead of a broken shell
- if PTY spawn fails, the task remains visible with an explicit failure state and recoverable action
- if worktree creation fails after branch creation, Craig must clean up partial state or mark the task as failed with actionable recovery details
- if persisted selected tabs or inspector sections are no longer valid after an upgrade, Craig falls back to the default task summary view
- if GitHub CLI is not installed, PR actions remain unavailable without blocking the rest of the workspace
- if visual reference coverage is incomplete, implementation may proceed on core layout, but polish and acceptance for the affected surface stay open

## Security and privacy

- Craig stores only local workspace state and should not require hosted sync for this rewrite
- PTY sessions inherit the local developer environment, so Craig must avoid logging secrets from interactive output unless log capture is explicitly enabled
- review metadata stored under `.craig/artifacts/` should be treated as local developer state and remain out of version control
- command dispatch must keep repo, worktree, and branch targeting explicit to avoid running task actions in the wrong workspace

## Observability

- log app boot, overlay transitions, mode transitions, PTY spawn, PTY exit, repo registration, task creation, and task restore events
- record task action failures with enough detail to diagnose Git, PTY, and render-path problems
- keep lightweight render and input diagnostics available in development builds
- expose current input mode and selected task in debug output so mode-ownership issues are diagnosable

## Rollout plan

All phases are linear. The rewrite should not mix old and new control surfaces beyond the minimal time needed for the placeholder baseline.

### Phase 0: Nuke the old UI

Deliver a clean rewrite baseline by removing Ink-era interactive UI, REPL assumptions, and `tmux`-driven UI behavior. Keep only the minimum scaffolding and clearly reusable non-UI services needed to start the new shell.

### Phase 1: Mock workspace shell

Deliver the Craig visual identity, boot and pause overlay, three-column shell, mock repo and task navigation, tab rails, right-panel sections, and stable keyboard navigation without any real task execution.

### Phase 2: Terminal integration

Deliver a real PTY in the center surface, explicit terminal-mode entry, raw keyboard forwarding while attached, and Craig-owned detach back to control mode.

### Phase 2.2: Terminal emulator fidelity

Replace the initial PTY line buffer with an xterm-style terminal emulator screen model so the center Terminal surface supports normal shell rendering behavior such as colors, clear-screen, prompt redraws, cursor addressing, resizing, and common TUI output.

### Phase 3: Real repo and task model

Deliver repo registration, task creation, branch and worktree provisioning, persisted local state, and restart restore for selected task and workspace context.

### Phase 4: Inspection and review workflow

Deliver file and diff surfaces, check summaries, next-action guidance, and PR-oriented actions so Craig covers the full review path expected of a terminal workspace.

## Plan Mode handoff checklist and acceptance criteria

### 0.1 Handoff

#### Implementation

- remove the old Ink interactive shell and REPL-first startup path
- remove `tmux`-specific UI assumptions from the interactive entrypoint
- keep the project bootable with a placeholder Craig message or minimal shell scaffold
- preserve reusable non-UI state, Git, and task utilities only when they still fit the rewrite target

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- run the interactive entrypoint manually and confirm the old UI is unreachable

#### Tracking update

- mark `0.1` implemented only if no old interactive surface is still reachable
- keep `0.1` open if startup still routes through Ink, REPL parsing, or `tmux`-owned UI logic

### 1.1 Handoff

#### Implementation

- render the CRAIG logo exactly as specified in this RFC
- implement the boot and pause overlay with centered green logo, dim subtitle, and caret-only menu
- build the three-column shell with the locked panel treatments and no inter-panel gaps
- implement mock left navigation, center tabs, and right inspector sections

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify the boot overlay and main shell at a supported terminal size

#### Tracking update

- mark `1.1` verified only if the CRAIG identity and panel layout match the RFC direction clearly
- record any missing visual references that still block polish-level signoff

### 1.2 Handoff

#### Implementation

- add control-mode keyboard routing for focus, selection, tabs, and overlay actions
- keep all input Craig-owned while not attached to a PTY
- persist mock selection state well enough to support later restore behavior
- ensure action rows render as rows rather than button affordances

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify arrow keys, tab movement, enter, and overlay exit behavior

#### Tracking update

- keep `1.2` open if any second stdin owner remains active during control mode
- record any keybinding conflicts explicitly

### 2.1 Handoff

#### Implementation

- integrate `node-pty` for the selected task terminal surface
- forward raw keyboard input only while in terminal mode
- implement `Ctrl + ]` to leave terminal mode and return to Craig control mode
- preserve the selected task and surface when terminal mode exits

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify shell interaction, arrow keys, and detach behavior in a real terminal

#### Tracking update

- keep `2.1` open if Craig and the PTY compete for stdin or if detach loses workspace context
- record native dependency setup issues around `node-pty` explicitly

### 2.2 Handoff

#### Implementation

- add a headless terminal emulator between `node-pty` and the Craig renderer
- feed PTY output into the emulator instead of a custom line buffer
- render the emulator viewport as styled rows inside the center Terminal surface
- resize the emulator and PTY together
- preserve Craig-owned `Ctrl + ]` detach and process-local session reuse

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify shell commands, color, `clear`, cursor movement, detach, and reattach in a real terminal

#### Tracking update

- keep `2.2` open if terminal output is still rendered as a log buffer, if clear/color/cursor addressing is broken, or if emulator integration changes Craig's input ownership rules

### 3.1 Handoff

#### Implementation

- replace mock repos and tasks with real repo records
- implement task creation that allocates a branch and git worktree
- persist task and repo state under `.craig/`
- persist default `agent` and `terminal` PTY tab metadata on each task
- connect created tasks to the workspace shell immediately by selecting the new task, activating the `agent` tab, and booting Codex inside the task worktree

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually create a task, confirm the worktree and branch are created correctly, and confirm the initial Codex agent tab opens in the task worktree

#### Tracking update

- keep `3.1` open if task creation can leave silent partial state behind
- record any repo assumptions that still prevent multi-repo workspace use

### 3.2 Handoff

#### Implementation

- restore selected repo, selected task, selected PTY tab, active tab, and inspector section after restart
- restore task lists and status from persisted state
- fall back safely when previous UI state is stale or invalid

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually restart Craig and confirm orientation restore works on valid state

#### Tracking update

- keep `3.2` open if restart restore changes selection unpredictably or loses tab context

### 3.3 Handoff

#### Implementation

- add explicit task-scoped PTY tab management on top of the multi-PTY task model
- support creating and switching between multiple `agent` and `terminal` tabs for one task
- add naming, closing, and restore semantics for PTY tabs without changing the task/worktree model

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually create at least one extra PTY tab for a task and verify selection and re-entry behavior

#### Tracking update

- keep `3.3` open if PTY tab creation or restore still assumes one live task session

### 4.1 Handoff

#### Implementation

- implement real files, diff, checks, and next-action surfaces
- connect inspector sections to real task state
- keep the center workspace dominant while surfacing review context without mode confusion

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify file and diff inspection from a task with local changes

#### Tracking update

- keep `4.1` open if files and diff views rely on leaving the Craig shell for normal use

### 4.2 Handoff

#### Implementation

- integrate PR-oriented actions through GitHub CLI when available
- surface PR state, checks, and next-action guidance in the right inspector
- keep the review flow optional when GitHub tooling is absent

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify degraded behavior without `gh`
- manually verify PR status and actions when `gh` is available

#### Tracking update

- keep `4.2` open if GitHub integration blocks the non-GitHub local workflow

### Acceptance criteria

- `[0.1]` Craig starts without exposing the old Ink shell, REPL parser flow, or `tmux`-driven interactive UX.
- `[1.1]` Craig renders the required logo treatment in the boot and pause overlay and presents a three-column shell with the specified panel hierarchy.
- `[1.2]` Craig owns input in control mode with stable keyboard navigation and no competing stdin consumer.
- `[2.1]` The selected task can enter terminal mode, interact with a live PTY, and return to control mode with `Ctrl + ]`.
- `[2.2]` The Terminal surface renders through a real emulator screen model with color, clear-screen, cursor movement, resize, detach, and reattach behavior working in a real PTY-backed session.
- `[3.1]` Creating a task provisions a branch and worktree, persists PTY-tab-aware task state under `.craig/`, and auto-boots the initial Codex agent tab in that task worktree.
- `[3.2]` Restarting Craig restores the prior workspace orientation, including selected PTY tab when persisted state is still valid.
- `[3.3]` One task can manage multiple PTY-backed `agent` and `terminal` tabs without reshaping the task/worktree model.
- `[4.1]` Files, diff, checks, and next-action guidance are available inside the Craig shell for real tasks.
- `[4.2]` GitHub-backed review actions enhance the workflow when available without becoming a hard dependency for core workspace use.
