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
- make agent execution, file inspection, change review, checks, and next actions feel like one product
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

- `workspace`: one user-openable Craig context. A workspace may be a single Git repo root or a parent project root such as `~/projects`.
- `repo`: one Git repository known to a workspace. In a project-root workspace, repos are discovered child directories beneath the workspace root.
- `repo workspace`: a workspace whose root is one Git repo and whose tasks target that repo only.
- `project workspace`: a workspace whose root is a parent directory and whose tasks may span the discovered child repos beneath that root.
- `workspace root`: the local filesystem root selected by the user when opening or adding a workspace.
- `task`: one execution unit bound to one workspace, one runner identity, and either one repo worktree or a coordinated set of repo worktrees when created from a project workspace.
- `pty tab`: one task-scoped PTY-backed runtime surface such as an auto-booted `agent` tab or a plain `terminal` tab
- `surface`: one center-panel view such as `agent`, `files`, `changes`, `terminal`, or `logs`
- `overlay`: one full-screen Craig-owned modal state such as boot, pause, or resize warning
- `runner`: the agent/tool identity used for task PTY bootstrap, initially Codex and later Cursor or Claude
- `workspace batch view`: a multi-repo view that groups files, changes, and review state by child repo so a parent directory feels monorepo-like without collapsing real Git repo boundaries

### Multi-root workspace journey

The phase `5.2` product contract is the new-install journey:

1. A user installs Craig and opens a workspace.
2. The workspace picker allows selecting a parent directory such as `~/projects`, not only an individual Git repo.
3. Craig opens that parent directory as a `project workspace`, discovers direct child Git repos, and presents the project root as the active workspace context.
4. Creating a task while the project workspace is selected creates a project-level task. That task can work across the discovered repos in the project root instead of being forced into one primary repo.
5. The `Files` panel shows a repo-grouped tree. The top-level rows are the child repos under the project root, and each repo can expand or collapse independently.
6. The `Changes` panel follows the same grouping. It shows changed files under their owning repo and lets the user move through changes without losing repo identity.
7. The `Review` panel follows the same grouping. It shows PR, check, and merge state for each repo touched by the task.
8. Review is read-only for project tasks in Craig. PR creation, check refreshes, and merges for project tasks are handled by the agent itself, which has access to all repo worktrees through the bundle root.

Project workspaces and repo workspaces may overlap. A user may save both `~/projects` and `~/projects/craig` as separate workspaces. Craig must keep those workspace records separate:

- selecting `~/projects` shows a project workspace whose child repo list includes `craig`
- selecting `~/projects/craig` shows a single-repo workspace for Craig only
- task state, selection state, collapse state, review actions, and terminal attach behavior are scoped to the selected workspace
- path overlap must not cause Craig to hide the explicit repo workspace, merge the two workspace records, or route actions through the wrong context

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

- concrete task PTY tabs such as `Codex`, `Terminal`, `Codex 2`, and `Terminal 2`
- `Files`
- `Changes`
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

Files and changes inspection use the right inspector as an index and the center panel as the detail surface:

- on `Files`, the right inspector shows a task worktree file tree; selecting a file opens that file in the center panel
- on `Changes`, the right inspector shows a per-file change summary; selecting a changed file opens that file's change detail in the center panel
- inspection navigation never implicitly attaches a PTY tab or changes input ownership
- concrete PTY tabs remain separate center tabs and are unaffected by browsing files or changes

After the multi-repo workspace phase, `Files`/`Changes` and `Review` each support two scopes:

- task scope: the current single-repo task view, where rows are rooted in the selected task worktree
- workspace scope: a parent-directory view grouped by child repo, where each repo directory can expand/collapse to reveal that repo's files, changes, PRs, checks, and task state

Workspace scope should feel like a monorepo browser for daily orientation, but it must preserve actual repo boundaries for Git, branch, PR, check, merge, and terminal commands. For single-repo tasks, Craig dispatches review actions (PR create/sync, refresh checks, merge, close) as before. For project tasks, the Review panel is read-only: it displays per-repo PR, check, and merge state, but action dispatch is agent-owned. The agent has access to all repo worktrees through the bundle root and is better positioned to coordinate multi-repo operations than a Craig-owned confirmation surface would be.

### Visual direction

The provided Craig renderings and the Superset screenshot establish a clear interaction and density target:

- Craig should feel like a dense terminal-native control plane, not a spacious desktop app
- the left column should read as a stacked workspace and task tree with strong scanability for status
- the center panel should use a lightweight top tab strip and keep the active surface visually quiet
- the right panel should read like an always-available operational sidebar rather than a modal review flow
- status indicators should be sparse and legible: green for live or healthy, amber for pending, red only for failures or negative change counts
- the overall shell should favor thin separators, restrained borders, and high information density over decorative framing
- Superset is a useful structural influence for panel hierarchy and review-side density, but Craig should keep its own terminal-first look and not inherit desktop-window affordances such as rounded cards, browser chrome, or large inactive gutters

### Visual references

Current visual references available in-repo:

- boot and pause overlay: `docs/rfcs/assets/craig-boot-overlay.png`
- main workspace shell: `docs/rfcs/assets/craig-control-plane-shell.png`

Additional references supplied in the session and now treated as implementation guidance:

- Craig shell variants covering agent, changes, terminal, files, and logs surfaces
- a Superset screenshot that reinforces the desired three-pane hierarchy and dense right-side review rail

The attached references are not durable repo assets, so the concrete takeaways are captured directly in this RFC:

- keep the top rail compact and always visible
- keep task rows dense and status-forward
- keep tabs flat and text-led
- keep the right inspector continuously visible during core workflows
- keep changes and file views inside the center workspace rather than turning them into separate full-screen modes

Additional durable repo references are still desirable for future polish work:

