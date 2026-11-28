# Policy-gated macOS ARM64 binary CD

## Activation and boundaries

PR [#323](https://github.com/hallsamuel90/craig/pull/323), stacked on
[#321](https://github.com/hallsamuel90/craig/pull/321), now integrates binary
attachments into the existing merge-triggered release workflow. #319 remains the
historical qualification record. This supersedes the manual-only delivery design
from November 23; the manual command remains available.

After implementation review and reconciliation of the immutable Fury rollout plan
and review scope, a repository administrator can activate automatic future
attachments with one **non-secret repository variable**:

```text
CRAIG_BINARY_RELEASE_POLICY=unnotarized-preview
```

That policy accepts ad-hoc signatures and **no Developer ID or Apple notarization**.
No variable or credential is configured by this implementation. Missing, empty or
unknown values never start binary build/publish jobs. Removing the variable stops
future automatic binary publishing; it does not revoke assets already published
or stop an upload already in progress. Do not change policy while a publish job is
running; first inspect its outcome. Activation is a separate user decision, not
implied by merging this PR. No Fury approval, rejection, resubmission, cancellation
or runtime/definition rewrite is performed by this step.

No runtime downloader, other architecture/platform or Apple enrollment is added.
Homebrew remains the next separately gated distribution task; no tap credentials,
remote tap creation or pushes are provided. The earlier local formula tests do not
establish a remote Homebrew installation.

## Merge-triggered pipeline

The existing `.github/workflows/release.yml` runs on main pushes and manual
invocation. Its existing npm publisher continues using Changesets, its release
bot token, the same required gates and its existing version PR behavior. This
change does not manually edit versions or change that versioning sequence. Its
GitHub release step currently uses `RELEASE_BOT_TOKEN`; binary CD is chained by
job dependencies inside this same run, and does not rely on a `release` event or
on a bot-created event triggering another workflow. GitHub documents the
[GITHUB_TOKEN event restriction](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

After creating/finding the stable `craig-cli@<version>` release, source selection
compares the **resolved remote tag commit** with that run's clean checkout SHA.
Normal main pushes often retain an older npm version/tag; those are ineligible and
skip binary CD, rather than attaching newer source under an old version. There
is no old-release backfill path. A manual npm workflow dispatch also does not
authorize binary CD: the CI authorization path accepts only main `push` events.
A rerun of an eligible original push keeps the original source SHA.

With the policy enabled and exact source eligible:

1. `binary-build` checks out the exact release commit with full tag history and
   no persisted credentials. It verifies local tag/commit/package version and
   clean source. Using the pinned macOS ARM64 toolchain, it runs all required
   source/npm gates, binary tests/build/audit/smoke and terminal artifact soak.
   Any failed gate blocks all attachment. No `continue-on-error` is used.
2. Offline preview preparation creates the versioned archive, `SHA256SUMS`, plan
   and proposed formula. A seal checks source/policy and emits the plan SHA-256
   plus build attempt as job outputs. The plan binds both asset names/hashes.
   An immutable v4 Actions artifact receives those exact files; its ID is another
   job output. No rebuild occurs in the publish job.
3. `binary-publish` requires successful npm release and binary build jobs, the
   enabled policy and trusted main push. It downloads that artifact ID from the
   same repository/run and validates plan bytes against the sealed job output.
   It reruns the full payload/license/signature/ABI/linkage audit on staged copies
   before using the shared attachment logic.
4. The distinct `--ci` authorization path verifies repository, server, event/ref,
   workflow path/SHA, job identity, run/attempt, expected clean source/version and
   policy. Read-only GitHub API checks corroborate the run, the immutable artifact
   ID/name/run/source and the successful build job in that build attempt. No plan
   field or approval string can supply the expected commit or artifact hash.
5. Immediately before writing, the uploader resolves the remote tag again and
   checks the existing published stable release and all asset names. After upload
   it rechecks the tag, downloads both remote assets, verifies SHA-256 values and
   rechecks the tag once more. No release creation, deletion, clobber or tap writes
   are available in this command.

Workflow permissions default to `contents: read`. The two controlled publishers
are the existing npm/GitHub `release` job (its original write/id-token permissions
and bot token) and the new `binary-publish` job (`contents: write`, `actions: read`).
The new binary build, PR checks and manual candidate workflow receive no write
credentials. The publish job does not install project dependencies or build source;
its full audit is self-contained Node code and the audited standalone executable.
Trusted reviewed main code and GitHub Actions/job outputs are the authorization
boundary; this is not independent cryptographic source attestation or Apple trust.

npm publication and binary publication are sequential, not transactional. npm and
the stable GitHub release may exist before archive attachment. A binary failure
leaves the npm release intact and fails CD visibly; it does not unpublish or
mutate npm. GitHub notifications may therefore precede binary asset availability.
Standalone installations keep manual replacement/Homebrew guidance and cannot
npm-install or restart into an npm bundle. npm update/restart behavior is unchanged.

## Reruns, conflicts and recovery

The manual human-bound command retains strict conflict rejection, even for
identical existing assets. CI has a separate rerun contract:

- No matching assets: attach the exact sealed archive/checksum bytes, then verify
  downloaded hashes and tag binding.
- Both expected immutable names already exist: download and verify **both**
  against the current sealed plan. If identical, report `verified-existing`
  without writing. Name presence alone never establishes identity.
- Partial assets or differing bytes: fail visibly. No clobber, delete, automatic
  repair, or upload retry occurs. Preserve evidence and stop for human resolution.

Rerun only the failed publish job to reuse successful build output from the earlier
attempt. Provenance validates the earlier build attempt against the same run/SHA.
Actions artifacts are retained for 90 days. Missing/expired artifacts fail; do not
reconstruct an approval/hash from release metadata. Rerunning all jobs creates a
new attempt-specific artifact and repeats every gate. If the new bytes differ
from an already published release (for example due to signature/toolchain bytes),
verification fails; it does not overwrite the original. A new version may be
needed rather than repairing a partial release by deleting immutable assets.

There is still a remote race between inventory and upload. GitHub's non-clobber
upload rejects a conflicting name; multi-file upload can leave a partial release
if interrupted. Tag changes detected after writing also fail and require human
investigation. The uploader never deletes assets to undo these cases.

## Candidate builds and installation evidence

Read-only `binary-build.yml` remains available for PRs and manual candidate builds
with an explicit optional stable tag and policy. These produce Actions artifacts
only, even when the repository publication policy is activated. Its final-head CI
runs exercise the same source/npm/binary audits and smoke gates. Fixture tests
also parse the actual release workflow and check gate order, permissions,
conditions, output and artifact-ID wiring. Production publication provenance is
mocked in those tests; it is not a live release upload.

Use the [preview install guide](macos-preview-install.md) for direct install,
upgrade, rollback and Gatekeeper exceptions. The user's downloaded 0.22.0 binary
ran actual authenticated Codex cwd/input/resize tests on this Mac. Current agent/
GitHub smoke is fixture evidence. No clean Mac, another Mac, all supported macOS
versions, paid signing, notarization or offline Gatekeeper qualification is claimed.
The user has explicitly declined another-Mac testing and deferred paid signing;
these remain limitations, not additional requirements to complete implementation.

## Validation record

November 25 local validation passed: all 891 source tests, 27 binary/policy/
uploader/workflow tests, 35 focused version/channel/update tests, typecheck, lint,
source build, minified npm build, npm package audit/smoke, pinned macOS ARM64
standalone build/audit/smoke, relocated terminal soak and generated formula Ruby
syntax. Agent/GitHub/upgrade probes remain fixtures; the locally built dirty
0.22.1 development archive is not eligible for publication under an older tag.
The November 23 local source/daemon/smoke failures remain recorded in the historical
report; this newer run does not explain or erase them.

The bounded local/hosted assessment and exact final PR head are recorded in the
machine-readable `binary-cd-integration-20261125-result.json` receipt in the shared
Fury briefs, with a companion report. No Fury state is changed by this integration.
Failed local source/daemon checks remain failed; historical or hosted passes do
not retroactively turn them into successful local runs. Publication, policy
activation, actual remote install and Homebrew remain unexecuted by this change.
