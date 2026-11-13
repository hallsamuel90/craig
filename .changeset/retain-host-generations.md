---
"craig-cli": patch
---

Apply updated session-host revisions to new sessions while keeping existing agents and retained terminal views on their original hosts. Retire hosts only after an atomic check of processes, views, pending creates and holds, and clean verified unused runtime artifacts across workspaces without removing live or rollback dependencies.
