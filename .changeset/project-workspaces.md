---
"craig-cli": minor
---

Add project workspace support with multi-repo task provisioning and review panel.

Project workspaces span multiple repos under a shared root directory. Craig discovers child repos automatically and provisions a worktree for each when a project task is created. The agent runs once with access to all worktrees through a shared bundle root.

The TUI left panel shows project workspaces with a `▦` icon and a `Repos (N)` summary. The Review inspector panel displays per-repo PR and check state for project tasks.

Also fixes a workspace resolution bug where a stale `selectedWorkspaceId` could cause the TUI to display the wrong workspace when navigating between tasks.