- a dedicated right-panel detail reference
- a dedicated changes or file-view reference produced from the chosen Craig direction

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
- `3.2` Restore selected task, tabs, inspector state, and selected PTY tab across restarts: `implemented and verified`
- `3.3` Add explicit multi-tab task runtime management on top of the multi-PTY task model: `implemented and verified`
- `3.4` Add a background daemon that preserves live PTY sessions across Craig UI exits and restarts: `implemented, delegated-session ownership hardened, and verified`
- `4.1` Add local files and changes inspection with right-panel navigation and center-panel detail views: `implemented and verified`
- `4.2` Add PR creation and sync for task branches, including persisted PR metadata: `implemented and verified`
- `4.3` Add checks and CI status reading for tracked PRs and head commits: `implemented and verified`
- `4.4` Add guarded PR merge and task close flow from Craig: `implemented and verified`
- `5.1` Add Cursor and Claude runner support alongside Codex: `implemented and verified`
- `5.2` Add parent-directory multi-repo workspace mode with repo-grouped Files, Changes, and Review: `implemented, pending manual verification`
- `6.1` Add a focused design and ergonomics pass across palette, navigation, density, empty states, and review workflows: `implemented and verified`
- `6.2` Add configurable video-game-like sound effects for important Craig events: `pending`
- `7.1` Add npm packaging, publish workflow, and CI source-leak prevention: `implemented and verified`
- `8.1` Add marketing site and public documentation entrypoint: `pending`

### Verification summary

