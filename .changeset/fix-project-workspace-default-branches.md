---
"craig-cli": patch
---

Fix project workspace registration so discovered repos use their trunk/default branch instead of the currently checked-out feature branch, and prevent project task PTYs from accidentally resolving Git commands to a parent repo outside the task bundle.
