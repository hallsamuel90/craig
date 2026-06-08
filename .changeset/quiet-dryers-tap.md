---
"craig-cli": patch
---

Fix the in-app update check to compare against the published craig-cli package instead of an unrelated npm package, keep the selected PTY tab focused when attaching from the left task list, and reassert Craig's fullscreen terminal screen on resume/resize redraws.
