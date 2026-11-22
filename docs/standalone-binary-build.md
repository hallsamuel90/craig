# Standalone macOS ARM64 build

Implementation of the [checklist](standalone-binary-checklist.md), informed by the
[spike](standalone-binary-spike.md). This change prepares a reviewable binary and
offline distribution drafts. It does not publish a release or Homebrew tap.

## Build and check

Use macOS ARM64, build-driver Node **24.12.0**, pnpm **10.7.1**, Apple clang
**17.0.0 (clang-1700.6.3.2)** and macOS SDK **26.2**. The CI definition selects
Xcode 26.2 on `macos-26`; its availability still needs a real hosted CI run. Local
Command Line Tools with the exact same reported compiler/SDK are accepted.

```sh
pnpm install --frozen-lockfile
pnpm binary:test
pnpm build:binary
pnpm binary:audit
pnpm binary:smoke
pnpm binary:release:prepare
```

`scripts/binary/toolchain.json` pins the build inputs. The builder downloads the
official Node **26.13.0** Darwin ARM64 archive over HTTPS and verifies its pinned
SHA-256 before extraction on every build. It uses that distribution's headers and
node-gyp 12.4.0 to rebuild node-pty 0.10.1 with locked NAN 2.28.0 in an isolated
directory. The checkout's installed addon stays usable by the build-driver Node.
The target runtime must load the rebuilt addon, and its native linkage is audited.

