# Standalone binary validation and Fury audit

2026-11-13, macOS 26.2 ARM64. This is local implementation evidence, not release
authorization. See the [build guide](standalone-binary-build.md) and
[acceptance checklist](standalone-binary-checklist.md).

November 22 follow-up: the branch has been merged with current `main` and pushed
as draft PR #316. The new local full-suite rerun has three failing daemon tests
and an unhandled rejection, despite passing binary smoke and other release gates.
The green results below are dated November 13 evidence, not the current release
gate status. See the [rollout record](standalone-binary-rollout.md) for current
failures and hosted qualification.

## Delivered

- Pinned, checksummed official Node distribution and isolated native rebuild;
  direct SEA generation without spike staging or source-text patches.
- Explicit versioned payload file inventory, normalized archives, licence notices,
  native ABI/linkage checks and outer/embedded artifact audits.
- Verified immutable cache generations, process leases, serialized selection/prune,
  corruption repair, conservative cleanup and direct daemon reexecution.
- SEA-owned installation detection, manual binary update guidance and guards against
  npm update/restart; the npm UI and launch behavior remain tested.
- A read-only macOS ARM64 CI definition for development Actions artifacts, offline
  GitHub release intent/preflight and a rendered Homebrew tap recipe. Publishing is
  disabled. The existing npm release workflow and versions have not been changed.

## Checks run

| Check | Result |
| --- | --- |
| `pnpm test` | Fresh verify-step run: **840 passed**, 71 files |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |
| `pnpm build:npm` | Pass |
| `pnpm package:audit` | Pass; original three-file npm inventory |
| `pnpm package:smoke` | Pass |
| `pnpm binary:test` | **16 passed** after audit corrections |
| `pnpm build:binary` | Pass; official Node 26.13.0 / ABI 147; isolated node-pty rebuild |
| Repeated native/payload builds | Equal canonical payload identity (below) |
| `pnpm binary:audit` | Pass; checksummed archive, exact inventory, actual decoded resources, signatures, runtime ABI, licence attribution and addon linkage |
| `pnpm binary:smoke` | Pass; relocated executable, fresh HOME, Node/npm/Bun blocked |
| `pnpm binary:release:prepare` | Pass; emits only disabled offline drafts |
| `ruby -c dist/binary/draft/craig.rb` | Pass |
| Homebrew formula parser | Draft loads through local `Formulary.from_contents`; correct version/URL, ARM64 and macOS 14 minimum |

The binary smoke covers three concurrent cold starts, embedded metadata, actual
cache corruption and repair/pruning, repo/worktree creation, selected-agent attach
and direct TUI-create-to-agent startup with exact cwd markers, input and increased
PTY dimensions, detach/reattach, daemon recovery/shutdown, diff/checks and fixture
PR discovery/refresh/show. Codex and gh are shell fixtures; the harness itself uses
developer Node and node-pty. This is not a clean host with Node physically absent.

The verify-step harness additionally constructs a test-only second executable with
different benign CLI payload bytes and the same package version. It atomically
replaces the relocated executable while the original daemon is alive, confirms
the daemon PID and existing agent input survive reattachment, proves pruning retains
the old resources, then proves they are removed only after the old daemon exits.
These are two fixture builds, not a public version bump or a real-account upgrade.
Child PATH contains poison runtime commands and command-path fallbacks are disabled.

Focused tests additionally cover payload tampering/traversal, duplicate entries,
cache symlinks, interrupted/dead lock recovery, full-disk rollback, inaccessible
caches, three rounds of eight concurrent processes, active/unknown/inactive leases,
older-payload retention across an upgrade, archive trailing data, channel guards,
and release tag/commit/asset/qualification rejection. Existing npm update/restart
tests and both terminal launcher contracts remain covered. The standalone UI test
proves an available version does not replace the launcher with an npm update action.