- `0.1` Verified by removing the Ink renderer, REPL parser, and interactive-only runtime store; shrinking persisted UI state to command-mode selection metadata; removing `ink`, `react`, `ink-testing-library`, and `node-pty` from the package graph; and replacing no-arg startup with a placeholder message. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification passed by running the built CLI with no arguments and confirming it prints the phase `0.1` placeholder instead of opening the old shell.
- `1.1` Verified by replacing the phase `0.1` placeholder with a `terminal-kit` app entrypoint; rendering the CRAIG boot and pause overlays from the shared banner source; adding a three-column mock workspace shell with a top status rail, tab strip, and inspector sections; and keeping argv command mode intact for explicit commands. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification passed in a real TTY by running `node dist/cli.js`, confirming the boot overlay appears first, `Start` enters the shell, `Esc` opens the pause overlay, and `Exit` closes the app cleanly.
- `1.2` Verified by adding Craig-owned control-mode key routing for focus regions, mock task/action selection, center tab state, overlay actions, and non-destructive mock action feedback; deriving mock shell rendering from explicit shell state; and persisting restorable mock orientation fields in the workspace UI runtime state. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification passed in a real TTY by running `node dist/cli.js`, confirming boot Start enters the shell, `Tab`/`[`/`]` changes focus, arrow and Vim keys move selections, tabs change visible center content, `Enter` on actions shows placeholder feedback, `Esc` pauses/resumes, and `q` exits. No second stdin owner or keybinding conflict was observed during control mode.
- `2.1` Verified by adding a UI-only `node-pty` runtime that lazily spawns one process-local shell per selected mock task, derives PTY size from the center terminal surface, keeps PTY output in a bounded sanitized line buffer, forwards keys only while `inputMode` is `terminal`, intercepts `Ctrl + ]` to detach back to Craig control mode, disposes PTYs on app exit, and renders recoverable spawn errors in the Terminal tab. Automated verification covers reducer attach/detach transitions, selected task/tab preservation, PTY key mapping, output buffering, renderer terminal-mode states, startup option plumbing, app-level Enter aliases, and a real PTY E2E that launches Craig, enters terminal mode, and runs `echo craig_e2e_terminal_ok` through the shell. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed locally. Manual built-CLI verification also passed by launching `dist/cli.js` inside a real pseudo-terminal, pressing Enter into the Terminal tab, and observing `echo craig_dist_terminal_ok` render from the PTY. Native dependency note: `node-pty@1.1.0` failed to spawn on this macOS/Node 24 workspace with `posix_spawnp failed`; pinning `node-pty@0.10.1` and approving its build script resolved real PTY spawning.
- `2.2` Verified by adding an `@xterm/headless` emulator per process-local PTY session, feeding all PTY output into the emulator, resizing the emulator and PTY together, rendering styled emulator screen rows inside the center Terminal surface, and preserving the existing Craig control-mode versus terminal-mode ownership boundary. Follow-up hardening also makes reattach restart an exited PTY with a fresh shell and resolves each attached task shell to the recorded `worktreePath` when a task record exists, instead of always spawning in the workspace root. Automated verification covers SGR color cells, clear-screen behavior, carriage-return prompt redraw, cursor movement, wrapping, resize, styled renderer output, raw terminal-kit `unknown` Ctrl+] detach handling, detach/reattach session preservation, exited-session restart, exact task-worktree cwd resolution at spawn time, and a real PTY E2E that launches Craig, enters terminal mode, verifies the attached shell prompt is rooted in the selected task worktree, verifies color rendering, verifies `clear` removes prior visible terminal content, verifies cursor-addressed output, detaches with `Ctrl + ]`, re-enters the same live terminal surface, exits the shell process, and reattaches into a fresh shell successfully.
- `3.1` Verified by replacing mock shell repo/task fixtures with real `.craig` repo and task records at startup; reconciling shell selection against persisted repo, task, and PTY-tab ids; adding a minimal in-shell task prompt flow; provisioning new tasks through real branch and worktree creation; persisting default `agent` and `terminal` PTY tab metadata on each task; auto-selecting the created task; and immediately booting the initial Codex agent PTY tab in that task worktree. Automated verification covers control-state resolution on real ids, renderer output on real task context, PTY runtime tab-keyed session reuse, app-level terminal attach on real task selection, app-level create-task auto-bootstrap into the `agent` PTY tab, command-mode task creation compatibility, and a real PTY E2E rooted in a persisted task worktree. `pnpm test`, `pnpm typecheck`, and `pnpm lint` passed locally.
- `3.2` Verified by adding an explicit persisted `inspectorSection`, extracting a pure restore reconciliation path for real repo/task state, restoring valid selected repo, task, center tab, selected PTY tab, focus region, action row, and inspector orientation from `.craig/runtime/ui-state.json`, and falling back deterministically when persisted repo, task, or PTY-tab ids are stale. Startup restore now normalizes stale terminal-mode input ownership back to Craig control mode while ongoing in-app reconciliation preserves live terminal-mode attach state. Automated verification covers exact restore, stale fallback, missing inspector defaults, terminal-mode normalization on startup restore, restored terminal tab attach after boot Start, restored agent tab attach, and stale persisted app state rendering a usable shell. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed locally.
- `3.3` Verified by replacing the fixed `Agent`/`Terminal` center-tab assumption with concrete task-scoped PTY tabs rendered alongside fixed `Files`, `Changes`, and `Logs` surfaces; adding `+` tab creation and `x` tab close while the center pane is focused; generating stable task-scoped ids and automatic titles such as `Codex 2` and `Terminal 2`; persisting concrete active PTY tab ids through task records and UI runtime state; migrating legacy persisted `agent` and `terminal` surfaces to the selected task's concrete tabs; disposing process-local PTY sessions when their tab closes; and keeping task-row Enter attach semantics pointed at the selected or default agent tab. Automated verification covers mixed center tab construction, create/close reducer intents, exact concrete-tab attach, second terminal and agent tab launch, runtime session disposal on close, stale/closed tab restore fallback, concrete tab restart restore, and the real terminal E2E attach contracts updated for the concrete-tab UX. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed locally.
- `3.4` Verified by adding a workspace-local Craig PTY daemon with hidden serve/shutdown CLI paths, short hashed Unix-socket IPC, `.craig/runtime` pid/log metadata, stale endpoint recovery, and a daemon-backed PTY client that preserves the existing app PTY port while moving live `node-pty` and xterm emulator ownership out of the foreground UI process. Foreground Craig startup now connects to the daemon before accepting shell input; foreground exit detaches from daemon sessions instead of killing them; explicit PTY tab close still terminates only the closed daemon session; and task-scoped `agent`/`terminal` tab ids continue to drive session identity and worktree/command resolution. Delegated child creation now provisions through the domain boundary but launches through a shell-owned daemon port, so the initial prompt, unselected dispatch, and later TUI attachment all address the same agent tab and process rather than a hidden tmux runner plus a duplicate UI runner. Automated verification covers daemon reconnect without respawn, explicit per-tab disposal, stale pid recovery, app attach/close behavior, real terminal restart reattach with a stub Codex process proving the agent was not relaunched, and a delegated Cursor child whose launch count remains one across initial work, dispatch, and navigation. The current full suite passed with 662 tests across 68 files via `pnpm test`, plus `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `4.1` Verified by adding a local inspection service that indexes Git-visible files, excludes ignored files, splits local changes into staged, unstaged, and untracked groups, and guards binary or oversized change previews. The Craig shell now has four focus regions (`tasks`, `center`, `inspector`, `actions`), persists selected file and change paths, restores stale inspection paths to valid rows, and renders `Files`/`Changes` as stable center tabs with right-panel navigation and center-panel detail content. Automated coverage includes file indexing, grouped change summaries, guarded binary previews, reducer inspector navigation, renderer file/change layouts, app-level file/change selection without PTY attach, and existing terminal E2E attach contracts. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed locally.
- `4.2` Verified by consolidating the right operational sidebar into `CHANGES FILES REVIEW`; mapping legacy `checks` and `actions` inspection modes to `review`; rendering tracked PR metadata, persisted check summary rows, synced timestamp, and synced head SHA in Review; wiring Review `Enter`/`P` to create or sync PRs through the existing Git/GitHub service path; and persisting `TaskPullRequest.lastSyncedHeadSha` after PR refresh. Automated coverage includes PR metadata normalization, PR create and sync service behavior, Review reducer intents, Review renderer output, app-level PR create, app-level PR sync after a newer local commit, GitHub auth failure display, and unchanged file/changes/PTY attach behavior. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed locally.
- `4.3` Verified by extending persisted PR check state to distinguish passing, pending, failing, skipped, and unknown GitHub check results; treating skipped as non-blocking while keeping it visually distinct; adding an explicit Review `R` refresh action beside the existing `P` create/sync PR action; rendering tracked PR check rows and next-action guidance from persisted PR metadata; and keeping refresh in Craig control mode without attaching PTYs or changing file/changes orientation. Automated coverage includes GitHub check normalization, skipped/non-blocking readiness, failed and unknown states, refresh-without-PR failure, Review reducer intents for `P`/`R`/`Enter`, Review renderer guidance, and app-level check refresh/error behavior. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed locally.
- `4.4` Verified by hardening the tracked PR merge service so it refreshes GitHub PR/check state immediately before merge, blocks missing PRs, missing commits, dirty worktrees, stale local/remote heads, missing check data, pending/failing/unknown checks, and non-mergeable GitHub states, then merges through the configured GitHub merge method while preserving the task worktree from the shell. The Review panel now exposes `P` create/sync, `R` refresh checks, `M` merge PR, and `X` close task actions; merged tasks can be marked `closed` as a recoverable persisted state without deleting worktrees or branch metadata, and shell close disposes live task PTY sessions. Automated coverage includes service blockers for stale heads, missing checks, and pending checks; close-task success and pre-merge failure; renderer Review merge/close rows and guidance; and app-level merge success, merge blocker, and close-task behavior without PTY attach. `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` passed locally.
- `5.1` Verified by adding durable runner profiles for Codex, Cursor, and Claude; extending task records, task provisioning, command-mode task creation, interactive new-task creation, PTY tab commands, runner summary rendering, and task context rendering to use explicit runner metadata; adding a left-panel runner selector for new interactive tasks; and preserving failed runner startup as recoverable task state when a selected runner binary is unavailable. Automated verification covers runner profile validation, runner-specific task records and tmux launch commands, `--runner` parsing, shell selector cycling, runner labels/counts, app-level selected-runner task creation, missing-runner failure state, and real terminal E2E attach flows for Codex, Cursor, and Claude stub binaries rooted in the selected task worktree. `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, and `git diff --check` passed locally.
- `5.2` Implemented by adding canonical `workspace add` registration for repo and parent-directory roots; durable project workspace records with direct child Git repo discovery; overlap-safe project and repo workspace records; project task provisioning with per-repo worktree targets, unavailable-target state, bundle roots, manifests, and repo links; workspace-first shell navigation; project task agent startup from the bundle root; repo-prefixed Files and Changes inspection for project tasks; and per-repo Review rows for project targets. Project-task Review is intentionally read-only in Craig — PR create/sync, refresh checks, and merge for project tasks are agent-owned. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification against a real project workspace is pending.
- `6.1` Verified by replacing the three-panel background differentiation approach with a unified flat Tokyo Night palette (`0a0a0a` base) divided by visible `│` dividers; introducing semantic color tokens for success, pending, error, muted, accent, and disabled states; adding Nerd Font file-tree icons with per-extension color; adding PR lifecycle and check-status icons to the inspection mode selector; converting the runner row to a full-width dynamic health bar (name flush-left, bar filling the remaining panel width, green at full health / red below 20%); adding a `?` global help overlay with a centered keybinding table and the CRAIG logo treatment; refactoring the boot and pause overlays from four-item to three-item menus (`Start/Resume`, `Options`, `Exit`) with Options navigating into a dedicated submenu; fixing overlay menu-item centering to eliminate layout shift during navigation; adding truncation via the shared `pad`/`truncate` helpers across all fixed-width columns; tightening empty-state copy to include actionable next steps; and widening the left panel from 38 to 42 characters to give the health bar meaningful visual weight. Automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Manual verification passed in a real TTY confirming palette, focus states, health bar, icons, overlays, and keybinding table render correctly across narrow and normal terminal sizes.
- `6.2` Not yet verified.
- `7.1` Verified by pivoting release packaging to a single publishable `craig-cli` package under `packages/cli`; adding an esbuild npm bundle that emits a minified, executable, sourcemap-free Node 22 ESM CLI at `packages/cli/dist/cli.js`; keeping `node-pty` and `terminal-kit` external runtime dependencies while bundling `@xterm/headless`; adding Changesets metadata for `craig-cli` only; adding CI and release workflow gates for tests, typecheck, lint, TypeScript build, npm build, package audit, and package smoke; and rewriting consumer-facing README/release guidance. Follow-up release simplification removed the generated Version Packages PR flow: the release workflow now applies Changesets, runs gates, commits version/changelog updates back to `main` with `[skip ci]`, and publishes to npm from the same merge-triggered run. Artifact verification passed with `pnpm package:audit`, confirming the packed tarball contains only `dist/cli.js`, `README.md`, and `package.json`. Smoke verification passed with `pnpm package:smoke`, which packed `packages/cli`, installed the tarball into a temporary git workspace, ran the installed `craig repo list`, and launched the installed `craig` under a PTY until the boot marker appeared. Full automated verification passed via `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.
- `8.1` Not yet verified.

### Next resume point

Resume at manual verification of `5.2`. All implementation items are complete, and delegated child session identity is now covered automatically under `3.4`; no separate daemon follow-up is required unless the Fury bug bash exposes a regression. Project-task Review action dispatch is intentionally out of scope — PR create/sync, refresh checks, and merge for project tasks are agent-owned, not Craig-dispatched. The remaining work before marking `5.2` verified is to run the manual verification steps in the `5.2` handoff against a real project workspace. Phase `7.1` was completed out of order and should be skipped on future resumes unless release packaging regresses.

### Parallelizable phases

- background session persistence beyond the local Craig process was delivered in phase `3.4`; daemon-owned PTY sessions now keep in-progress agent conversations alive across Craig UI exits
- review-workflow phases `4.2` through `4.4` remain scoped to PR creation, check reading, merge behavior, and task-review state; those semantics were intentionally untouched by `3.4`
- the marketing site in `8.1` may be designed in parallel with implementation work, but it should not publish until package metadata, privacy language, and install docs from `7.1` are stable

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
- `craig workspace add <path>`
- `craig workspace list`
- `craig task new --workspace <workspace-id> "<prompt>"`
- `craig task list [--workspace <workspace-id>]`
- `craig task open <task-id>`
- `craig task changes <task-id>`
- `craig task attach <task-id>`
- `craig task check <task-id>`
- `craig task pr <task-id>`

This command surface is subordinate to the application model. Services should not depend on a REPL parser shape. `workspace add` is the single registration path: adding a Git repo path creates a repo workspace, while adding a parent directory creates a project workspace and discovers direct child repos. `repo add` and `repo list` are removed from the target command surface so repo registration cannot fork from workspace registration.

### Core record contracts

Representative project workspace record:

```json
{
  "id": "workspace_projects",
  "kind": "project",
  "name": "projects",
  "rootPath": "/home/developer/projects",
  "discoveredRepoIds": ["repo_craig", "repo_api", "repo_web"],
  "createdAt": "2026-05-14T19:00:00Z",
  "updatedAt": "2026-05-14T19:00:00Z"
}
```

Representative repo workspace record:

```json
{
  "id": "workspace_craig",
  "kind": "repo",
  "name": "craig",
  "rootPath": "/home/developer/projects/craig",
  "repoId": "repo_craig",
  "createdAt": "2026-05-14T19:00:00Z",
  "updatedAt": "2026-05-14T19:00:00Z"
}
```

Representative single-repo task record:

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
    "activeTab": "task_20260501_01:agent",
    "openFileTabs": [],
    "selectedFilePath": "src/app.ts",
    "selectedChangesPath": "src/app.ts",
    "inspectorSection": "task"
  },
  "createdAt": "2026-05-01T15:00:00Z",
  "updatedAt": "2026-05-01T15:00:00Z"
}
```

