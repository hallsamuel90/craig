# Pre-RFC lifecycle fixtures

Source checkout: `a2a1fbcd146898bc46c396ae957942d6c3041b9a`.

- `pre-rfc-daemon.ts.txt` is the unchanged `src/ui/pty/daemon.ts` from that checkout. The process test bundles this snapshot against the child checkout's PTY implementation and dependencies, with polling disabled, in a disposable workspace. It tests a real legacy protocol handshake and actual native PTY/agent process; it is not a packaged-installation test (phase 4.1).
- `pre-rfc-tui.ts` freezes the actual `ensureDaemonRunning` path and its probe/cleanup helpers from the same file. Server-only helpers are omitted. Imports, export visibility, logging and spawn dependencies are adapted to a fixture; protocol negotiation and startup decision bodies are unchanged.
- `pre-rfc-delegated.ts` freezes `ensureDaemonRunning` and its probe helpers from `src/shell/pty-daemon-orchestration.ts`. The endpoint points to a fixture-only socket; spawn is counted rather than executed.

Neither launcher imports the new lifecycle resolver. A successful protocol-0 ping must cause the original launcher to reject before spawn, shutdown, or stale cleanup. The resident guard itself belongs to phase 2.1.
