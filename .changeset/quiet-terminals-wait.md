---
"craig-cli": patch
---

Avoid injecting OSC color query responses into embedded terminal sessions so interactive prompts such as `gh auth login` do not receive unexpected escape sequences as input.