Representative project task record:

```json
{
  "id": "task_20260514_01",
  "workspaceId": "workspace_projects",
  "kind": "project",
  "title": "update shared auth flow",
  "runner": "codex",
  "bundlePath": "/home/developer/projects/.craig/task-bundles/task_20260514_01",
  "selectedRepoTargetId": "repo_craig",
  "selectedPtyTabId": "task_20260514_01:agent",
  "ptyTabs": [
    {
      "id": "task_20260514_01:agent",
      "kind": "agent",
      "title": "Codex",
      "command": ["codex", "update shared auth flow"]
    },
    {
      "id": "task_20260514_01:terminal",
      "kind": "terminal",
      "title": "Terminal",
      "command": []
    }
  ],
  "repoTargets": [
    {
      "repoId": "repo_craig",
      "branch": "craig/update-shared-auth-flow",
      "worktreePath": "/home/developer/projects/.craig/worktrees/repo_craig/task_20260514_01",
      "pullRequest": null,
      "checks": null,
      "mergeState": "not_ready"
    },
    {
      "repoId": "repo_api",
      "branch": "craig/update-shared-auth-flow",
      "worktreePath": "/home/developer/projects/.craig/worktrees/repo_api/task_20260514_01",
      "pullRequest": null,
      "checks": null,
      "mergeState": "not_ready"
    }
  ],
  "surfaceState": {
    "activeTab": "task_20260514_01:agent",
    "openFileTabs": [],
    "selectedRepoTargetId": "repo_craig",
    "selectedFilePath": "repo_craig/src/auth.ts",
    "selectedChangesPath": "repo_craig/src/auth.ts",
    "inspectorSection": "review"
  },
  "createdAt": "2026-05-14T19:00:00Z",
  "updatedAt": "2026-05-14T19:00:00Z"
}
```

