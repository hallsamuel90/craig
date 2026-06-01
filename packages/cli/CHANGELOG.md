# craig-cli

## 0.4.1

### Patch Changes

- e7f3bcc: Show PR lifecycle and CI check status icons on left nav task rows.

  Each task row in the left panel now displays a right-aligned badge with the PR state icon and check status icon when a PR exists. Icons reuse the same color coding as the right inspection panel. Text status labels (`running`, `merge_ready`, etc.) are removed from task rows in favour of the icons.

## 0.4.0

### Minor Changes

- 55e1e3d: Add project workspace support with multi-repo task provisioning and review panel.

  Project workspaces span multiple repos under a shared root directory. Craig discovers child repos automatically and provisions a worktree for each when a project task is created. The agent runs once with access to all worktrees through a shared bundle root.

  The TUI left panel shows project workspaces with a `▦` icon and a `Repos (N)` summary. The Review inspector panel displays per-repo PR and check state for project tasks.

  Also fixes a workspace resolution bug where a stale `selectedWorkspaceId` could cause the TUI to display the wrong workspace when navigating between tasks.

## 0.3.1

### Patch Changes

- 3620dfb: Fix alternate-runner agent tabs so creating and attaching a second runner tab opens the live PTY instead of showing the attach prompt.

## 0.3.0

### Minor Changes

- f59cffe: TUI polish: full-width context-aware footer and panel navigation fixes

  The command bar is now a full-width footer spanning all three panels, showing keybinding hints that update based on which panel and mode is active. The review panel's "sync PR" and "close task" actions moved into the footer. Arrow keys no longer cross panel boundaries (use Tab/Shift-Tab), and Tab from the inspector panel no longer drops into an invisible focus region.

## 0.2.1

### Patch Changes

- 0554da4: Add proprietary license metadata and update the README around TUI-first usage.

## 0.2.0

### Minor Changes

- 7320da7: Ship Craig as a minified Node CLI package.
