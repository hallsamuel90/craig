---
"craig": minor
---

Sequential PR support, bug fixes, and PTY engagement indicator.

- Tasks now support multiple sequential PRs — when a PR is merged or closed, the poller and discovery logic automatically track the next open PR on the branch
- Fixed `craig task show` corrupting project task PR state by querying the wrong repo
- Fixed project tasks showing "not linked" in the CLI despite having per-target PRs
- Fixed focused region not switching to the center panel when a new task creation attaches the PTY
- Added `engaged ●` indicator in the center tab row when the terminal PTY is active
- Footer brightens when the PTY is attached or a modal input is open to draw focus
- Removed noisy `● live/idle` label from the top rail
