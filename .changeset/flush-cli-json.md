---
"craig-cli": patch
---

Flush buffered stdout and stderr before exiting so large piped JSON results and errors remain complete and parseable.
