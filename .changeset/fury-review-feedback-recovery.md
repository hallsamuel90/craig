---
"craig-cli": patch
---

Dispatch Fury review feedback only after its human decision is durably accepted. Recover interrupted feedback dispatch without duplicating commands, cancel superseded feedback before delivery, and clean up queued feedback on existing task targets when a run terminates. Mark unfinished steps cancelled when a sibling failure ends the run.
