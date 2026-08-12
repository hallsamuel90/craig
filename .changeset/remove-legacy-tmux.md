---
"craig-cli": minor
---

Remove the legacy tmux execution substrate and the obsolete `task attach` and `task focus` commands. CLI-created tasks now launch directly into their durable Craig PTY daemon agent tab, matching TUI and delegated task behavior without requiring tmux to be installed. Connected TUIs also refresh automatically when another process creates, updates, or closes a task.