Project task bundle rules:

- `bundlePath` is the default cwd for the project task's agent PTY.
- The bundle root contains a manifest of repo targets and stable links or directories that let the agent find each per-repo worktree without guessing from the user's source tree.
- Per-repo terminal actions may open a PTY in a selected repo target's `worktreePath`, but the default project agent starts from `bundlePath` so it can coordinate work across repo targets.

Representative UI state record:

```json
{
  "selectedRepoId": "repo_app",
  "selectedTaskId": "task_20260501_01",
  "selectedPtyTabId": "task_20260501_01:agent",
  "activeOverlay": null,
  "inputMode": "control",
  "centerTab": "task_20260501_01:agent",
  "inspectorSection": "task"
}
```

State model decisions locked by this RFC:

- task records carry PTY-tab metadata independently from any deferred substrate-specific session details
- UI restore state is explicit and versioned
- task runtime state is PTY-oriented and Craig-owned
- open file tabs and inspector selection are durable enough to restore orientation
- files and changes inspection may persist selected file paths, but file contents and change text are derived from the task worktree on demand
- PR metadata, check snapshots, and merge/cleanup status are durable task concerns, but they land in separate phases after local inspection
- runner identity and launch command metadata must be explicit so Codex, Cursor, and Claude tasks can coexist without guessing from tab titles
- multi-repo workspace state must preserve saved workspace roots, discovered child repos, manually registered repo workspaces, and selected parent-directory roots so Craig can restore a monorepo-like workspace view without confusing which repo owns branch, PR, checks, and merge state
- task records must distinguish single-repo tasks from project tasks. Both task kinds share runner, PTY-tab, surface-state, created-at, and updated-at fields. A project task additionally owns a set of per-repo task targets, where each target has its own repo id, branch, worktree path, PR metadata, checks, and merge state.
- project tasks may have a primary repo only as a UI/default-terminal convenience, not as the exclusive write scope. Git mutations must target the selected repo target or an explicit batch of repo targets.
- UX and sound preferences are workspace-local runtime settings and must be safe to disable for quiet terminals, CI, and accessibility needs
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
- if a parent-directory workspace contains non-Git folders, nested repos, hidden repos, or inaccessible directories, repo discovery must skip or report them without blocking already registered repos. Phase `5.2` discovers direct child Git repos only; nested repos below a child directory are ignored.
- if multiple repos have similarly named branches, tasks, files, or PRs, every row and action message must retain enough repo identity to prevent wrong-repo commands
- if a saved repo workspace is also discovered inside a saved project workspace, both workspaces remain visible and separately selectable; overlap is allowed and must not be treated as duplicate registration
- if a project task touches only some child repos, Files, Changes, and Review should still show the project grouping but mark repos with no task worktree, no local changes, or no PR state clearly
- if immediate project-task provisioning cannot create a worktree for a discovered direct child repo, Craig must keep the project task visible, mark that repo target as unavailable with the failure reason, and continue provisioning the remaining repo targets
- if package publishing or static artifact checks fail, the continuous deployment workflow must fail closed rather than publishing a partial or source-leaking npm package

## Security and privacy

- Craig stores only local workspace state and should not require hosted sync for this rewrite
- PTY sessions inherit the local developer environment, so Craig must avoid logging secrets from interactive output unless log capture is explicitly enabled
- review metadata stored under `.craig/artifacts/` should be treated as local developer state and remain out of version control
- command dispatch must keep repo, worktree, and branch targeting explicit to avoid running task actions in the wrong workspace
- npm publish artifacts must be generated from an explicit allowlist and checked in CI so source trees, docs/RFCs, tests, repo guidance, `.codex`, `.context`, `.craig`, `.github`, task artifacts, logs, env files, source maps, lockfiles, private repo paths, and generated workspace state cannot leak into the package
- source-leak checks must be conservative and fail the release path when they cannot determine whether a packed artifact is safe
- the marketing site must not require or expose local Craig workspace state, task prompts, logs, or private repository metadata

## Observability

- log app boot, overlay transitions, mode transitions, PTY spawn, PTY exit, repo registration, task creation, and task restore events
- record task action failures with enough detail to diagnose Git, PTY, and render-path problems
- keep lightweight render and input diagnostics available in development builds
- expose current input mode and selected task in debug output so mode-ownership issues are diagnosable
- record package dry-run and artifact-audit failures in CI logs with the offending path or rule name

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

### Phase 3.4: Background session daemon

Deliver a Craig-owned background daemon that owns task PTY sessions independently from the foreground terminal UI so exiting and restarting Craig can reattach to an in-progress agent conversation without relaunching the agent process. This phase is deferred until the multi-tab task runtime model is explicit, because the daemon must preserve task-scoped `agent` and `terminal` tabs rather than invent a second session model.

### Phase 4: Inspection and review workflow

Deliver the review path in separable vertical slices: local files/changes inspection first, PR creation and sync second, CI/check reading third, and guarded merge/close behavior last.

### Phase 5: Workspace and runner expansion

Deliver broader task execution and repository topology support after the core Codex single-root workflow is stable. This phase adds Cursor and Claude as first-class runner identities, then adds a parent-directory multi-repo workspace mode for projects stored under roots such as `~/projects`. The multi-repo mode should feel like a monorepo in Files, Changes, and Review by grouping expandable rows by child repo, while preserving real repo boundaries for branch, worktree, PR, check, merge, and terminal actions. Project-level task creation is in scope: creating a task from a project workspace immediately provisions a coordinated task bundle across all accessible direct child repos by default. Lazy repo-target creation is deferred because it would add more lifecycle and agent-routing complexity than the MVP needs.

