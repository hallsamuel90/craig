# Pre-RFC lifecycle fixtures

Source checkout: `a2a1fbcd146898bc46c396ae957942d6c3041b9a`.

- `pre-rfc-daemon.ts.txt` is the unchanged `src/ui/pty/daemon.ts` from that checkout. The process test bundles this snapshot against the child checkout's PTY implementation and dependencies, with polling disabled, in a disposable workspace. It tests a real legacy protocol handshake and actual native PTY/agent process; it is not a packaged-installation test (phase 4.1).
- `pre-rfc-tui.ts` freezes the actual `ensureDaemonRunning` path and its probe/cleanup helpers from the same file. Server-only helpers are omitted. Imports, export visibility, logging and spawn dependencies are adapted to a fixture; protocol negotiation and startup decision bodies are unchanged.
- `pre-rfc-delegated.ts` freezes `ensureDaemonRunning` and its probe helpers from `src/shell/pty-daemon-orchestration.ts`. The endpoint points to a fixture-only socket; spawn is counted rather than executed.

Neither launcher imports the new lifecycle resolver. A successful protocol-0 ping must cause the original launcher to reject before spawn, shutdown, or stale cleanup. The resident guard itself belongs to phase 2.1.

## Reproducible package/host snapshots

`runtime-snapshots.json` records the exact source commits, compressed SHA-256 hashes,
and source path allowlist for `pre-rfc-package.tar.gz` and `phase2-runtime.tar.gz`.
These contain public CLI sources and build/package inputs, including the MIT
license. Co-located source tests are retained because the old build identity
hashed the complete source tree; the top-level tests tree is excluded. The
archives exclude dependency trees, generated bundles, private workspace state
and repository guidance. Integration tests verify the checksum, unpack into a fresh
temporary source tree, then build against their isolated test dependency closure.
The fixtures remain usable in shallow CI checkouts and after squash merges;
never fetch an old off-branch commit or replace it with current source at runtime.
The phase-2 snapshot intentionally lacks newer host retirement and key-encoding
operations, so tests exercise a genuine older implementation and its adapters.
