---
"craig-cli": patch
---

Keep heartbeat-driven GitHub polling responsive by updating only the tasks that were polled instead of reloading and reinspecting the full workspace.
