---
"craig-cli": patch
---

Automatically refresh agent capabilities while their daemon-owned sessions are running, preserving the existing token, scope, and limits so long-running agents keep working beyond seven days. Agent commands also refresh on demand after long sleeps or when using an older compatible daemon, without restarting PTYs. Revoked credentials remain denied, and inactive sessions retain their expiry.