### Phase 6: Product feel and delight

Deliver a dedicated product-design pass after the core workflow is useful end to end. This phase audits and revises the color palette, focus states, typography density, hierarchy, empty states, and repeated-use ergonomics across normal terminal sizes. It then adds configurable video-game-like sound effects for important Craig events without making audio a requirement.

### Phase 7: Packaging and publish safety

Deliver npm packaging and release safety only after the local product has a stable command surface. This phase prepares Craig for npm distribution as the single `craig-cli` package, replaces binary-platform packaging with a minified esbuild Node bundle, and makes Changesets continuous deployment the only publish path. CI checks must fail if package artifacts include source trees, docs/RFCs, tests, repo guidance, private workspace state, task artifacts, logs, `.codex`, `.context`, `.craig`, `.github`, env files, source maps, lockfiles, local paths, or other accidental source/code leakage.

### Phase 8: Marketing site and public docs

Deliver a public-facing site after package installation, privacy claims, and core workflows are stable enough to describe accurately. This phase creates a marketing and documentation entrypoint with product positioning, install instructions, workflow screenshots or terminal captures, privacy/security language, and links to the npm package and GitHub repository.

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

### 3.4 Handoff

#### Implementation

- add a Craig background daemon that owns live task PTY sessions outside the foreground terminal UI process
- reattach the foreground Craig shell to daemon-owned `agent` and `terminal` tabs after UI restart
- preserve in-progress agent conversations across Craig UI exit without relaunching the agent process
- keep daemon session metadata aligned with the task-scoped PTY tab records introduced by `3.3`

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually start an agent conversation, exit Craig, restart Craig, and confirm reattach returns to the same live conversation

#### Tracking update

- keep `3.4` scoped to daemon-backed live PTY/session survival; it can run in parallel with `4.2` as long as PR/check/merge semantics are untouched
- keep `3.4` open if process survival requires reintroducing user-visible `tmux` concepts

### 4.1 Handoff

#### Implementation

- implement the `Files` surface as local task worktree inspection
- render a file tree for the selected task in the right inspector while `Files` is active
- let keyboard selection in the right file tree open the selected file in the center panel
- implement the `Changes` surface as local Git change inspection for the selected task worktree
- render a per-file change summary in the right inspector while `Changes` is active
- let keyboard selection in the right change summary open the selected file change detail in the center panel
- persist enough inspection orientation to restore the active files/changes surface and selected file when practical
- keep file/changes browsing in Craig control mode; switching or selecting inspection rows must not attach PTYs
- leave PR creation, CI/check reading, and merge behavior out of scope for this phase

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify the `Files` tab shows a right-panel file tree and opens a selected file in the center panel
- manually verify the `Changes` tab shows a right-panel per-file change summary and opens a selected file change detail in the center panel
- manually verify PTY tabs remain separate and browsing files/changes does not enter terminal mode

#### Tracking update

- keep `4.1` open if files or changes views rely on leaving the Craig shell for normal use
- keep `4.1` open if the right inspector is not the navigation/index surface for files and changes

### 4.2 Handoff

#### Implementation

- add PR creation for the selected task branch through the existing Git/GitHub integration path
- push or update the task branch when creating or syncing the PR
- persist tracked PR metadata on the task record, including PR number, URL, base branch, head branch, and last synced head commit when available
- surface tracked PR metadata in the right inspector without blocking local file/changes inspection
- add an explicit PR sync action that updates the remote branch and refreshes tracked PR metadata
- keep degraded behavior clear when GitHub tooling or authentication is unavailable

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify degraded behavior without `gh`
- manually verify creating a PR from Craig records the PR on the task
- manually verify syncing after another local commit updates the PR branch and task metadata

#### Tracking update

- keep `4.2` open if PR creation/sync blocks the non-GitHub local workflow
- keep `4.2` open if task PR metadata is not durable enough to restore after Craig restart

### 4.3 Handoff

#### Implementation

- read check suites, check runs, and/or required status checks for the tracked PR or task head commit
- surface CI/check status in the right inspector with clear green, pending, failing, skipped, and unknown states
- persist the latest check snapshot enough for restart orientation and offline display
- add a refresh checks action that updates the task's check metadata
- make next-action guidance explain whether the PR is waiting on CI, blocked by failures, or ready for review/merge
- do not merge from this phase; this phase reads and interprets readiness only

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify checks render for a tracked PR with passing CI
- manually verify pending or failing checks are visible and do not look merge-ready
- manually verify degraded behavior when check data is unavailable

#### Tracking update

- keep `4.3` open if Craig cannot distinguish passing, pending, failing, skipped, and unknown checks
- keep `4.3` open if check refresh can silently report stale data as current

### 4.4 Handoff

#### Implementation

- add a guarded merge action for the tracked PR when checks and PR state indicate it is ready
- block or warn on merge when the PR is stale, dirty, conflicted, failing CI, missing required checks, or lacking mergeability data
- execute merge through the chosen GitHub integration path and persist the merged task state
- add a close-task flow that updates task status and records whether worktree/branch cleanup is still pending
- keep destructive cleanup, if any, explicit and recoverable

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify merge is blocked for failing or pending checks
- manually verify a ready PR can be merged from Craig and the task state updates
- manually verify close-task behavior after merge

#### Tracking update

- keep `4.4` open if merge can proceed without fresh readiness data
- keep `4.4` open if task close loses PR or cleanup status needed for recovery

### 5.1 Handoff

#### Implementation

- add explicit runner profiles for `codex`, `cursor`, and `claude`
- let new task creation choose a runner without changing the one-task/one-primary-worktree model
- generate default agent PTY tabs with runner-specific titles and launch commands
- persist runner identity and runner command metadata on task records
- show runner identity clearly in the left task tree, center PTY tabs, and right task context
- degrade clearly when the selected runner binary or authentication is unavailable
- keep runner support command-oriented; do not add separate UI paradigms per runner

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually create a Codex task and confirm existing behavior still works
- manually create Cursor and Claude tasks with stub binaries and confirm each starts in the task worktree
- manually verify missing runner binaries produce actionable errors without corrupting task state

#### Tracking update

