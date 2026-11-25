---
"craig-cli": patch
---

Allow up to thirty seconds for a drained control service to release ownership during replacement and explicit workspace shutdown. Slow native watcher teardown no longer prematurely blocks a safe replacement or leaves an empty workspace guard running; live owners are never force-killed.
