---
"craig-cli": patch
---

Prevent Fury child startup from timing out while waiting for the orchestration supervisor to acknowledge its own work. Supervisor wake requests now acknowledge scheduling without waiting for reconciliation, with asynchronous failures recorded in the error log.

Keep Fury scheduling and child-task cleanup in the workspace daemon so agent completions do not inherit worker Git sandbox restrictions. Preserve read-only run/review inspection after preview disablement, pause new agent steps while disabled, and recover pending work and cleanup across daemon restarts. Surface retryable cleanup failures and supervisor notification failures, track initial child prompt failures, and include review resubmission instructions in feedback.

Allow sandboxed workers to submit durable work through a fresh, protocol-compatible supervisor heartbeat when socket access is denied. Disable embedded Codex startup update checks and reject known startup dialogs before prompt delivery. Preserve existing review history across checkpoint recovery and reject expired approvals and completions.
