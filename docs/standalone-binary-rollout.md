# Standalone binary preview rollout

Started 2026-11-22. [Draft PR #316](https://github.com/hallsamuel90/craig/pull/316)
contains the preserved spike and implementation, merged with current `main`.
PR #316 is now merged as f5dbba2. No binary publisher or tap writer is enabled.
Merging to `main` invokes the existing npm release workflow; see the post-merge
results below.

## Qualification in progress

- Hosted macOS qualification starts through the PR's read-only binary workflow.
  It runs all release gates and uploads development Actions artifacts only.
- The November 13 Fury review expired without approval. Its verify evidence remains
  in [the validation report](standalone-binary-validation.md); PR human review is
  was supplied through the user's instruction to merge PR #316. The expired Fury
  checkpoint itself has not been approved by an agent.
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

## November 22 qualification evidence

The branch now includes upstream `craig-cli` 0.21.0 through a merge, without manual
version edits. Local typecheck, lint, build, npm build/audit/smoke, 16 focused binary
tests, standalone build/audit and relocated binary smoke passed. The smoke keeps
agent/GitHub fixtures and runtime isolation; it is not clean-machine qualification.

The first post-merge local full suite recorded 840 passed, five failed and one
unhandled rejection. Failures were the stale standalone launcher assertion, the
PR event-monitor timeout, daemon PR synchronization, cross-process task notification
and daemon-loss event watching. The rejection followed event-watch cleanup after
a failed test. The stale assertion and relocated smoke's old launcher/tab markers
were aligned with the current UI; the focused standalone test and smoke then passed.
An isolated monitor rerun passed, but those local full-suite failures are not waived.
A diagnostic run observed seconds spent closing filesystem watchers; this is
evidence to investigate, not proof of the cause of every daemon failure.
The corrected full rerun passed 842/845: the three daemon tests still failed, with
one unhandled rejection during event-watch cleanup. Thus the current local source
test gate remains failed. The three daemon failures and an unhandled rejection also
reproduced in a separate checkout of unmodified `origin/main` (83f0f67), using this
Mac and the same installed dependencies. No test deadlines or production watcher
behavior were changed to obtain a passing result.

The first hosted macOS run
([45054227336](https://github.com/hallsamuel90/craig/actions/runs/45054227336))
recorded 844 passed and only the stale launcher assertion failed. Corrected hosted
checks are required before promotion. Superseded intermediate runs were cancelled
to avoid duplicate work; cancelled runs are not passing evidence.

At 6ee3273, [standard hosted CI](https://github.com/hallsamuel90/craig/actions/runs/45054554312)
passed all gates with 845 source tests. The
[hosted macOS job](https://github.com/hallsamuel90/craig/actions/runs/45054554517)
also passed 845 source tests, all standard gates, 16 focused binary tests and the
pinned standalone build/audit. Its smoke then exposed a new-task harness race:
replayed output from an older agent could satisfy the generic ready marker before
the new agent's cwd record existed. The corrected harness requires a marker naming
the new task and input echoed by that task before reading its cwd. It retains the
direct create-to-agent requirement; no attach step or timing allowance was added.
The binary workflow now cancels superseded PR runs and limits jobs to 30 minutes.
The strengthened local smoke passed after waiting for terminal mode, stripping ANSI
styling before matching text, and keeping the task-specific input acknowledgement
short enough to fit the actual 44-column agent pane. The longer acknowledgement
was visibly wrapped across rows; it was not evidence of missing agent input.

## Post-merge qualification

- [Final PR binary CI](https://github.com/hallsamuel90/craig/actions/runs/45055212148)
  and [standard CI](https://github.com/hallsamuel90/craig/actions/runs/45055212153)
  passed at 36189e9: 845 source tests, all seven release gates, 16 focused binary
  tests, standalone build/audit/smoke and offline distribution preparation.
- The downloaded CI archive passed a separate local audit. Its canonical payload
  identity matched the local build across hosts and checkout locations:
  `98a3fc24af5e0cbc1266286f98c5e14c7068824a9730c38ea8b948bd753d701f`.
- [Merged-main binary CI](https://github.com/hallsamuel90/craig/actions/runs/45082467410)
  passed at f5dbba2. These development artifacts remain ad-hoc signed and not notarized.
- A local read-only probe of the downloaded 0.21.0 development executable used
  **actual authenticated Codex 0.165.0**, a temporary repository, fresh HOME and
  blocked external Node/npm/Bun. The native Codex runner used a temporary copy of
  existing login credentials, removed during cleanup. It executed the initial
  prompt, and its own session metadata confirmed the exact task worktree cwd.
  After resizing the TUI, a follow-up prompt received the expected model response.
  This is real-runner evidence on a development Mac, not a clean-machine test or
  qualification of every daemon/upgrade workflow with real accounts.
- The first probe could not compare a full cwd rendered across pane rows; the
  corrected probe checked actual Codex session metadata. Sending pasted text and
  Enter together also left a visible, unsubmitted Codex prompt; waiting for the
  rendered text before sending Enter passed. Cleanup now waits for daemon exit.
  These diagnostic corrections did not change Craig production code.
- The existing release workflow automatically created and merged version PR #317,
  producing 0.22.0 at a436ff8. No package version was edited manually.
  [Its release run](https://github.com/hallsamuel90/craig/actions/runs/45082755162)
  initially passed all build/test gates but **npm publication failed with E404**.
  After the user rotated the token, the same CI run succeeded: npm reports 0.22.0
  as latest and the `craig-cli@0.22.0` GitHub Release exists with no binary assets.
- `NPM_TOKEN` secret metadata reports last update on August 21, more than 90 days
  before this attempt. npm limits write tokens to
  [90 days](https://api-docs.npmjs.com/). Expiry is the leading explanation, not a
  verified inspection of the secret's expiry. The package name/public access and
  publisher configuration remain unchanged. The user subsequently rotated the
  credential and CI recovered. No token value was read, replaced or printed by
  the agent; no local publish was performed.
- [0.22.0 binary qualification](https://github.com/hallsamuel90/craig/actions/runs/45082950134)
  **passed** from main at a436ff8, including all gates, standalone smoke and
  development artifact upload. The downloaded 0.22.0 archive passed a separate
  local audit. Repeating the actual authenticated Codex probe against this exact
  candidate also passed worktree cwd, follow-up input and resize with external
  runtimes blocked. It remains ad-hoc signed and not notarized. npm publication has
  recovered as above. No binary upload to GitHub Releases or tap publication is
  enabled. A clean Mac test host is still required.

## Current next steps

PR #319 records qualification evidence only; it introduces no additional runtime
feature. npm 0.22.0 is published, while the standalone archive is still a development
Actions artifact. Paid Apple Developer enrollment is deferred pending the user's
budget decision. It is not necessary simply to distribute a CLI, but the current
release preflight deliberately requires Developer ID and notarization. Choosing an
unnotarized preview would require an explicit policy/preflight change, clear
installation expectations and clean-Mac download/Homebrew testing before publishing.
No such policy change or publication is performed by this documentation update.