- keep `5.1` open if Cursor or Claude support is inferred from tab labels instead of durable runner metadata
- keep `5.1` open if adding another runner breaks Codex task creation or attach behavior

### 5.2 Handoff

#### Implementation

- allow the workspace picker and command-mode registration path to accept a parent directory such as `~/projects`
- create a durable `project workspace` record for the parent directory and discover direct child Git repos beneath it without requiring each child repo to be added one by one
- ignore nested Git repos below those direct children for the `5.2` MVP; do not render subdirectory repo nesting
- preserve separate explicit `repo workspace` records even when their repo path is also discovered inside a saved project workspace
- render the left navigation as saved workspaces first, then the selected workspace's tasks and child repo context, so `~/projects` and `~/projects/craig` remain separately selectable
- let creating a task from a project workspace immediately create a project-level task bundle with per-repo targets and worktrees for all accessible direct child repos by default
- keep creating a task from a repo workspace as the existing single-repo task flow
- add workspace-scope `Files`, `Changes`, and `Review` views where each child repo directory can expand/collapse independently
- make `Files` show each repo under the project root, then that repo's task worktree files when the project task has a worktree for that repo
- make `Changes` show each repo under the project root, then that repo's staged, unstaged, and untracked changes or an explicit clean/unavailable state
- make `Review` show each repo target's PR, checks, readiness, and merge state without collapsing the repos into one synthetic PR
- keep project-task Review read-only in Craig; PR create/sync, refresh checks, and merge for project tasks are handled by the agent, which has direct access to all repo worktrees through the bundle root
- make task creation, selection, restore, and command dispatch deterministic when multiple repos contain similar names, branches, files, or PRs
- persist project task row selection, repo-group expansion state, selected repo target, and active Files/Changes/Review row across Craig restart when practical
- keep terminal attach behavior explicit: an agent PTY for a project task starts in the synthetic project task bundle root so the agent can operate across the repo worktrees, while per-repo terminal actions must target the selected repo worktree

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually start from a clean Craig state, open `~/projects`, and verify Craig creates a project workspace with discovered child Git repos
- manually create a task from the `~/projects` workspace and verify Craig immediately provisions worktrees for all accessible direct child repos
- manually verify nested Git repos below direct children are ignored in the project workspace
- manually verify the project task's agent PTY starts in the synthetic bundle root and can inspect the repo worktrees from there
- manually verify Files, Changes, and Review can expand/collapse repo groups and preserve row selection
- manually verify Files shows each child repo and opens selected files from the correct repo worktree
- manually verify Changes shows per-repo changed files and opens selected changes without losing repo identity
- manually verify Review shows separate PR/check/merge state for each repo touched by the project task
- manually verify Review is read-only for project tasks (no PR create/sync, refresh, merge, or batch actions dispatched from Craig)
- manually add both `~/projects` and `~/projects/craig` as saved workspaces and verify they are separately navigable, restorable, and task-capable

#### Tracking update

- keep `5.2` open if parent-directory discovery or workspace-scope panels make branch, PR, checks, merge, or terminal targets ambiguous
- keep `5.2` open if project-level task creation still creates only one primary repo worktree with passive linked repo context
- keep `5.2` open if immediate project task provisioning does not create or explicitly mark unavailable every accessible direct child repo target
- keep `5.2` open if repo-group expansion state, selected repo target, project task target state, or selected rows cannot restore after Craig restart
- keep `5.2` open if overlapping project and repo workspaces are hidden, merged, or routed through the wrong workspace context
- keep `5.2` open if the Review panel dispatches mutating actions for project tasks (it should be read-only)

### 6.1 Handoff

#### Implementation

- audit and revise the Craig color palette for contrast, hierarchy, selection clarity, and reduced visual noise
- introduce or consolidate renderer tokens for palette, focus, muted, success, pending, failure, and disabled states so colors are not scattered through rendering code
- polish navigation affordances, focus styling, truncation, and dense-layout behavior across the shell
- improve empty, loading, failure, and unavailable-tool states for tasks, files, changes, PRs, checks, and runners
- tune right-panel hierarchy so file/changes/PR/check navigation remains scannable during repeated daily use, including multi-repo grouped views from `5.2`
- tighten copy for action feedback, blocked states, and next-action guidance
- improve ergonomics for common repeated workflows: task selection, PTY attach/detach, file browsing, change review, PR refresh, merge, and close
- verify the shell does not become card-heavy, over-padded, or dominated by a one-note color family
- preserve keyboard-first control-mode behavior and avoid adding hidden input ownership changes

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually review the shell at narrow, normal, and wide terminal sizes
- manually verify long repo, task, branch, file, check, and PR labels truncate cleanly without overlap
- manually verify common workflows remain discoverable without explanatory marketing text
- manually verify selected, focused, muted, disabled, passing, pending, failing, and unknown states are distinguishable in the active palette
- manually compare single-repo and multi-repo workspace views for scanability

#### Tracking update

- keep `6.1` open if visual polish introduces overlap, ambiguous focus, or slower repeated keyboard workflows
- keep `6.1` open if empty/error states leave the user without a clear next action
- keep `6.1` open if the palette reads as one-note, low-contrast, or inconsistent across panels

### 6.2 Handoff

#### Implementation

- add configurable sound effects for key Craig events such as boot, task start, PTY attach/detach, tab create/close, check pass/fail, PR ready, merge complete, and blocked actions
- make sound behavior workspace-configurable with an obvious mute/off path
- keep audio local-only and avoid requiring network assets
- ensure sound playback never blocks rendering, input handling, PTY forwarding, or CI/test execution
- use a cohesive game-like sound palette while keeping cues short enough for repeated developer workflows

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- manually verify sound cues fire for the configured events in an interactive terminal environment
- manually verify mute/off disables all audio cues
- manually verify tests and non-interactive command mode do not emit audio

#### Tracking update

- keep `6.2` open if sound effects are not configurable or cannot be fully muted
- keep `6.2` open if audio playback can interfere with terminal input, rendering, or PTY sessions

### 7.1 Handoff

#### Implementation

