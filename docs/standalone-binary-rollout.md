# Standalone binary preview rollout

Started 2026-11-22. [Draft PR #316](https://github.com/hallsamuel90/craig/pull/316)
contains the preserved spike and implementation, merged with current `main`.
No binary publisher or tap writer is enabled. Merging to `main` still invokes the
existing npm release workflow; assess that separately before merging.

## Qualification in progress

- Hosted macOS qualification starts through the PR's read-only binary workflow.
  It runs all release gates and uploads development Actions artifacts only.
- The November 13 Fury review expired without approval. Its verify evidence remains
  in [the validation report](standalone-binary-validation.md); PR human review is
  still required. No checkpoint has been approved by an agent.
- This Mac has no valid code-signing identities. Actual Developer ID credentials,
  notarization and downloaded/quarantined execution remain outstanding.
- Local and hosted test results from this rollout must supplement, rather than
  replace, the dated November 13 evidence. Agent/GitHub smoke uses fixtures.

## Preview promotion

1. Obtain green hosted gates and human review. Run real agent/GitHub workflows on a
   clean Mac without Node, testing task creation, agent input/resize/reattach,
   daemon recovery and executable replacement. Limit advertised OS support to
   hosts actually qualified.
2. Sign and notarize the final distribution, including qualification of the
   extracted native addon. Validate quarantine behavior and offline ticket needs.
3. Authorize an opt-in macOS ARM64 GitHub preview with versioned archives,
   checksums, installation instructions and manual updates. Keep npm available.
4. Validate Homebrew installation and upgrade against those real immutable assets,
   then separately authorize tap publication. No arbitrary private-beta waiting
   period is required if these checks pass.

Retain previous versioned assets for rollback. Replace the installed executable
atomically; keep resources used by an older daemon until that daemon exits. A
preview does not introduce an automatic download updater or other target platforms.