The builder reads an explicit versioned runtime file allowlist, includes licenses
(including bundled YAML, NAN and Node's notices), strips map comments from runtime
JS, bundles Craig without maps, and calls `node --build-sea` with a relative main
filename. No old spike staging tree, source-text substitution or `postject` is used.
Dependency upgrades require reviewing `payload-allowlist.json` and licence coverage.
The vendored xterm license comes from the upstream `xterm.js` 6.0.0 `LICENSE`, since
the `@xterm/headless` npm archive omits a standalone license file.

Working files stay in `.craig/binary-build/`; the executable is
`.craig/binary-build/craig`. `dist/binary/` contains:

- `craig-<version>-darwin-arm64.tar.gz`, with exactly `craig`, `LICENSE`,
  `THIRD_PARTY_NOTICES`, `build.json` and `payload-manifest.json`;
- `SHA256SUMS` for the final archive, plus a readable build metadata sidecar;
- after release preparation, `draft/release-assets.json` and `draft/craig.rb`.

The payload identity hashes canonical sorted file paths, contents and required
modes, not archive timestamps or ownership. Gzip/tar metadata is normalized. Signed
artifacts can differ because trusted timestamps/signatures change; their final
archive checksums are separate from runtime resource identity. Build metadata records
the target, runtime/native ABI, compiler/SDK, tool versions, dependencies, Git commit,
dirty-source status and signature qualification. A dirty development artifact is
not eligible for release preflight.

The audit checks both embedded resources and outer inventory. Craig files and the
addon must contain no private build paths or source maps. The stock, checksummed
Node runtime contains its upstream release-builder diagnostic paths; the audit
allows only that exact path inventory fingerprint in the executable and rejects
any additions. It does not claim to rebuild Node to remove those upstream paths.
Node's own source-map implementation strings are also distinguished from emitted
Craig/dependency source maps. The embedded manifest is checked against the archived
manifest by executing the relocated binary's `--binary-info` command.
The auditor also retrieves the compressed embedded resource container through an
internal audit transport, revalidates each decoded file, inspects the actual
addon signature/linkage, checks licence attribution and compares the running
runtime's version/ABI/platform with the recorded build metadata. A self-consistent
manifest alone is not treated as proof that its content passed the policy audit.

## Runtime cache, repair and manual updates

The binary embeds a compressed, checksummed resource container. Before any resource
is used, startup verifies its manifest and cached file contents, types, ownership
and permissions. Cache location:

```text
~/Library/Caches/craig/runtime-v1/<payload-identity>-<generation-uuid>/
```

Each generation has private permissions and PID leases. A cache lock serializes
selection, extraction and pruning; definite dead lock owners can be reclaimed.
Interrupted extraction is never accepted as complete. Repair publishes a new
verified generation atomically and leaves existing leased generations intact.
Permission/disk errors fail startup with a cache error instead of executing an
unverified entry. Existing symlinked ancestors/resources are refused, not followed.
This protects against unexpected files/other-user access; it is not a security
boundary against a malicious process already running as the same user.

Inactive PID leases are removed during subsequent launches. Resources are not
automatically pruned during normal startup; run this in the standalone executable:

```sh
craig --binary-cache-prune
```

Pruning first acquires a current verified generation. It preserves live leases,
permission failures, malformed/uncertain entries and possible PID reuse, and removes
only verified Craig-owned unused generations or definite-dead extraction staging
directories. It never removes workspace state. An uncertain lock/unknown entry may
need manual inspection; do not delete cache files while a daemon may still use them.

Installation channel is detected with Node's SEA API, not PATH or environment
heuristics. Standalone daemons invoke the executable directly. Binary updates are
manual: replace the downloaded executable; if Homebrew owns the installation, use
`brew upgrade craig`. The UI gives conditional guidance instead of guessing Homebrew
ownership, and cannot invoke npm installation or restart into an npm bundle. npm
installs retain their existing behavior. Git, gh and coding-agent CLIs remain
external tools; the standalone binary only removes the separate Node prerequisite.

## Signing and notarization integration

Default builds use **ad-hoc developer signatures**, never distribution qualification.
An optional local/CI identity can be supplied when an authorized environment exists:

```sh
pnpm build:binary --sign-identity 'Developer ID Application: <identity>'
```

The builder signs the addon before embedding it, then signs the final executable
with hardened runtime/timestamp options, preserves entitlements from the verified
upstream Node executable, and verifies Apple's Developer ID Application requirement.
No identity, keychain, Apple team, certificate, password or Actions secret is created
by this change. This optional branch requires real credentialed validation.

Notarization is an external release-qualification step. Its submission must cover
the final executable and the exact signed addon bytes embedded in the resource
container; do not assume Apple's service understands Craig's compressed payload.
After acceptance, verify downloaded/quarantined installation and native loading
on a clean Mac. Do not assume a raw Mach-O CLI or `.node` file can be stapled like
an application bundle/installer. Offline ticket delivery and any installer container
need qualification too. Record notary receipts against the final signed artifact's
hash; do not rewrite embedded metadata after signing to claim notarization.

## Distribution stays disabled

The new binary workflow has read-only repository permissions and uploads only
development Actions artifacts. The existing npm publisher, GitHub release step,
package versions and three-file npm allowlist remain intact.

`binary:release:prepare` works offline. It checks the archive/checksum/version, writes
a release intent for `craig-cli@<version>`, and renders an ARM64 Homebrew tap recipe
with an immutable archive URL and SHA-256. It neither uploads nor creates a tap.
`validateReleaseTarget` is a tested preflight helper for the future authorized
publisher: its caller must obtain the real remote tag's resolved commit and asset
inventory. It rejects mismatched tags/commits, existing asset-name conflicts, dirty
or unknown source state, missing/invalid checksummed assets and unqualified
signing/notarization. Formula rendering accepts only the exact versioned archive
URL, not arbitrary strings interpolated into Ruby. The draft conservatively requires
macOS Sonoma (14) or newer: the embedded Node's Mach-O deployment floor is 13.5,
and this avoids permitting unsupported earlier hosts. Older host execution still
needs qualification. No credentialed remote lookup/upload
implementation is enabled here. Final notarization qualification must come from a
separate verified receipt; current build metadata intentionally records it as false.

The standalone smoke harness uses a test-only second executable with benignly
changed payload bytes to exercise atomic replacement, old-daemon reattachment,
live-cache retention and post-exit cleanup. It does not edit package versions or
produce a second release archive. This tests upgrade mechanics with fixtures,
not authenticated real-runner upgrades between published releases.

Before publication: pass all required gates, validate hosted CI and real Codex/gh
flows on a clean Mac without Node, qualify Developer ID/notarization/quarantine
behavior, confirm the tap name, and obtain publication authorization. Ruby syntax
and fixture tests are not a live Homebrew install from a published URL.

## Experimental terminal backend

`build:binary` prepares the pinned Ghostty Wasm before bundling and includes its license notices. The binary audit verifies the embedded checksum and module validity. No Ghostty Wasm sidecar or runtime download is required.

Run `pnpm verify:artifact --executable .craig/binary-build/craig --profile soak --report /tmp/terminal-soak.json` for both terminal backends, output load, resizing, input, reconnect, child cleanup and normal daemon self-bootstrap. The driver relocates the native executable and uses a temporary home/cache. Its deterministic PTY peer intentionally uses host Node; keep `binary:smoke` for the separate no-Node-on-PATH checks. Native offline proof still needs an external network sandbox.