- make the root package private and publish only `packages/cli` as `craig-cli`
- remove platform package and Bun binary build/publish assumptions from package metadata, workflows, and release guidance
- add `esbuild` packaging that bundles `src/cli.ts` to `packages/cli/dist/cli.js` with `platform=node`, `format=esm`, `target=node22`, `bundle=true`, `minify=true`, `sourcemap=false`, a preserved shebang, executable mode, and externals for `node-pty` and `terminal-kit`
- keep `node-pty` and `terminal-kit` as `craig-cli` runtime dependencies while bundling safe JS dependencies such as `picocolors` and `@xterm/headless`
- set `craig-cli` `bin.craig` to `dist/cli.js` and keep its `files` allowlist to `dist/cli.js`, `README.md`, and `package.json`
- add Changesets config and release metadata that reference only `craig-cli`; do not support local publish or manual version edits
- add a continuous deployment workflow on `main` that applies Changesets version updates, runs `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`, commits version/changelog updates back to `main` with `[skip ci]` when needed, and publishes `craig-cli` to npm
- add static artifact analysis that fails CI if packed files include source, docs/RFCs, tests, repo guidance, `.codex`, `.context`, `.craig`, `.github`, task artifacts, logs, env files, private workspace state, source maps, declarations, lockfiles, local absolute paths, or other denied patterns
- rewrite the npm README as consumer-facing install/setup docs without private implementation language, RFC links, agent guidance, or local workspace paths

#### Verification

- run `pnpm test`
- run `pnpm typecheck`
- run `pnpm lint`
- run `pnpm build`
- run `pnpm build:npm`
- verify `packages/cli/dist/cli.js` is minified, executable, has a shebang, and no `.map` files are produced
- run `pnpm package:audit`
- run `pnpm package:smoke`
- verify the release workflow applies Changesets version updates before packaging, publishes from the first merge-triggered run, and pushes version/changelog cleanup commits back to `main` with `[skip ci]`
- intentionally add a denied file to a local dry-run fixture or test and verify the leak check fails

#### Tracking update

- keep `7.1` open if npm artifacts are not allowlisted to `dist/cli.js`, `README.md`, and `package.json`
- keep `7.1` open if CI cannot fail closed on likely source, secret, workspace-state, source-map, private-metadata, or task-artifact leakage
- keep `7.1` open if the packed package cannot be installed and smoke-tested outside the repo checkout
- keep `7.1` open if Changesets CD is not the only publish path or if publishing requires a second generated Version Packages PR

### 8.1 Handoff

#### Implementation

- create a marketing site or docs entrypoint that explains Craig's terminal workspace model, multi-repo workflow, runner support, review lifecycle, and install path
- include durable screenshots, terminal captures, or short demos that show the real product rather than mock-only claims
- add privacy and security copy that explains local workspace state, PTY behavior, package artifact safety, and what Craig does not upload
- link to npm installation, GitHub source, and release notes
- keep the site decoupled from local Craig workspace state and private task artifacts

#### Verification

- run the site's build or static export command
- manually review the site on mobile and desktop widths
- manually verify install instructions match the published npm package and current CLI behavior
- manually verify no private repo names, local paths, task prompts, logs, `.context`, or `.craig` artifacts are included in public assets

#### Tracking update

- keep `8.1` open if the site promises workflows not yet implemented in Craig
- keep `8.1` open if privacy/security language is absent or inconsistent with the package and runtime behavior
- keep `8.1` open if public assets include private workspace details

### Acceptance criteria

- `[0.1]` Craig starts without exposing the old Ink shell, REPL parser flow, or `tmux`-driven interactive UX.
- `[1.1]` Craig renders the required logo treatment in the boot and pause overlay and presents a three-column shell with the specified panel hierarchy.
- `[1.2]` Craig owns input in control mode with stable keyboard navigation and no competing stdin consumer.
- `[2.1]` The selected task can enter terminal mode, interact with a live PTY, and return to control mode with `Ctrl + ]`.
- `[2.2]` The Terminal surface renders through a real emulator screen model with color, clear-screen, cursor movement, resize, detach, and reattach behavior working in a real PTY-backed session.
- `[3.1]` Creating a task provisions a branch and worktree, persists PTY-tab-aware task state under `.craig/`, and auto-boots the initial Codex agent tab in that task worktree.
- `[3.2]` Restarting Craig restores the prior workspace orientation, including selected PTY tab when persisted state is still valid.
- `[3.3]` One task can manage multiple PTY-backed `agent` and `terminal` tabs without reshaping the task/worktree model.
- `[3.4]` Craig can preserve and reattach to live task PTY sessions across foreground UI exits through a Craig-owned background daemon.
- `[4.1]` Files and changes inspection are available inside the Craig shell, with right-panel navigation and center-panel detail views for real task worktrees.
- `[4.2]` Craig can create and sync a PR for a task branch while persisting tracked PR metadata on the task.
- `[4.3]` Craig can read CI/check state for a tracked PR or task head commit and explain whether it is passing, pending, failing, skipped, or unknown.
- `[4.4]` Craig can merge a ready PR and close the task through guarded actions that preserve recovery state when cleanup is incomplete.
- `[5.1]` Craig can create and run Codex, Cursor, and Claude tasks through explicit runner profiles without changing task/worktree semantics.
- `[5.2]` Craig can open a parent-directory workspace such as `~/projects`, discover direct child Git repos, immediately create project-level tasks with per-repo worktree targets for accessible direct child repos, and present Files, Changes, and Review as repo-grouped expandable workspace views.
- `[5.2]` Craig can save overlapping project and repo workspaces such as `~/projects` and `~/projects/craig` at the same time without hiding, merging, or misrouting either workspace.
- `[5.2]` Project-task Review displays per-repo PR, check, and merge state read-only; action dispatch for project tasks is agent-owned.
- `[6.1]` Craig's shell is polished enough for repeated daily use across normal terminal sizes, with a deliberate color palette, clear focus, truncation, empty states, grouped workspace scanability, and efficient next actions.
- `[6.2]` Craig can play configurable video-game-like sound effects for important workflow events, and those effects can be fully muted without disrupting terminal operation.
- `[7.1]` Craig can be packed and published to npm through an allowlisted artifact workflow with CI static analysis that fails on likely source, secret, local workspace, or task-artifact leakage.
- `[8.1]` Craig has a public marketing/docs entrypoint with accurate install instructions, workflow visuals, and privacy/security language that does not expose private local workspace data.
