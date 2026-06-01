---
"craig-cli": patch
---

Show PR lifecycle and CI check status icons on left nav task rows.

Each task row in the left panel now displays a right-aligned badge with the PR state icon and check status icon when a PR exists. Icons reuse the same color coding as the right inspection panel. Text status labels (`running`, `merge_ready`, etc.) are removed from task rows in favour of the icons.
