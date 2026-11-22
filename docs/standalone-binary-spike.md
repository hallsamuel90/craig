# Standalone Craig executable feasibility (#309)

Date: 2026-11-09. Scope: local macOS ARM64 feasibility experiment for
[#309](https://github.com/hallsamuel90/craig/issues/309), not a release implementation.

## Recommendation

**A: continue with Node SEA for a standalone executable.** A relocated, ad-hoc signed
prototype runs the current CLI and its native PTY without a separately invoked Node
runtime. No terminal engine replacement is necessary. This is a go for implementation,
not a go for distribution: signing/notarization, binary updates, cache maintenance,
release reproducibility and additional platforms remain unfinished.

The follow-up below tests Node 26's direct builder/VFS and Bun with a newer PTY
addon. **Prefer Node 26's direct builder with extracted resources for the next
implementation step.** Its terminal smoke passes and it removes `postject` without
depending on the early-development VFS. The VFS variants also work, but are slower
in this test. Bun's package-loading obstacle is resolved; its PTY output is still
blocked, independently reproduced outside the compiled application.

The Bun baseline compiles but fails at startup; retain it as an alternative requiring
more native-addon and module-loading work. A Homebrew formula with a Node dependency
(option B) remains a simpler separate distribution choice, but does not meet the
standalone objective. No Homebrew formula, publisher changes, platform npm packages,
release uploads, or version changes are included here.

## Reproduce

Tested on macOS 26.2 ARM64. Use **Node v24.12.0**, pnpm 10.7.1 and the installed native addon built
for that Node version. The script checks the platform/version and loads `node-pty`
before building. Xcode command-line tools provide `codesign` and the native build
toolchain; `/usr/bin/tar` is also required. From the repo root:

```sh
pnpm install --frozen-lockfile
mkdir -p .craig/binary-spike/toolchain
npm install --prefix .craig/binary-spike/toolchain --no-audit --no-fund postject@1.0.0-alpha.6 bun@1.4.4
node scripts/binary-spike/build.mjs
node scripts/binary-spike/smoke.mjs
```

If the addon came from another Node ABI, rebuild it for Node v24.12.0 before running
the build (do not copy a different runtime's addon into the artifact).

Output: `.craig/binary-spike/craig`. All build products and the experimental toolchain
stay under ignored `.craig/`; nothing is added to npm's publication allowlist. The
normal `pnpm build:npm` output and CI release workflow are unchanged.

Measured prototype: **118,600,032 bytes** (113.1 MiB), including the Node executable;
embedded compressed application/dependency payload: **1,848,565 bytes** (1.76 MiB),
8.2 MiB extracted. Sizes can change with signatures, tar metadata and dependency
builds; this is not a byte-reproducible release build.

### Bun baseline

```sh
.craig/binary-spike/toolchain/node_modules/.bin/bun --version
.craig/binary-spike/toolchain/node_modules/.bin/bun build --compile src/cli.ts --define '__CRAIG_VERSION__="0.20.1"' --outfile .craig/binary-spike/craig-bun
.craig/binary-spike/craig-bun --help
.craig/binary-spike/toolchain/node_modules/.bin/bun -e 'require("node-pty")'
```

Bun 1.4.4 compiled 254 modules successfully into a 90,480,866-byte executable.
Running it failed with:

```text
error: Cannot find package 'terminal-kit' from '/$bunfs/root/craig-bun'
```

The direct addon-load probe independently failed with:

```text
The module 'pty' was compiled against a different Node.js ABI version using NODE_MODULE_VERSION 137.
This version of Bun requires NODE_MODULE_VERSION 147.
```

The same addon loads successfully under Node v24.12.0. These observations establish
that the unmodified Bun build is insufficient, not that all dynamic imports or all
native addons are unsupported. No Bun-targeted rebuild or `node-pty` upgrade was
attempted. The current `node-pty` 0.10.1 uses NAN; any alternative needs an actual PTY
test, not just a successful compile. See Bun's [native addon documentation](https://bun.sh/docs/runtime/node-api)
and [executable documentation](https://bun.sh/docs/compiler/executables).

## Runtime inventory and approach

| Area | Existing behavior | Spike treatment |
| --- | --- | --- |
| CLI | TypeScript/ESM, top-level await in `src/cli.ts` | esbuild produces ESM targeting Node 24; version comes from `craig-cli` manifest |
| npm externals | `terminal-kit`, `node-pty`, `@xterm/headless`, `picocolors` | Embed installed runtime packages with their dependency graph; keep package-relative file layout |
| UI loader | `createRequire(import.meta.url)` loads `terminal-kit` | Runs from extracted ESM entrypoint with a normal file URL |
| terminal-kit | Lazy modules; runtime-selected `lib/termconfig/*.js` and color schemes | Preserve runtime files instead of assuming static bundler discovery |
| PTY loader | `createRequire(import.meta.url)` loads `node-pty` on demand | Preserve `lib` JavaScript and `build/Release/pty.node`; omit build-only NAN |
| Native linkage | macOS ARM64 addon compiled for Node ABI 137 | Use the same Node executable that can already load it; `otool -L` shows only system libc++/libSystem dependencies |
| Dynamic import | `src/ui/workspace/browser.ts` imports `node:child_process` | Keep Node's ordinary module loader; no blanket rewrite of dynamic imports |
| Daemon | `process.execPath`, `process.execArgv`, script entrypoint in `process.argv[1]` | Bootstrap normalizes SEA arguments and recognizes reexecution with the extracted entrypoint |
| Update/restart | Runs global npm installation, resolves npm global bundle, restarts with Node | Build-only plugin replaces these functions with explicit unsupported errors |
| External tools | git, gh, agent runners, shell, tail, OS URL opener | Remain external prerequisites; packaging Craig does not bundle those tools |
| User files | Workspace config, state, worktrees, logs, prompts and inspection files | Continue resolving from workspace/task paths rather than the embedded executable |

Node v24 SEA executes an embedded CommonJS bootstrap. It cannot simply resolve npm
dependencies using its embedded `require`, and native addons need disk files. The
bootstrap reads an embedded archive using `node:sea`, extracts it atomically, then
uses `createRequire` to load a disk launcher which imports Craig's ESM entrypoint.
This preserves top-level await, `import.meta.url`, CJS lazy loading and the existing
daemon code. See the [Node v24.12 SEA documentation](https://nodejs.org/download/release/v24.12.0/docs/api/single-executable-applications.html).

Cache location: `~/Library/Caches/craig-binary-spike/<payload-sha256>/`. The private
parent is checked for ownership and permissions. Concurrent cold starts extract into
separate temporary directories and rename into place. Cached resources persist so
detached daemons can continue using them after the UI exits. Production needs an
explicit integrity/repair strategy and garbage collection that respects running
daemons; the prototype does not implement these policies.

## Executable verification

The smoke harness copies only the executable to a temporary directory outside the
checkout and uses a fresh HOME/cache. Child PATH contains only system directories
and test stubs; poison `node`, `npm` and `bun` commands fail and record any invocation.
The harness itself runs under developer Node and uses `node-pty` to drive a real
terminal; the tested application and its daemon use the relocated executable.
Codex and gh are shell fixtures, so no real agents or GitHub writes are involved.

| Check | Result |
| --- | --- |
| Three concurrent cold `--help` invocations | Pass; extraction and CLI startup |
| Version | Welcome screen shows v0.20.1; `--version` is unsupported by the existing CLI and remains unsupported |
| Repo registration, CLI task/worktree creation, JSON output | Pass with a real temporary Git repo |
| Interactive terminal-kit UI | Pass in xterm-256color |
| Open/attach selected task's agent | Pass; shell fixture records exact task worktree cwd |
| Agent input and resize | Pass; round-trip input and `stty size` prove rows/columns increase |
| Detach and reattach | Pass; agent receives another input probe through the surviving daemon |
| Daemon stop and recovery | Pass; shutdown removes PID file; subsequent UI launch starts a new daemon and agent |
| TUI task creation | Pass; creates a second task and enters its agent directly, with exact worktree cwd recorded |
| Diff and configured checks | Pass with a real modified tracked file and shell check command |
| PR discovery/refresh/show | Shell gh fixture; no live GitHub authentication or network validation |
| Update/restart | Intentionally disabled by spike build; no binary updater implemented |
| Shutdown | UI and daemon cleanup; temporary workspace/home removed |
| External runtime usage | No poison Node/npm/Bun command invoked |

This is PATH isolation on a developer Mac, not a clean VM with Node physically
absent. Real Codex authentication, live PR/check polling, terminal emulators beyond
xterm-256color, crash recovery, URL opening and installation into a quarantined app
environment still require release qualification.

Repository checks: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm build:npm`,
`pnpm package:audit` and `pnpm package:smoke` pass. The full `pnpm test` run had
831 passing tests and three failures in the unchanged source suite: the
`PullRequestEventMonitor` test timed out; two `tests/pty-daemon.test.ts` tests failed
to observe PR synchronization/task notifications. An isolated serial rerun of
those two files passed the monitor test and reproduced the two daemon failures
(30 passing, two failing). Application source, existing tests and test configuration
are unchanged by this spike; the suite is not fully green. Its terminal launcher
coverage passed, alongside the dedicated executable smoke above.

## Modern toolchain follow-up (2026-11-09)

This follow-up leaves application source, dependency manifests/lockfile and npm
release packaging unchanged. Alternate runtimes/addons and all executables remain
under `.craig/binary-spike/`.

### Candidates and results

- **Node 26.13.0, direct builder, extracted resources:** passes the entire relocated
  terminal smoke. Uses `node --build-sea` and ad-hoc signing, without `postject`.
  Keeps the existing `node-pty` 0.10.1 contract, with its addon rebuilt for Node 26.
- **Node 26 VFS, ESM entrypoint:** passes the same smoke. JS, package manifests,
  lazy terminal configs and other resources load from the embedded filesystem.
  Only the native addon needs a disk path; the spike rewrites two references in
  the staged PTY package to the already-loaded addon. No installed package or
  application source is patched. The temporary-addon variant removes the file
  after loading; the cache variant keeps a content-addressed native file.
- **Node 26 VFS with a compressed ZIP:** also passes, both with a temporary addon
  and with a cached addon. Compression reduces artifact size, but does not make
  this variant faster than extracted resources in these measurements.
- **Bun 1.4.4 with node-pty 1.1.0:** reaches `--help`, creates a CLI task and opens
  the TUI after packaging fixes, but fails to display any agent output. It times
  out waiting for `binary_agent_ready`; the UI reports `ioctl(2) failed, EBADF`, and
  no agent fixture cwd marker is written. A separate uncompiled addon probe loads
  the addon and returns from `spawn`, yet gets no output and exits with timeout
  status 2. The exact same addon/input probe passes under Node 24.12.0. This is a
  runtime compatibility blocker for this candidate, not a dynamic-import syntax
  failure. No Bun.Terminal adapter or terminal-stack replacement was attempted.

The Bun adjustments are: bundle the static JS dependencies with esbuild, preserve
the lazy-loaded packages on disk, enable `--compile-autoload-package-json` so the
compiled loader can resolve them, and replace old NAN-based node-pty with the
Node-API-based 1.1.0 **only inside this candidate**. Its macOS `spawn-helper` arrived
without execute permission; the build fixes that mode. Fixing the mode was necessary
under Node as well and did not resolve Bun's output failure.

Every new candidate uses a build-only daemon adapter that invokes its own executable
with `__craig-daemon <workspace>`, avoiding `.ts`/tsx detection and unstable VFS script
paths. The normal npm daemon path is unchanged. All candidates disable npm updates.

Current [Node SEA documentation](https://nodejs.org/api/single-executable-applications.html)
documents direct executable generation and ESM/VFS loading. SEA is still classified
as active development, and the VFS is explicitly early development. The direct
builder removes a build dependency; it does not make the VFS a stable API.

### Reproduce the follow-up

Run the preparation with developer Node 24.12.0. The Node 26 binary is isolated to
the experiment; do not rebuild the repo's installed native addon with Node 26.

```sh
pnpm install --frozen-lockfile
mkdir -p .craig/binary-spike/toolchain
npm install --prefix .craig/binary-spike/toolchain --no-audit --no-fund node@26.13.0 bun@1.4.4
node scripts/binary-spike/build.mjs --payload-only
PATH="$PWD/.craig/binary-spike/toolchain/node_modules/node/bin:$PATH" npm install --prefix .craig/binary-spike/pty-node26 --no-audit --no-fund node-pty@0.10.1
npm install --prefix .craig/binary-spike/pty-napi --no-audit --no-fund node-pty@1.1.0
node scripts/binary-spike/build-modern.mjs node26-disk
node scripts/binary-spike/build-modern.mjs node26-vfs
node scripts/binary-spike/build-modern.mjs node26-vfs-zip
node scripts/binary-spike/build-modern.mjs node26-vfs-zip-cache
node scripts/binary-spike/build-modern.mjs bun-napi
node scripts/binary-spike/smoke.mjs .craig/binary-spike/node26-disk/craig
node scripts/binary-spike/smoke.mjs .craig/binary-spike/node26-vfs/craig
node scripts/binary-spike/smoke.mjs .craig/binary-spike/node26-vfs-zip/craig
node scripts/binary-spike/smoke.mjs .craig/binary-spike/node26-vfs-zip-cache/craig
node scripts/binary-spike/smoke.mjs .craig/binary-spike/bun-napi/craig
```

The last smoke command is expected to fail at agent output with the tested Bun
candidate. It still shuts down its daemon and removes its temporary home/workspace.
`--payload-only` prepares the shared staged package graph and needs no `postject`;
the original Node 24 executable can be built separately using the earlier steps.

To isolate the PTY behavior from bundling (the Bun probe should exit 2):

```sh
chmod +x .craig/binary-spike/pty-napi/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
node scripts/binary-spike/pty-probe.mjs "$PWD/.craig/binary-spike/pty-napi/node_modules/node-pty"
.craig/binary-spike/toolchain/node_modules/.bin/bun scripts/binary-spike/pty-probe.mjs "$PWD/.craig/binary-spike/pty-napi/node_modules/node-pty"
```

### Measured CLI startup and memory

`node scripts/binary-spike/benchmark.mjs` benchmarks `--help` and writes raw results
to `.craig/binary-spike/benchmark.json`. It expects the old Node 24 executable and
the npm esbuild bundle to exist as well (`pnpm build:npm` for that bundle).
Fresh-home time is the median of five independent HOME/cache directories; warm
time is the median of 15 launches; peak RSS is the median of five `/usr/bin/time -l`
measurements. All are on this macOS ARM64 developer machine, with warm OS caches.
They are not benchmarks of sustained agent/TUI operation or a downloaded binary's
Gatekeeper/signature verification. Earlier single first-launch samples were noisy;
these repeated measurements are a better comparison of application startup.

| Candidate | Artifact MiB | Fresh HOME ms | Warm ms | Peak RSS MiB | Terminal smoke |
| --- | ---: | ---: | ---: | ---: | --- |
| esbuild + installed Node 24 | 0.52* | 67.4 | 65.3 | 73.5 | Existing package smoke |
| esbuild + installed Node 26 | 0.52* | 58.0 | 58.9 | 77.9 | Help benchmark only |
| Node 24 SEA, extracted resources | 113.1 | 202.9 | 64.9 | 73.9 | Pass |
| Node 26 SEA, extracted resources | 140.7 | 195.6 | 58.5 | 77.9 | Pass |
| Node 26 VFS, temporary addon | 146.1 | 183.3 | 182.9 | 84.0 | Pass |
| Node 26 ZIP VFS, temporary addon | 140.9 | 195.3 | 193.9 | 87.5 | Pass |
| Node 26 ZIP VFS, cached addon | 140.9 | 206.1 | 72.1 | 87.5 | Pass |
| Bun + node-pty 1.1 candidate | 86.4 | 212.1 | 46.5 | 37.5 | **Fails agent output** |

\* JS bundle only; excludes installed Node and external npm dependencies.

The Node 26 baseline helps separate runtime-version effects from packaging: its
esbuild bundle and extracted SEA have essentially identical warm startup here.
Node 26's executable is larger than Node 24's. The VFS avoids extracting the full
resource tree, but caching just the addon is necessary to avoid the substantial
per-launch cost seen with a fresh temporary native library. These variants still
use different loaders and bundling configurations; do not generalize the results
to every Node/Bun application. Bun's promising help-only figures do not establish
viable terminal performance while its PTY output is broken.

Follow-up verification: every Node 26 variant passed task/worktree creation,
selected-agent attach with exact cwd, input/resize, detach/reattach, daemon recovery,
direct TUI-create-to-agent transition, diff/checks, and fixture PR commands with
Node/npm/Bun blocked on child PATH. Lint and typecheck pass. The unchanged source
suite failures described above remain recorded; no unrelated source fixes were
made in this experiment.

## Distribution follow-up

- Build in a clean, pinned macOS ARM64 environment; inventory payload contents,
  native debug strings/private paths, and licenses before distributing. The current
  package-copy filter is a spike convenience, not a release allowlist/audit.
- Sign the native addon and final executable with Developer ID, notarize/staple as
  appropriate, and test a downloaded/quarantined artifact. Ad-hoc signing proves
  local execution only.
- Define binary install/update ownership and restart behavior. Do not let a binary
  install invoke the npm updater or silently switch installation channels. Test
  replacement while an old daemon is still running.
- Design cache integrity, recovery, disk-space errors and safe cleanup. Do not remove
  files belonging to a live daemon, and preserve user workspace state.
- Test from a clean account/VM without Node, including real runner sessions, PR
  checks, multiple terminal types and graceful quit/crash recovery.
- macOS x64 and Linux need their own Node binary, matching native-addon build and
  smoke evidence. No cross-platform viability is claimed by this result. Windows
  additionally has native helpers/processes requiring a separate inventory.
- Keep any eventual GitHub Releases/Homebrew proposal separate from the existing
  CI-only npm publisher. No publishing or release workflow change is authorized by
  this spike.

`libghostty` remains separate (#310). Both the current terminal parser and PTY
manager work in the Node prototype; replacing either is unnecessary for this path.
