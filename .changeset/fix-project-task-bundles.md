---
"craig-cli": patch
---

Fix project task bundle creation for repositories whose default branch is not `main`, and fail cleanly instead of creating a manifest-only bundle when every repo target cannot be provisioned.
