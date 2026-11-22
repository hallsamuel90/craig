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
