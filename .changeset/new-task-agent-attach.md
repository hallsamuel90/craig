---
"craig-cli": patch
---

Fix new task creation so the agent PTY starts against the freshly created task model instead of falling back to an empty shell.

Fix PR polling and refresh so a follow-up PR opened from the current worktree branch becomes the visible active PR while older merged or closed PRs remain available as previous PR history.
