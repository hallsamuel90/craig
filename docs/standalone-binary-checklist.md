# Standalone binary implementation checklist

Scope agreed 2026-11-13 for Fury `fury_4635b3dd-a9e4-44f6-9afb-a03247c3030e`.
Evidence: [standalone-binary-spike.md](standalone-binary-spike.md), the untracked
`scripts/binary-spike/` experiments, `AGENTS.md`, and current package/release files.
This tracks implemented acceptance mechanisms, not public release qualification.

## Implementation status

Implementation and the Fury verify audit are complete for local review. Evidence,
audit corrections and the observed earlier test retry
are recorded in [standalone-binary-validation.md](standalone-binary-validation.md);
commands and operational policy are in [standalone-binary-build.md](standalone-binary-build.md).
The spike files remain intact, and publishing remains disabled.
November 22: PR #316 was merged on the user's instruction after hosted qualification.
The expired Fury review itself has not been approved by an agent. Changesets then
produced 0.22.0 through PR #317; npm publication failed and needs credential review.

## Verification summary

Fresh verify-step full suite: 840 tests passed; dedicated binary tests: 16 passed. Typecheck,
lint, both standard builds, npm audit/smoke, standalone build/audit/smoke and offline
release preparation passed. Repeated builds produced the same payload identity.
Ruby syntax and Homebrew's formula parser passed; no live tap install occurred.
The audit fixed formula URL interpolation, incomplete release-preflight validation,
decoded-resource audit coverage and the Homebrew OS floor. Atomic executable
replacement with a live old daemon passed using two fixture builds.
These counts describe the November 13 audit. The November 22 local rerun passed
842/845 source tests with three daemon failures and an unhandled rejection; current
release gates are not all green. Other local gates and updated binary smoke passed.
See the rollout record for investigation and hosted results.
The final PR and merged-main binary workflows subsequently passed, including 845
source tests and the stronger smoke. Downloaded CI resources matched local payload
identity. A read-only actual Codex probe passed cwd, follow-up input and resize on
this Mac; clean-machine and full real-account workflow qualification remain open.
The exact 0.22.0 main development artifact subsequently passed hosted binary CI,
downloaded-artifact audit and the same actual Codex probe. Its npm publish remains
failed; signing/notarization and clean-machine gates remain unverified.

## Next resume point