The first full-suite attempt had **839 passed, one failed**: the detached-agent
token-refresh test in `tests/pty-daemon.test.ts` did not observe renewal in its
timing window. It passed in isolation and the subsequent full run passed all 840.
No capability-refresh behavior or test deadline was changed. The two watcher tests
that failed during the earlier spike passed in these full runs. Keep this timing
history visible; do not interpret one green run as proof the suite cannot flake.
A cache stress rerun also caught a real lock-disappearance race during development;
the retry fix is covered by the expanded multi-process test.

## Verify-step findings and corrections

The verify step reread the implementation/checklist and reran all seven standard
release gates; its fresh full-suite run passed 840 tests without the earlier timing
failure. There are **no currently failing local gates**. The pre-fix regression
failures below were corrected and their affected tests rerun:

1. **Formula URL interpolation:** the renderer's URL regex permitted Ruby `#{...}`
   interpolation and URLs for a different version. It now accepts only the exact
   immutable versioned download URL. Regression tests reject both cases.
2. **Incomplete release preflight:** missing clean-source status or missing asset
   hashes could pass. Preflight now requires explicit clean status and exactly the
   expected versioned archive/checksum assets with valid SHA-256 values.
3. **Manifest-only audit coverage:** the old audit compared metadata/manifests but
   did not inspect decoded resource content. It now audits actual embedded bytes,
   verifies actual runtime version/ABI/platform, licence attribution and the addon's
   signature/system-library linkage. A forged but self-consistent manifest containing
   forbidden content is rejected by the new regression test.
4. **OS deployment bound:** the draft recipe lacked an OS minimum despite the
   embedded Node's 13.5 deployment floor. It now conservatively requires Sonoma 14
   through an `on_macos` block, accepted by the actual local Homebrew parser.

The new separate-process and two-executable upgrade fixtures strengthen cache
lifetime evidence. Git diff checks confirm the existing npm publisher, npm package
manifest/version, lockfile and npm build script are unchanged. Signing credentials,
live release lookup/upload and tap publication were not exercised or enabled.

## Development artifact

Version remains `0.20.1` (no manual bump). Build metadata records dirty source,
ad-hoc development signing and `notarized: false`; release preflight rejects it.

```text
payload identity:
fd8abaf1948f58bdb8dd07aa70a086ac8c2607c61b2dda2ea272a5ebe6a619cc

archive SHA-256 (this local build):
2ff59d1a5ffb7ea68dac00438db8c3dfe6b7628a21f36d019f86e54ae56633f7
```

Executable: 147,077,344 bytes. Archive: 46,469,349 bytes. These are development
measurements, not promised signed-release sizes or new performance benchmarks.
The verified stock Node runtime's public release-builder diagnostic paths are
allowed only as an exact pinned inventory; Craig payload/native build paths are
not exempt. See the build guide for the audit boundary and why signing timestamps
are not part of canonical resource identity.
Human review must retain visibility of that upstream exception. This result means
no additional private Craig/build paths were found; it is not a claim that every
upstream absolute diagnostic path was removed from the stock Node executable.

## Unverified external release qualification

- Hosted `macos-26` CI execution and availability of the pinned Xcode/SDK image.
- Clean Mac without an installed Node runtime, using real authenticated Codex
  sessions and live GitHub PR/check workflows, including real upgrade/old-daemon
  coexistence between real released versions and supported macOS deployment versions.
  Local fixture-build replacement and old-daemon retention/cleanup passed as above.
- Developer ID signing branch with actual certificates, notary submission/receipts,
  downloaded/quarantined execution and native loading, and offline ticket behavior.
  No credentials or secrets were configured and no notary request was submitted.
- Live Homebrew installation/upgrades from a published immutable artifact. Current
  Homebrew rejects installing arbitrary untapped formula paths; no tap was created
  and no current Craig installation was replaced to force this test.
- The future authorized publisher must fetch and verify real remote tag/commit and
  asset inventory, then use signing/notarization qualification receipts. Current
  work provides offline intent/preflight only, with no enabled uploader or tap writer.

These remain release blockers. There were no pushes, merges, remote tap creations,
release uploads, npm publishes or Fury review approvals in this implementation.
