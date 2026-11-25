# macOS delivery implementation report — 2026-11-23

> November 25 update: [policy-gated binary CD](binary-cd-integration.md)
> supersedes the earlier manual-only publication boundary. Future exact-source
> main-push releases attach automatically after one explicit repository policy
> activation. This implementation does not activate that policy or publish assets.

## Review scope and dependencies

- [#319 qualification record](https://github.com/hallsamuel90/craig/pull/319): open,
  documentation evidence only, not a runtime prerequisite. Its older clean-Mac/
  signing next steps are superseded for the preview by the user's explicit
  deferred-signing/no-second-Mac decisions.
- [#321 GitHub release notifications](https://github.com/hallsamuel90/craig/pull/321):
  open, reused unchanged at `03729a3e7024b363b1b770f9c4f8c9db05b73d9b`.
  All listed hosted checks passed, including the binary rerun and five terminal
  jobs. Original failed runs remain historical evidence, not erased passes.
- [#323 delivery implementation](https://github.com/hallsamuel90/craig/pull/323):
  stacked on #321; both implementation branches are pushed for review.

The [bounded plan](macos-preview-plan.md) and [operator guide](macos-preview-install.md)
define the review/publication boundary. No release uploads, tap writes, merges,
local npm publishing, signing purchases or user-daemon interventions were made.

## Delivered behavior

Explicit `unnotarized-preview` preserves ad-hoc/non-notarized metadata. Unknown
policies fail closed; the default notarized policy retains its old requirement.
Manual attachment binds approval to tag/commit/archive hash, requires exact clean
source, stages checksummed bytes, invokes the full existing audit, resolves the
remote tag (including annotated tags), rejects draft/prerelease targets and all
matching immutable asset names across pagination, and uploads without clobber.
Downloaded remote assets must hash-match after upload. Interrupted/partial writes
stop for investigation with no repair deletion or retry. No automatic downloader
or tap writer exists.

Read-only candidate CI adds explicit tag/policy inputs. Standard CI runs the
portable policy/uploader tests. Existing npm release workflow, version numbers,
three-file package allowlist, terminal stack, native ABI/linkage audits, license
inventories and runtime cache implementation are unchanged. A patch `craig-cli`
Changeset covers this preview behavior. The generated formula targets the proposed
`hallsamuel90/homebrew-tap/Formula/craig.rb` and immutable versioned assets.

## Validation evidence

- 20 binary tests passed, including policy, uploader and formula fixtures plus
  resource identity/cache/lease tests. Uploader tests cover authorization, dirty/
  wrong source, audit failure, annotated tags, pagination, existing checksum asset,
  wrong remote commit, prerelease, checksum tampering, post-upload remote mismatch
  partial upload without retries, and a tag moved after upload. They make no network writes.
- 35 focused version/channel/update tests passed on the reused #321 code.
- Typecheck, lint, source build, npm minified build and package audit passed.
  Initial npm build failed because this new worktree lacked local dependencies;
  frozen-lockfile installation resolved it without changing the lockfile.
- Pinned local macOS ARM64 standalone build and full archive audit passed, including
  embedded resources, licenses, Ghostty module, runtime ABI and native linkage.
- Offline preview preparation and generated Ruby syntax check passed. This is
  local recipe evidence only; no `brew install` from public assets was performed.
- npm package smoke failed at `Timed out: daemon shutdown`.
- Standalone fixture smoke failed at `Old daemon did not exit after upgrade test`.
  Neither smoke failure is waived; no production lifecycle logic or deadline was
  modified. Historical #321 smoke success does not establish a pass for this build.
- Full local source suite completed in 293 seconds: **879 passed, 12 failed**,
  across 74 files (71 passed, three failed), plus one unhandled event-watch cleanup
  ENOENT rejection. Ten failures were in `tests/pty-daemon.test.ts`: PR sync,
  event-accelerated sync, cross-process notification, four durable prompts,
  restart sync, reconnect, tab disposal, background activity, event watching and
  stale endpoints. The other failures were the delegated Cursor terminal E2E and
  PR event-monitor readiness deadline. No new baseline comparison was performed
  in this session; historical reproduction on main cannot explain every current
  failure. This source gate is failed, not waived.
- Both changed workflow YAML files parsed successfully. New PR hosted checks were
  pending at report finalization; some terminal jobs already passed on the initial
  push, but those are not a final all-gates result for the final pushed commit.
  [Standard CI](https://github.com/hallsamuel90/craig/actions/runs/45320231510)
  and [binary CI](https://github.com/hallsamuel90/craig/actions/runs/45320231512)
  refer to the initial implementation push; follow #323 for the latest runs.

The local development archive was built with `dirty: true` on #321's commit and
package version 0.22.1. It is **ineligible for attachment**: that version's remote
tag names earlier source, and this archive includes uncommitted implementation.
Its archive SHA-256 was
`3cee370ef7b98e056241086175df99f01f53e9110bcbe5c66187bd1347a35b4a`.
It is a development audit/recipe fixture, not an exact-tag publication candidate.
Rebuild from a future released exact clean tag after review; never relabel it.

## Remaining checks and limits

Hosted CI for the new PR and resolution of failed local source/smoke gates remain
required before publication. Review #321 and the delivery PR together; #319 supplies
historical evidence. No agent approves a Fury/human checkpoint.

Read-only inspection found no assets on `craig-cli@0.22.1`. Proposed tap lookup
failed to resolve, which does not prove absence and does not authorize creation.
Remote attachment, downloaded hash verification and actual remote Homebrew install,
upgrade and rollback await public assets and separate human publication review.
An authenticated local upload also depends on existing `gh` release-write access;
this step does not configure credentials.

The user's actual downloaded 0.22.0 Codex cwd/input/resize evidence on this Mac is
historical and distinct from current fixture smoke. No new authenticated Codex
qualification, clean-Mac, other-Mac, notarization, offline Gatekeeper or all-macOS
qualification is claimed. These are explicit preview limitations; no second Mac
or paid Apple enrollment is requested. Linux x64 is the next separate delivery
phase; Windows, Intel Mac, Linux ARM64, Bun and VFS remain out of scope.
