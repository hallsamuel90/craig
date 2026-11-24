# Bounded macOS delivery plan

Scope: macOS ARM64 standalone preview only, built from an exact clean stable
`craig-cli@<version>` source commit. Reuse PR #321 for GitHub discovery and npm vs
standalone update/restart contracts; #319 retains historical qualification evidence.
No merging, release attachment, remote tap creation/push, paid signing, second Mac,
automatic downloader or terminal replacement is authorized in this step.

1. Add explicit `unnotarized-preview` preparation and publication policy; keep the
   default Developer ID/notarization requirement. Preserve signature metadata.
2. Prepare versioned archive/checksum and formula candidates offline. Implement a
   manual local attachment command with exact approval binding, full audit,
   remote tag dereferencing, released/stable target validation and immutable-name
   rejection. Never create a release, replace assets or write the tap.
3. Test policy and uploader using fixtures, with no network writes. Run binary,
   channel/update, npm packaging and source gates. Record failures without waiver.
4. Document publication review, install/upgrade/rollback and evidence limits.
   Commit/push a stacked implementation PR; list all three review PRs.

Publication is a separate human-reviewed step: review the exact source/tag/hash,
CI evidence, candidate policy, installation evidence and generated tap diff before
running the uploader. Local fixtures cannot establish public download/Homebrew
installation. Revalidate remote state and downloaded checksums at publication.
Linux x64 follows macOS later; all other targets remain excluded.