The November 13 Fury human-review checkpoint timed out without approval; the user
later authorized merging [PR #316](https://github.com/hallsamuel90/craig/pull/316).
Next: verify/renew npm publishing credentials, obtain Developer ID/notarization
inputs and a clean Mac test host, and qualify the exact 0.22.0 candidate. Current
evidence and failed release details are in the [rollout plan](standalone-binary-rollout.md).
Do not interpret checked implementation items below as completed external tests:

- [x] Run the new workflow on hosted macOS ARM64 CI with its pinned Apple tools.
- [ ] Qualify real Codex/gh, clean-machine use and actual executable upgrades.
- [ ] Qualify Developer ID, notarization, quarantine and offline ticket delivery.
- [ ] Validate a real Homebrew install/upgrade after a separately authorized release.
- [x] Obtain human implementation review before publication follow-up (user authorized PR #316 merge; expired Fury checkpoint unchanged).

Target **macOS ARM64, Node 26 direct SEA builder, extracted resources**. Keep
`node-pty` 0.10.1 and the current terminal stack; rebuild the addon for the embedded
Node ABI. Node 26.13.0 is the tested starting pin, not a promise of ongoing security
support. Bun, VFS, other platforms and a download/self-update service are excluded.

## Build and artifact

- [x] Provide a documented build command that starts from a clean checkout and
  frozen dependencies; it must not need old `.craig/binary-spike` payloads, the
  developer's installed Node binary, or `postject`. Pin Node, package-manager and
  native-build inputs; verify downloaded runtime/toolchain checksums and platform.
- [x] Embed the version from `packages/cli/package.json`. Record runtime version,
  target, native ABI and dependency versions in build metadata. Build and load-test
  the addon with that same Node runtime; reject unsupported host/target mismatches.
- [x] Replace broad recursive package copying with an explicit, checked runtime
  file manifest, preserving terminal-kit's lazy modules/configs and transitive
  runtime dependencies. Include Craig, Node and third-party license notices.
- [x] Audit both the outer distribution archive and embedded payload. Allow only
  the executable, required runtime JS/native assets, manifest/metadata and notices;
  exclude original Craig TS, tests, docs, guidance, development tools, lockfiles,
  logs, environment/local state, source maps and private build/workspace paths.
  Audit native strings/linkage too; unexpected files or content fail the build.
- [x] Derive payload identity from canonical sorted paths, file bytes and required
  modes, independent of checkout location, mtime, owner, tar ordering or gzip time.
  Two equivalent staging trees yield the same identity; a changed byte or mode
  changes it. Normalize archive metadata. Do not require signatures with timestamps
  to be byte-identical; record final signed-archive checksums separately.
- [x] Produce a versioned `darwin-arm64` archive and SHA-256 checksum using a
  documented layout. A negative audit fixture must prove exclusions are enforced.

## Cache and daemon

- [x] Use a documented per-user cache outside workspace state. Verify ownership,
  permissions, expected directory/file types and symlinks before trusting entries;
  reject traversal, absolute paths and escaping links from archives/manifests.
- [x] Check cached content against the embedded manifest before use. Missing,
  truncated or modified files cannot be accepted on directory existence alone;
  repair safely or fail with an actionable error. Treat read-only/full-disk caches
  and interrupted extraction as explicit failure cases, without damaging user data.
- [x] Concurrent cold launches atomically select a fully verified payload; no
  process can observe a partially populated directory. Test cold-start races,
  corrupted-cache recovery and interrupted/stale extraction cleanup.
- [x] Keep resources needed by a detached daemon available after the UI exits or
  the installed executable is upgraded. Cleanup must preserve live payloads and
  conservatively retain entries whose liveness cannot be established. Scope any
  pruning to verified Craig-owned cache entries; never delete workspace state.
  Define/document cleanup policy; test active, inactive and unknown-use entries.
- [x] Replace build-time source-text daemon rewrites with a tested standalone
  launch path. The executable starts its own daemon directly, without Node/tsx on
  PATH or a staging script. Preserve npm/source-development launch behavior.
- [x] Prove real-terminal contracts for selected-agent attach and direct TUI
  create-to-agent transition, including exact task worktree cwd. Also test input,
  resize, detach/reattach, shutdown/recovery and cache use across executable versions.

## Installation channel and updates

- [x] Introduce testable installation-channel behavior at the appropriate shell
  boundary, following `AGENTS.md` dependency direction. Replace spike update-module
  stubs; do not make the domain depend on UI code or environment-name guessing.
- [x] Keep existing npm install/update/restart behavior. Standalone binaries must
  never invoke global npm installation/root lookup or restart into an npm bundle.
  First-release binary upgrades are manual: replace the downloaded executable;
  Homebrew-managed installs use `brew upgrade` once that channel exists. If reliable
  Homebrew detection is unavailable, give conditional guidance rather than guess.
- [x] Binary update notices/actions explain the supported manual path and do not
  offer a nonfunctional npm update button. Test channel selection, update actions,
  restart argv/cwd/env and coexistence with a running older daemon.
- [x] Add appropriate `craig-cli` Changesets for user-visible shipped behavior,
  following `AGENTS.md`; do not edit versions manually or add platform npm packages.

## CI and reviewable distribution preparation

- [x] Add a pinned macOS ARM64 CI build/audit/smoke path that produces reviewable
  Actions artifacts without publishing releases. Keep existing npm package name,
  engines, strict three-file allowlist and `pnpm build:npm` contract intact.
- [x] Prepare disabled/opt-in release-attachment code for the existing
  `craig-cli@<version>` GitHub Release: verify version/tag/commit, archive and checksums,
  require qualified signing results, and reject conflicting existing assets rather
  than silently overwriting them. No upload is performed or enabled in this Fury.
- [x] Prepare a Homebrew tap recipe/template for the immutable versioned archive,
  checksum, ARM64 restriction and install/help smoke test. Validate rendering and
  local installation where possible. Do not create a remote tap, publish the recipe
  or pretend placeholder/unpublished URLs have passed live installation tests.
- [x] Document Developer ID signing of native contents and executable, notarization
  and downloaded/quarantined-artifact validation. Keep credentials external; an
  ad-hoc local signature is developer test evidence only. No secret configuration,
  push, merge, release upload, Homebrew publication or local npm publish is authorized.

## Verification and handoff

- [x] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`,
  `pnpm package:audit`, `pnpm package:smoke`, plus standalone cache/channel tests and
  relocated executable smoke with fresh HOME and Node/npm/Bun blocked on child PATH.
  Record commands, results and artifact provenance in a concise validation report.
- [x] Separate fixture Codex/gh results from real integrations. The recorded baseline
  includes two reproducible failures in `tests/pty-daemon.test.ts` (PR synchronization
  and task notifications) and a monitor timeout that passed on serial rerun. Rerun
  and diagnose; do not waive failures or call required release gates green.
- [x] Classify real authenticated Codex input/resize/reattach, live GitHub PR/checks,
  clean Mac without Node, Developer ID/notarization and quarantined download checks
  as passed only with actual evidence. Missing hosts/accounts/credentials remain
  explicit unverified release blockers; they need not block presenting the code diff.
- [x] Update this checklist with evidence and remaining gaps. Complete Fury's verify
  step with passed/failed/unverified checks and stop at its human-review checkpoint.
  Implementation review readiness is distinct from authorization/readiness to publish.

## Open questions and boundaries

1. Which clean macOS ARM64 host and authenticated runner/GitHub test accounts will
   supply external qualification evidence? None is provisioned by this checklist.
2. Which Developer ID identity, Apple team and notary credential mechanism will CI
   use? Document required inputs without inventing values or creating secrets.
3. Confirm the eventual tap repository/package name before publication. The working
   proposal is `hallsamuel90/homebrew-tap` with `craig`; prepare a configurable draft.
4. `AGENTS.md` describes same-run Changesets versioning with a `[skip ci]` main commit,
   while the checked-in `release.yml` currently publishes the manifest version and
   opens a version PR afterward. Preserve the current npm publisher in this Fury;
   release-policy reconciliation is separate. Do not turn binary work into that rewrite.

These questions do not block bounded implementation. Public distribution stays
disabled until required gates and external qualification have been reviewed.
