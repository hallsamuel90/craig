# RFC: libghostty terminal emulation

- **Date:** 2026-11-09
- **Status:** In Flight
- **Author:** Sam / Codex
- **Related issue:** [#310](https://github.com/hallsamuel90/craig/issues/310)
- **Amends:** [Terminal workspace rewrite](2026-05-01-rfc-craig-terminal-workspace-rewrite.md)

## Context and goals

**Current state (2026-11-13): the opt-in Ghostty backend is implemented locally.** Enable **Options → Feature Previews → Ghostty terminal (new sessions)** in a build containing this change. Xterm remains the default. The adapter, embedded offline artifact, key encoder and daemon selection are implemented and pass the local release gates. Linux CI, long-running workload validation and the broader performance gate remain before shipping; the preview has not graduated to stable/default behavior.

The intended benefits are terminal correctness, removing Craig's terminal workarounds, and reducing parsing overhead during heavy agent output. GPU rendering and standalone executable distribution are separate projects.

### Current responsibilities

| Responsibility | Current owner | Proposed owner |
| --- | --- | --- |
| Process spawn, input, signals, resize, exit | `node-pty` in `src/ui/pty/runtime.ts` | Keep |
| Session lifetime, agent activity, startup blocker detection | `PtyRuntime` | Keep; consume an emulator-neutral interface |
| Durable daemon, socket protocol, view subscriptions and patches | `src/ui/pty/daemon.ts` | Keep |
| VT parsing, buffers, cursor, styles, reflow | `@xterm/headless` via `src/ui/terminal-emulator.ts` | libghostty-vt Wasm for preview sessions |
| Codex CSI S transcript retention | `src/ui/terminal-scrollback.ts`, rewriting CSI S into cursor movement and line feeds | Native Ghostty behavior; retain adapter only for xterm |
| OSC 8 URL lookup | `src/ui/terminal-links.ts`, accessing private xterm cell/link service fields | Public grid-reference hyperlink API |
| Query replies | `respondToTerminalQueries` in PTY runtime, searching each incoming chunk and hard-coding replies | Ghostty WRITE_PTY callback for Ghostty sessions |
| Key encoding | `mapKeyToPtyInput` in PTY runtime | Initially keep; constrain advertised keyboard support |
| Styled row conversion and terminal drawing | `terminal-emulator.ts`, `shell/data.ts`, `render.ts`, terminal-kit | Keep `TerminalScreenRow` contract and drawing pipeline |

The daemon already publishes rendered rows. Emulator state need not cross the socket or enter domain services. Startup blocker reads and viewport bounds previously accessed xterm directly; both now use the emulator interface described below.

### Upstream assessment

Use the released **libghostty-vt 1.0.0**, not the Ghostty application's internal embedder API. Its [versioned public header](https://github.com/ghostty-org/ghostty/blob/vt-1.0.0/include/ghostty/vt.h) declares C ABI stability from 1.0. Older articles and main-branch search excerpts describing a pre-stable API are not the contract for this pin.

The [versioned packaging guide](https://github.com/ghostty-org/ghostty/blob/vt-1.0.0/PACKAGING-LIBGHOSTTY.md) supplies official Wasm builds and documents macOS, Linux, Windows, and other native targets. Wasm is a portable option, but this investigation executes only macOS ARM64. Linux and Node 22 PTY integration remain rollout gates. Building native artifacts introduces a Zig toolchain, platform builds, and a Node bridge; it is unnecessary for the first integration.

The [MIT license](https://github.com/ghostty-org/ghostty/blob/vt-1.0.0/LICENSE) permits integration; distribution must preserve its copyright and license notice. Audit the pinned artifact's dependency notices before shipping.

| Approach | Assessment |
| --- | --- |
| Official Wasm plus a small Craig-owned adapter | Selected: no additional native addon, official artifact, standard Node WebAssembly APIs |
| Native C ABI with N-API bridge | Possible later if measured Wasm costs justify platform build and distribution maintenance |
| Third-party JS/browser terminal wrapper | Not required; its bindings, artifact provenance, and DOM assumptions add another contract to audit |
| Ghostty app/internal GPU embedder | Does not fit Craig's existing terminal rendering surface |

## Investigation evidence

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx scripts/libghostty-spike.mjs
```

The script downloads the official release to the OS temp directory on first use, checks SHA-256 on every run, inspects the Wasm ABI metadata, runs assertions, and prints JSON. No Wasm binary, new dependency, or runtime backend switch is added to the CLI. The follow-up adds a real Codex startup replay fixture and synthetic styled-frame workloads.

- Artifact: `https://release.files.ghostty.org/libghostty-vt/1.0.0/ghostty-vt-1.0.0.wasm`
- SHA-256: `7b428fee6d0677bc81279458f8f9a3335454834123a9ff47efb3fd177f6da5a8`, compared with upstream `SHA256SUMS`.
- Size: 1,240,850 bytes; Wasm instantiation about 1.1 ms in the observed Node 24 run. This excludes download, process startup, and npm embedding overhead.
- Host: macOS ARM64, Node 24.12.0, xterm/headless 6.0.0.
- No Wasm imports required. The exported indirect-function table accepts a tiny Wasm callback trampoline that re-exports a JavaScript function; terminal replies require no experimental V8 APIs.

### Functional checks

The spike verifies:

- Visible text and cursor parity for writes, movement, erase, wrapping, SGR input, alternate-screen entry/exit, wide characters and combining marks. This is selected fixture coverage, not full VT conformance.
- Byte-by-byte UTF-8 and control-sequence parsing agrees with whole writes.
- Public OSC 8 hyperlink lookup, RGB foreground/bold style access, link retention in history, and clearing links on overwrite.
- Split cursor-position query returns the actual cursor (`CSI 3;7 R`), plus primary device and Kitty keyboard query responses.
- A real `node-pty` Node child starts in the asserted cwd, resizes, receives Ghostty's cursor reply, prints an acknowledgment, and exits successfully. This is not Craig's task-launch E2E.

Scroll behavior at 20 columns / 6 rows, with two lines scrolled using CSI S:

| Fixture | Ghostty native history | Craig with existing rewrite | Visible text |
| --- | ---: | ---: | --- |
| Full screen | 2 | 2 | Equal |
| Codex protected composer, region rows 1–5 | 2 | 2 | Equal |
| Interior region, rows 2–5 | 0 | 0 | Equal |
| Alternate screen | 0 | 0 | Equal |

One intentional difference: write `abcdefghijklmnopqrstuvwxyz` at width 20 with the cursor on its second wrapped row, then shrink to 12 columns. Ghostty preserves all letters as `abcdefghijkl`, `mnopqrstuvwx`, `yz`. Current xterm/Craig produces `abcdefghijkl`, `uvwxyz` in this fixture. The script asserts Ghostty's preserved text and records both outputs. This is a reproducible example, not a claim that all resize cases are fixed.

### Performance and limits

Synthetic input: 1,160,000 ASCII/SGR bytes, 4 KiB chunks, 120×40 viewport, 1,000-line history cap; one warm-up round and five measured rounds. Representative Node 24 medians:

| Measurement | Ghostty prototype | xterm | Craig xterm wrapper |
| --- | ---: | ---: | ---: |
| Parse, awaiting every chunk callback | 2.65 ms | 336.92 ms | 351.47 ms |
| Parse, queue xterm chunks and await completion once | 2.59 ms | 11.88 ms | Not measured |
| Plain-text viewport read, per frame | 1.33 ms | 0.0175 ms | Not measured |

The first row is dominated by xterm's callback scheduling and must not be advertised as a parser speedup. The queued comparison suggests about **4.6× faster parsing** for this workload. It does not establish agent-output latency, responsiveness, or end-to-end speedup.

The original prototype uses the render-state iterator but makes multiple Wasm calls per cell. Its plain frame read is about **75× slower** than xterm's optimized plain-line reader. These original reads do not include full style conversion, segment coalescing, hyperlink filtering, cursor painting, daemon serialization, or terminal-kit drawing. The follow-up below measures an optimized reader with full styled rows instead.

Original investigation limits included no real Codex replay or multi-session soak; the follow-up adds bounded versions of both. Linux and packaged offline Wasm execution remain unverified. Snapshot memory after repeated runs is a Wasm linear-memory high-water mark, not proof against leaks. The spike remains experimental: production needs exception-safe construction, disposal/write-race handling and explicit callback reentrancy rules.

### Follow-up: backend boundary and styled frames

`src/ui/terminal-emulator.ts` now defines the UI-owned `TerminalSize`, `TerminalEmulator`, options and factory contract. Its default factory uses the xterm adapter in `src/ui/terminal-xterm.ts`. `PtyRuntime` accepts an injected factory and uses only:

```ts
interface TerminalEmulator {
  write(chunk: string): Promise<void>;
  resize(size: TerminalSize): void;
  renderRows(scrollbackLines?: number): TerminalScreenRow[];
  getActiveScreenText(): string;
  getScrollbackLength(): number;
  dispose(): void;
}
```

`write` resolves after parsing; subsequent reads observe that output. The factory receives `onReply(data)`, which the runtime forwards to the PTY. Existing xterm query behavior moves unchanged into the adapter, so a replacement can own replies without duplicate runtime responses. Xterm types, buffers, links and the CSI S writer are confined to the adapter and its helpers. `PtySize` remains an alias for compatibility with existing callers. Failed PTY spawning now disposes the allocated emulator; command resolution occurs before emulator allocation. A patch Changeset covers this startup resource fix.

The optimized reader in `scripts/libghostty-frame-reader.mjs` uses manifest-derived bulk raw cells, one batched metadata query, row-local style lookup caches, and cached decoded/segmented clean rows. It retrieves full graphemes only for complex cells and public grid references only for hyperlinks. URI validation and underlined link styles are reused within rows. Sized buffers grow for long metadata, and memory views refresh after Wasm growth. It preserves Craig's current padded-row and inverse-cursor output shape; it also reads native cursor visibility separately. It does not yet change Craig's existing behavior of painting an inverse cursor even when the program hides it.

Correctness checks compare the optimized reader against independent per-cell C getters on separate terminals and against Craig's current styled renderer after every benchmark frame. Fixtures exercise all currently represented style flags, ANSI/256/RGB colors, CJK/combining text, links, unsafe URI rejection, overwrites, alternate screens, scrolling history, cursor movement/visibility, resize and palette invalidation. Additional checks force cold full-frame decoding, verify unchanged row reuse, grow Wasm memory, and repeatedly create/dispose sessions.

The checked-in `scripts/fixtures/codex-startup-replay.json` contains 46 original PTY chunks from a real Codex 0.165.0 startup, update dialog, composer and Ctrl-C exit at 120×40. No prompt was submitted or agent work performed. Private paths were replaced before check-in. Every replayed chunk matches the independent Ghostty reference exactly, and matches Craig's styled content when trailing unstyled padding is ignored. This normalization handles a width difference in the update dialog's emoji; it does not ignore text, links, styles or cursor overlays. This startup trace does not substitute for a long-running agent/tool-output trace.

Representative Node 24.12.0 / macOS ARM64 results, one warm-up and three measured rounds, rendering after each input chunk. Raw results are retained for [Node 24](evidence/2026-11-09-libghostty-node24.json) and [Node 22](evidence/2026-11-09-libghostty-node22.json):

| Workload | Ghostty styled frame median / p95 | Ghostty parse + styled frame + JSON p95 | Craig parse + styled frame + JSON p95 |
| --- | ---: | ---: | ---: |
| Real Codex startup, 46 frames | 0.006 / 0.79 ms | 0.80 ms | 2.34 ms |
| Protected composer, 65 frames | 0.84 / 1.17 ms | 1.19 ms | 4.68 ms |
| Full repaint, 24 frames | 0.92 / 1.04 ms | 1.09 ms | 2.72 ms |
| Dense hyperlinks, 12 frames | 2.63 / 4.48 ms | 4.69 ms | 4.11 ms |

All measured styled frames fit the 16 ms budget (largest observed 5.09 ms). Core-workload combined timings improve, but the dense-link combined p95 regresses in this run despite a better median (2.83 vs 3.82 ms). Do not mark the broader no-regression gate complete. JSON serialization is included; actual daemon socket/patch processing and terminal-kit drawing are not. Craig's asynchronous write scheduling is part of these combined measurements, so these ratios must not be described as parser-only speedups. Benchmark runs are sequential across Node versions to avoid resource contention.

A paced event-loop sentinel during composer replay observes Ghostty p95 1.27 ms / max 3.15 ms; Craig p95 0.16 ms / max 0.64 ms. Ghostty's synchronous work blocks a queued turn longer even while total frame completion is faster. Production needs a bounded work/yield strategy for output bursts; this test does not prove daemon responsiveness.

Three cycles of 20 simultaneous 120×40 sessions stabilized the shared Wasm high-water mark at 22,151,168 bytes after the first cycle, with no further growth in the next two. The library reports 393,216 primary resident bytes for one terminal core in this fixture; render caches, JS objects and runtime overhead are additional. Another 100 create/render/dispose iterations pass, as does reading a cached frame after explicit memory growth. This is a bounded reuse check, not a leak proof, RSS comparison or long-running soak.

Compatibility findings to resolve during the preview:

- For `👩‍💻 done`, Ghostty reports cursor column 9 and xterm 7. Native grapheme/width behavior needs testing against supported outer terminals, particularly before later text is drawn on the same line.
- A 2,068-byte OSC 8 URI is retained by xterm but rejected by Ghostty in this artifact. A 1,520-byte URI is handled, including reader-buffer growth. Decide/document long-link behavior rather than silently claiming full link parity.
- The existing xterm renderer always overlays the cursor and uses a fixed palette. The spike preserves the cursor output shape and separately verifies native palette invalidation; rollout must deliberately choose visibility/palette behavior instead of hiding changes inside the backend swap.

**Decision:** the architecture prerequisite is complete, and Wasm remains the selected integration path. Styled extraction is fast enough to continue to the opt-in backend; dense-link tails, input/width compatibility and actual daemon measurements remain acceptance work. No native bridge is justified by the current evidence.

## Non-goals

- Replacing `node-pty`, rewriting the daemon transport, or building a desktop app.
- GPU drawing, fonts, images, or automatic visual parity with the Ghostty GUI.
- Promising a standalone executable or changing the publishing process from #309.
- Enabling every keyboard/mouse/clipboard protocol Ghostty understands before Craig can support it end-to-end.

## Proposal

### Emulator boundary and lifetime

The UI-owned emulator contract now covers write/flush, resize, viewport bounds, styled visible rows, plain active-screen text, replies, and dispose. The runtime retains its scrollback offset and requests rows at that offset. Keep the current `TerminalScreenRow` / `TerminalCellStyle` output shape. Neither domain types nor socket payloads should contain xterm handles, Wasm pointers, or backend-specific state.

The implementation lazily initializes one verified Wasm instance when the daemon first creates a Ghostty session, before spawning its PTY. This avoids compiling Wasm while the preview is off. Create terminal/render/key-encoder handles per session. Reuse one callback slot per module, routing by terminal handle. Remove callbacks and free all session resources on close or failed construction. Reacquire typed arrays/DataViews after every allocating Wasm call; memory growth invalidates old views. Do not hold grid references across writes or resize. Copy reply bytes inside the callback and flush them to the PTY after the parser returns, without reentering the same emulator.

Use render-state raw row views and dirty rows for frames; use grid references only for hyperlink-bearing cells. Decode using the pin's exported type layout, with explicit ABI/version checks. Cache unchanged styled rows and batch metadata queries. Preserve default-color versus explicit-color semantics, width-zero continuation behavior, combining text, link filtering, cursor visibility, and palette handling. Native history replaces the CSI S rewrite only for Ghostty sessions.

### Protocol compatibility

Choose one query-reply owner per session. Ghostty sessions must bypass `respondToTerminalQueries`; xterm retains its existing path until separately improved. Do not let both write replies for one query.

The adapter uses Ghostty's native key encoder, synchronized from terminal state before encoding each key. Tests cover legacy Ctrl/Enter/arrows, application cursor mode and Kitty Ctrl/Shift-Enter. Raw input, including bracketed paste bytes, passes through the existing runtime path. Xterm keeps its existing key mapping. Mouse/focus event forwarding and complete outer-terminal paste negotiation are not newly implemented; validate real applications before claiming complete protocol coverage.

### Packaging decision

Keep the strict `craig-cli` files allowlist (`dist/cli.js`, `README.md`, `package.json`). Embed the verified Wasm as base64 bytes inside the minified esbuild output; instantiate from bytes, without runtime downloads or sidecar paths. Budget approximately 1.65 MB of base64 source before compression for the current artifact, and measure actual bundle/RSS/startup costs.

Acquire the pinned artifact at build time through a checksummed, cacheable script, verifying upstream signatures during pin updates. Preserve the upstream license and required third-party notices inside an allowed published file. Do not add platform packages, publish source, enable source maps, or publish locally. Run offline package smoke tests to prove the artifact is embedded. Pin updates must include ABI checks and fixture replay, not a floating nightly.

### Implemented packaging and preview (2026-11-13)

- `scripts/prepare-ghostty.mjs` downloads the pinned official Wasm at development/build/test time, verifies its hard-coded SHA-256 before caching or embedding, and atomically generates the ignored `src/ui/ghostty/wasm.generated.ts`. A corrupted cache fails closed; it is not silently replaced. `pnpm ghostty:prepare` prepares explicitly; `CRAIG_GHOSTTY_OFFLINE=1` forbids acquisition when the verified cache is absent. Tests, typecheck, development and both build paths prepare automatically. There is no new npm dependency.
- `src/ui/ghostty/wasm.ts` imports the generated literal, verifies the embedded digest and checks manifest version, schema, pointer widths and endianness before use. The installed CLI performs no download or asset-path lookup. The minified npm bundle is 2,212,587 bytes in the recorded build; its three-file package allowlist is unchanged.
- `packages/cli/README.md` includes Ghostty and dependency notices. These were collected from the checksummed source/dependency archives and the pinned uucode license files; the selected BSD/MIT options, Unicode V3 and Zig/UTF-8 decoder notices are retained. `package:audit` checks the embedded checksum/module validity and required notice markers.
- `src/ui/ghostty/emulator.ts` implements the neutral interface with native scrollback and styled rows, per-session allocations, one shared reply trampoline, idempotent disposal, queued writes, 16 KiB parser slices and a yield after approximately 4 ms of accumulated parsing. It applies a 1,000-line and 8 MiB history policy (the library prunes at page granularity), disables host image facilities, and leaves clipboard/notification effects unbound. Failed runtime writes produce a failed view/activity and dispose the PTY/backend once. Pending writes are canceled safely after disposal.
- The production reader honors native cursor visibility; the old spike preserves xterm's old always-painted cursor for comparisons. The adapter supplies Craig's initial palette and supports native palette updates. Existing emoji-width and overlong-URL differences remain documented experimental behavior; they are not silently normalized in the live adapter.
- The daemon reloads preview configuration only for new sessions and passes the selected factory into `PtyRuntime`. Existing sessions retain their backend across toggle changes and reattachment. Ping now advertises an optional Ghostty capability without changing protocol version. New clients can reattach existing sessions on compatible older daemons; an enabled preview cannot silently create an xterm session there and instead reports how to disable the preview or restart after closing sessions.
- `package:smoke` installs the tarball into an unrelated temporary project, loads that installation's native PTY addon, disables `fetch`, and creates a real Ghostty PTY through the packed daemon. Its child receives `CSI 3;7 R` and acknowledges the round trip in a rendered daemon view. This distinguishes Ghostty from the old hard-coded xterm response and proves the shipped embedded artifact is usable offline.

**Binary-thread handoff:** run `pnpm ghostty:prepare` before compiling the same CLI entry point. Bundle the generated literal into the executable; no Wasm sidecar, runtime download, extra native Ghostty addon, or change to the current npm files allowlist is required. Run `pnpm verify:artifact --executable /absolute/path/to/craig --profile soak --report /tmp/terminal-soak.json` against the final executable. This covers its WebAssembly runtime, real PTYs, normal daemon self-bootstrap and task-worktree startup; the stub peer still requires host Node. Binary distribution itself remains separate work.

## Implementation tracker

### Status summary

| Phase | Implementation | Verification |
| --- | --- | --- |
| 0 — investigation | Complete: standalone executable spike and this assessment | Functional, scroll and synthetic performance checks passed on macOS ARM64 / Node 22 and 24; real PTY check passed on Node 24; Node 22 PTY deferred |
| 1 — opt-in terminal backend | Implemented locally: adapter, toggle, native key encoder, offline packaging, cleanup and daemon selection | Draft prepared against current main; focused terminal/app tests, Node 22 checks, artifact stress and packaging pass locally; full suite has three reproduced baseline daemon failures. Linux/offline CI and native binary execution remain pending; real agent traces, RSS and dense-link tail still need evidence |
| 2 — stable adoption | Not implemented | Pending preview evidence and cross-platform soak |

### Verification summary

Phase 0's executed evidence is recorded above; it does not certify production compatibility. Final checks:

- `pnpm exec tsx scripts/libghostty-spike.mjs`: all five groups passed, including real PTY cwd, asserted resized dimensions, query reply and clean exit.
- `pnpm --package=node@22.23.4 dlx node --import tsx scripts/libghostty-spike.mjs --skip-pty`: four non-PTY groups, scrolling checks and benchmarks passed. The initial run with PTY enabled failed because this checkout's existing native `node-pty` addon targets Node 24's ABI (137), while Node 22 requires 127. No shared addon was rebuilt; real Node 22 PTY verification remains deferred to a matching install.
- `pnpm exec vitest run tests/pty-runtime.test.ts tests/ui-app-terminal.test.ts`: 124 tests passed across two files. These exercise the existing Craig backend; they do not certify the proposed Ghostty integration.
- `pnpm typecheck`, `pnpm exec eslint scripts/libghostty-spike.mjs`, and `git diff --check`: passed.
- Full release/package gates and Craig real-terminal E2E were not run for this investigation; Phase 1 must run them. Linux execution remains unverified.

Follow-up verification:

- Final Node 24 spike: 11 assertion groups passed, including real PTY and all-frame styled workload comparisons. The Node 22 run skips only the native PTY check because of the existing addon ABI mismatch; results are retained alongside the Node 24 evidence.
- Runtime contract tests: all 28 passed, including a backend with no xterm buffers, single-owner replies, startup screen, bounded scrollback, resize, disposal and failed-spawn cleanup. Existing app-shell and real-terminal E2E suites passed (112 tests), including selected-task attach and new-task direct entry. No launcher code changed.
- Daemon suite: 28 passed; three failed in semantic PR synchronization, external-task notification and event-watch reconnect. The same three failures and an event-watcher cleanup rejection reproduce at unchanged `HEAD` (`3028120`) in an isolated temporary worktree. Record these as baseline failures, not successful release gates; that worktree was removed after verification.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, `pnpm package:smoke` and `git diff --check` passed for the boundary change. Full `pnpm test` was not run; focused runtime/daemon/app/terminal suites were used.
- The published artifact still uses xterm, with the strict allowlist intact. Passing its audit/smoke does not verify Wasm embedding, which is still unimplemented. Linux remains unverified.

Phase 0 itself was investigation-only. The follow-up changes the production boundary and adds a patch Changeset for startup resource cleanup; no package dependencies or preview configuration change.

2026-11-13 implementation verification supersedes the earlier unimplemented-packaging and deferred Node 22 PTY notes above:

- `pnpm test`: **850 tests passed across 72 files**. The prior baseline daemon failures did not reproduce in this final run. Coverage includes live toggle switching without respawning old sessions, legacy daemon capability handling, safe links/styles/history, split replies, native key modes, disposal races, failure cleanup, checksum failures and the existing application shell.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `CRAIG_GHOSTTY_OFFLINE=1 pnpm build:npm`, `pnpm package:audit` and `pnpm package:smoke`: passed. The build used its verified cache while offline acquisition was forbidden; the packed runtime succeeded with downloads disabled.
- Real-terminal E2E adds Ghostty cases for selected-task Codex startup in the selected worktree and new-task direct entry into its new worktree. The expanded real-terminal/app-shell run passed 114 tests; these cases are also included in the full suite.
- Node 22.23.4: seven Ghostty/build tests passed. `pnpm --package=node@22.23.4 dlx node scripts/package-smoke.mjs` passed using the temporary installation's Node 22 native PTY addon, resolving the earlier checkout ABI limitation without rebuilding the shared checkout's addon.
- Linux and actual standalone executable validation were not executed locally. Longer real agent/tool traces, broad input/mouse/paste compatibility, resident-memory soak and actual daemon latency percentiles remain unverified. No publish, global installation, PR, or default-backend change was performed.
- A `patch` Changeset for `craig-cli` covers the experimental preview; the separate patch Changeset covers terminal failure cleanup.

2026-11-22 aggressive verification:

- Added `pnpm verify:terminal`: **64 tests across five files passed**. New fixed-seed checks compare cached frames with fresh native replay at 320 checkpoints and portable styled output with xterm at 180 checkpoints. Native wide-cell overwrite attribute differences have an explicit expectation rather than being filtered out. Node 22.23.4 passed all **20 Ghostty/build/regression tests**.
- Six cycles of 12 simultaneous native terminals, each receiving 10,000 lines, returned session counts to baseline and reached a shared Wasm-memory plateau within one page after warm-up. This measures linear-memory allocation reuse, not process RSS. Deterministic scheduling/disposal tests caught and fixed a real bug: disposing from a reply callback could previously deliver subsequent already-queued replies.
- Added `pnpm verify:artifact --executable /path/to/craig --profile quick|soak --report /tmp/report.json`. The built-ins-only driver tests both backends through real PTYs: fragmented Unicode, query ownership, raw paste, application cursor keys, flood/resize, styles/links, reconnect/toggle PID preservation, child disposal and daemon shutdown. It additionally tests ordinary `task new` self-bootstrap and task-worktree cwd using a stub agent. Native ELF/Mach-O executables are relocated before execution; that path awaits an actual binary artifact.
- The macOS ARM64 / Node 24 soak passed **40 bursts and 1,310,720 output lines per backend** (2,621,440 total), with daemon ping and output-to-styled-snapshot timings recorded in [the soak report](evidence/2026-11-22-terminal-artifact-soak-node24.json). Aggregate ping p95 was 0.080 ms and max 0.264 ms on this run; Ghostty burst-to-styled-snapshot p95 was 22.27 ms for this fixture. Polling/scheduling and fixture differences prevent interpreting these as outer-terminal latency or a universal speedup. The fixture uses host Node, so this does not prove Node-free binary operation. Node fetch is blocked; native offline proof requires external network isolation.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, `pnpm package:smoke` and `git diff --check` passed. Full `pnpm test` without concurrent stress: **860 passed, three failed**, plus event-watch cleanup rejection. The semantic PR sync, external-task notification and reconnect tests all fail again at unchanged `3028120` in a temporary worktree (removed afterward); the reconnect failure can surface as a cleanup race. An additional PR monitor timeout during concurrent stress passed on isolated rerun. These are not successful full release gates.
- Added `.github/workflows/terminal-compatibility.yml`: Node 22/24 × Linux/macOS, installed-package PTY checks and a separate Linux Docker run with `--network=none`; manual dispatch supports extended soak. Actionlint validates the workflow. Docker and Linux are unavailable locally, so the workflow has **not** executed and Linux/offline evidence remains pending. No publication or change to the default backend.

Draft preparation against current `main` (`83f0f67`): resolved preview-menu conflicts while preserving panel polish's graduation. All **166 tests across six terminal/app files**, typecheck, lint, build, build:npm and package audit passed. Package smoke timed out once waiting five seconds for daemon shutdown while the terminal/app suite was running concurrently; its isolated rerun passed. Preserve this transient failure as an item to investigate in CI rather than treating the retry as proof of deterministic shutdown. The full-suite results above predate this merge; the full suite was not rerun after it.

### Next resume point

Resume at **Phase 1 verification**, the first incomplete phase. The preview and aggressive automatic checks are implemented; do not repeat them. Review the draft and CI results, investigate the transient artifact-daemon shutdown timeout, and run the new Linux/offline matrix and the actual standalone binary through `verify:artifact --profile soak`. Resolve the three baseline daemon failures before claiming green release gates. Continue longer real agent/tool traces and process-RSS measurement, and resolve or explicitly accept the dense-link tail and native width/long-link/input limits before shipping. The new timings measure daemon/snapshot behavior, not outer-terminal rendering. Phase 2 remains deferred; no phase is skipped. Update status summary, verification summary and next resume point together whenever a phase is implemented or verified.

## Edge cases and failure modes

- Failed Wasm initialization: preview session fails with an actionable message before spawning a child. Turning preview off restores xterm for new sessions; do not swap emulators underneath a running PTY or silently discard its state.
- Preview changes: backend selection is fixed per session. Define configuration reload behavior so toggling never kills running agents. Existing daemon/client compatibility must remain safe; document restart requirements explicitly if necessary.
- Partial UTF-8/OSC/CSI, long URIs/graphemes, empty writes, resizing with pending output, reset, origin mode, protected composer, scrollback bounds, alternate screens and disposal races require fixtures.
- Large output: synchronous parsing must have a bounded work budget/yield strategy so faster parsing does not starve daemon requests; preserve output ordering through resize and dispose.
- Multi-session memory: shared Wasm memory can retain its high-water mark. Measure resident memory, create/dispose loops and large scrollback; specify caps and avoid claiming free() shrinks linear memory.

## Security and privacy

PTY output is untrusted. Retain Craig's URL scheme/control-character filter. Clipboard, notifications, file-backed images and other host effects stay disabled unless independently supported. No remote service or telemetry is introduced. Build artifact checks must fail closed; release builds must not download mutable nightly binaries. Review all license notices before bundling.

## Observability

Measure Wasm initialization, parse duration per byte/chunk, equivalent styled snapshot time, daemon publication lag, event-loop delay, and memory during local trace replay. Record backend/version in diagnostics without recording transcript contents. Do not add production telemetry for this rollout.

## Rollout plan

**Phase 0: investigation.** This change provides the executable proof and evidence-backed decision.

**Phase 1: complete opt-in agent terminal.** Add `ghosttyTerminal` to the existing preview registry/configuration and discovery UI, disabled by default. A user can create or attach agent/shell sessions using Ghostty, type, paste, resize, scroll and follow links through the existing daemon and shell. Include the neutral interface, artifact bundling and compatibility work in this vertical slice. Ship only after equivalent full styled-frame extraction stays within a 16 ms frame budget at 120×40 and combined parse/render/daemon measurements show no regression against Craig's current backend on representative traces. Add a `patch` Changeset for `craig-cli`.

**Phase 2: stable adoption.** After preview replay/soak and platform gates pass, make Ghostty the default, retire the preview using established conventions, and remove xterm/private-link/CSI S compatibility code if rollback no longer needs it. Add a `minor` Changeset for `craig-cli`; report the observed benefits with measured limits.

### Phase execution and verification policy

In-scope checks must pass before a phase is complete. Run covered terminal end-to-end flows during tuning where applicable. Record out-of-scope failures explicitly with commands and reasons; do not mark them passed. Release gates are `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.

## Plan Mode handoff checklist and acceptance criteria

### Phase 1 — opt-in agent terminal

**Implementation**

- [x] Optimize and benchmark full styled rows, links and cursor against current Craig before selecting the production bridge implementation. Wasm selected; dense-link tail follow-up remains a shipping gate.
- [x] Introduce the emulator interface and port xterm behind it without direct xterm access in the runtime.
- [x] Integrate pinned Ghostty Wasm through the interface with resource/callback handling.
- [x] Implement preview discovery/configuration and per-session selection with safe daemon initialization, failure and toggle behavior.
- [ ] Complete the full scrollback/color/link/Unicode/input compatibility acceptance audit. Targeted tests pass; long-workload, width/long-link and mouse/paste coverage remain.
- [x] Embed Wasm/license notices in the allowed npm bundle, fail closed on checksum mismatch, and add the patch Changeset.

**Verification**

- [ ] Replay real Codex output and compare styled frames, cursor, history and replies, including fragmented input and resize.
- [x] Add real-terminal coverage proving selected-task agent attach starts the Codex stub in the task worktree; prove new-task creation enters the new agent session directly.
- [x] Pass local PTY runtime/daemon, app-shell, terminal E2E, targeted backend parity, resource/disposal and preview-toggle checks.
- [ ] Measure equivalent styled-frame/combined performance, startup, memory and event-loop delay on Node 22 and current supported Node, macOS ARM64 and Linux x64.
- [x] Pass all local release gates, including packed CLI operation without artifact downloads; preserve the strict package allowlist. Linux CI remains required before shipping.

**Tracking update**

- [ ] Update all three tracker sections with measured outcomes and remaining limitations; resume at Phase 2 only after Phase 1 passes.

### Phase 2 — stable adoption

**Implementation**

- [ ] Graduate the backend and preview configuration safely, remove superseded compatibility code when justified, and add the minor Changeset.

**Verification**

- [ ] Pass preview soak, multi-session memory and platform matrix; rerun release gates and both launcher contracts after removing xterm.

**Tracking update**

- [ ] Update all three tracker sections and archive this RFC as Completed only when stable adoption is delivered.

### Final acceptance criteria

- [1] Users can opt into a complete Ghostty-backed terminal without changing task/worktree/PTY behavior or the published package shape.
- [1] Full styled-frame and daemon performance meet the stated gates; public hyperlinks, native Codex scrollback and actual query replies work in real sessions.
- [1] Existing selected-task attach and new-task direct-entry contracts pass; rollback/toggle behavior preserves running sessions.
- [2] Stable adoption is backed by real-trace and platform evidence, documented release notes and the required release gates.
