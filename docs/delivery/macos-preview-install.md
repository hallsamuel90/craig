# macOS ARM64 unnotarized preview delivery

This is an opt-in preview, with **ad-hoc signatures, no Developer ID publisher
identity and no Apple notarization**. Paid signing is deferred. Gatekeeper may
block a quarantined download. Do not describe this policy as Apple approval.
Only this Mac has actual downloaded 0.22.0 execution evidence. macOS Sonoma (14)
is the conservative formula floor, not a claim of execution on every 14+ release.
Clean-machine, other macOS versions and offline Gatekeeper behavior are untested.
No second Mac or new credentials are required to complete preparation.

## Prepare and review (no publication)

PR #321 provides GitHub stable-release discovery. npm installations retain npm
update/restart. Standalone installations only show manual replacement/Homebrew
instructions and never npm-install or restart into the npm bundle. A stable GitHub
notification can precede standalone asset availability; inspect the release assets
before attempting an update. There is no automatic download updater.

After implementation review/merge and normal Changesets CI release, select the
exact stable `craig-cli@<version>` tag. Do not attach a new-source build to an older
tag. Do not edit versions manually. Use the read-only binary workflow's manual
`release_tag` and `unnotarized-preview` inputs. Its gates build the exact tag and
produce Actions artifacts only. The existing npm publisher remains independent.
For local reproduction use the pinned build environment from the build guide:

```sh
pnpm build:binary
pnpm binary:audit
pnpm binary:smoke
pnpm binary:release:prepare --policy unnotarized-preview
```

Preparation emits `dist/binary/draft/release-assets.json` and `craig.rb`.
Preparation can emit dirty development drafts; attachment rejects them. Default
preparation still selects the notarized policy, which rejects ad-hoc artifacts at
attachment. Preview policy accepts only truthful ad-hoc/non-notarized metadata;
it does not bypass checksum, payload, license, ABI/linkage or cache checks.
The current builder records `notarized: false`; the notarized policy still needs
separately implemented receipt qualification and is not enabled by this work.

Publication review must include exact tag/resolved commit/version, both asset
names and hashes, actual archive audit, green required source/npm/binary gates,
documented execution/installation evidence and its limits, and the generated
`Formula/craig.rb` diff proposed for **hallsamuel90/homebrew-tap**. The tap name is a
proposal: read-only lookup did not resolve it, which is not proof of absence.
The formula must refer to the immutable versioned GitHub URL and actual SHA-256.
A fixture formula or Ruby syntax check is not a remote installation test.

## Separately authorized attachment

Only after human publication review, in the exact clean source checkout with the
reviewed archive/checksum/draft layout, run:

```sh
pnpm binary:release:attach dist/binary/draft/release-assets.json 'craig-cli@<version>@<full-commit>:<archive-sha256>'
```

This step was **not run** during implementation. It uses the operator's existing
`gh` authentication and repository release-write permission; no new secrets are
configured. It reruns the full audit on staged copies, resolves remote lightweight
or annotated tags to commits, checks the existing published stable release and
paginates all assets. It rejects either immutable asset-name conflict, even if the
existing bytes match. It never creates a release, deletes/clobbers assets or
writes a tap. It downloads both uploaded assets and verifies their hashes.
Concurrent publication is still possible between preflight and upload; GitHub's
no-clobber upload is the final conflict guard. A failed or interrupted multi-asset
upload can leave a partial release: stop for human investigation, record exact
remote state and do not delete, overwrite or automatically retry to repair it.
Revalidate remote tag/state and hashes at each publication attempt. Missing `gh`
credentials/permissions are an external dependency, not a reason to request secrets
in chat. No automatic uploader runs in CI.

## Direct install after assets exist

Substitute an actually published version; these commands are instructions, not
claims of completed downloads. Use a new temporary directory, download the
versioned archive and `SHA256SUMS` from that release's assets, then run:

```sh
shasum -a 256 -c SHA256SUMS
tar -tzf craig-<version>-darwin-arm64.tar.gz
```

Expect only `craig`, `LICENSE`, `THIRD_PARTY_NOTICES`, `build.json` and
`payload-manifest.json`. Extract in the temporary directory and inspect build
metadata and signing state. Keep license files. A checksum detects differing bytes;
it is not Apple publisher authentication. Verify `codesign --verify --strict craig`
and inspect `codesign -dv --verbose=4 craig` and `xattr -l craig` before execution.

If macOS blocks execution, use the documented System Settings → Privacy & Security
exception for the specific executable if offered and you accept the preview risk.
If that is unavailable, a deliberate per-file exception is
`xattr -d com.apple.quarantine ./craig` on the verified extracted executable only,
followed by `./craig --help`. Do not disable Gatekeeper globally or recursively
remove quarantine from unrelated files. Native addon extraction/loading may still
be blocked; stop and record that result. No clean-Mac/quarantine success is claimed.

For a new direct installation, put the verified executable in an owned directory
such as `~/.local/bin`, preserve its executable mode and add that directory to PATH.
First inspect `command -v craig` to avoid accidentally replacing an npm or Homebrew
installation. Keep the archive and licenses for rollback.

## Homebrew after separate tap publication review

The proposed local diff installs the executable plus licenses and requires ARM64
and macOS 14+. Do not create or push the remote tap in this step. After assets
exist, download/recheck their hashes, validate the generated formula against them,
and separately authorize tap publication. Then the intended commands are:

```sh
brew tap hallsamuel90/tap
brew install hallsamuel90/tap/craig
brew test hallsamuel90/tap/craig
brew upgrade hallsamuel90/tap/craig
```

These commands have not passed against public assets/a remote tap. Formula syntax,
fixture downloads and local package installation must be labelled separately from
remote `brew install`, upgrade and rollback. Do not add automatic quarantine removal
or invent a successful installation. npm remains available during the preview.

## Upgrade, restart and rollback

Keep the old executable or previous versioned archive. For a direct installation,
verify/extract the new archive, stage its executable beside the installed path and
rename it atomically on the same filesystem. Homebrew installations use `brew
upgrade hallsamuel90/tap/craig`. Exit/restart Craig explicitly to use the new version;
an already running daemon can continue using its original executable/resources.
Do not interrupt active user daemons as part of validation.

For direct rollback, verify the retained old archive and atomically restore its
executable at the same owned path, then restart manually when safe. For a Homebrew
rollback, retain the previous formula revision/archive hash and have the tap
maintainer publish a reviewed rollback recipe referencing that immutable version;
otherwise use an isolated direct installation at a different path until available.
Do not overwrite the Cellar with an unmanaged executable. A real remote Homebrew
upgrade/rollback remains a later check.

Do not delete runtime generations used by an old daemon. The existing immutable
payload identity/generation cache and PID leases preserve old resources; pruning
is explicit via `craig --binary-cache-prune` and retains uncertain/live entries.
The fixture upgrade smoke proves replacement/cache mechanics, not upgrades between
public releases. Git, gh and agent CLIs remain external dependencies.
