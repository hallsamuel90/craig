# RFC: Product Update Discovery

- **Date:** 2026-08-07
- **Updated:** 2026-10-04
- **Status:** Completed
- **Author:** Sam / Codex
- **Amends:** 2026-05-01-rfc-craig-terminal-workspace-rewrite.md

---

## Context and goals

Craig already checks npm for a newer `craig-cli` version, but the result is only a passive footer label. Users should be able to act on an available update before entering the main TUI, in the same simple style as the Codex CLI update chooser.

Feature Previews are also easy to miss because Options gives no indication that a preview was recently added.

Goals:

- show a small launch-time chooser when a newer Craig version is available
- let the user update, continue, or ignore that exact version
- make Escape continue into Craig
- link to GitHub release notes and show the exact npm command
- mark newly added Feature Previews as `NEW` until the preview screen is visited
- preserve the existing fast path when no update is available

## Non-goals

- an in-product release-note feed or notification inbox
- a dedicated What's New screen
- update prompts that interrupt an active agent session
- automatic background updates
- support for install methods other than Craig's documented global npm install
- invoking a shell, `sudo`, or arbitrary registry-provided commands
- remotely configured announcements or telemetry

## Proposal

### Launch-time update chooser

The existing asynchronous npm registry check remains. If it returns a strict stable semantic version newer than the running version while the boot overlay is still visible, Craig replaces the normal boot menu with:

```text
Update available · 0.13.0 → 0.14.0

Release notes: https://github.com/hallsamuel90/craig/releases/latest
Runs: npm install -g craig-cli@0.14.0

> Update now
  Continue
  Ignore this version
```

Behavior:

- Up/Down and `j`/`k` move the selection.
- Enter activates the selected action.
- Escape has the same behavior as Continue.
- Continue enters Craig without persisting a preference.
- Ignore this version stores the exact target version in the existing workspace UI-state file, enters Craig, and suppresses both the chooser and footer notice for that version on later launches.
- A later version is shown normally.
- If the check finishes after the user has entered Craig, no overlay appears during that process.
- Offline, timed-out, malformed, prerelease, equal, and older results do not show the chooser.

### Updating Craig

Update now runs npm directly, without a shell:

```text
npm install --global craig-cli@0.14.0
```

The package name is hard-coded and the version must match `X.Y.Z` before npm is invoked. While npm is running, update input is disabled. Craig captures command failure through the existing command adapter and writes failures to the existing error log.

On success, Craig explains that the new package is installed but the current process still uses the old bundle. The user may Continue into the current session or Exit Craig and restart.

On failure, Craig shows a sanitized, bounded error and offers Retry or Continue. Craig does not retry automatically, request elevation, or claim the update succeeded.

### Feature Preview marker

The Options menu shows:

```text
Feature Previews · NEW
```

The preview screen marks each currently designated new preview:

```text
[ ] Agent orchestration · NEW
```

Craig stores `seenPreviewIds` in the existing workspace UI-state file when the user leaves the Feature Previews screen. The next Options render removes the marker. Preview enablement remains unchanged, workspace-local, and off by default.

The set of previews considered new is a small code-owned constant next to the preview presentation metadata. Adding or removing a marker does not change the preview contract.

## Implementation tracker

### Status summary

| Sub-phase | Capability | Implementation | Verification |
| --- | --- | --- | --- |
| `1.1` | Launch update chooser and Feature Preview `NEW` marker | Implemented | Verified |

### Verification summary

- Focused version, updater, renderer, and app-shell coverage passed with 146 tests after rebasing onto current `main`.
- Full verification passed with 701 tests, including PTY daemon and nine real-terminal E2E flows.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke` passed.
- The first full test invocation inherited Craig task-targeting environment variables from this agent session, causing the interactive startup fixture to resolve the parent workspace. The unchanged suite passed after unsetting `CRAIG_WORKSPACE_ROOT`, `CRAIG_TASK_ID`, `CRAIG_AGENT_TAB_ID`, and `CRAIG_AGENT_CAPABILITY`, matching CI's non-nested environment.
- After rebasing, `pnpm install --frozen-lockfile` refreshed the worktree dependencies required by current `main`; the final npm bundle and package gates then passed for `craig-cli` 0.17.1.

### Next resume point

No implementation work remains. Future update-install methods or product communication surfaces should begin in a new RFC.

### Skipped and deferred work

- A What's New feed, right-panel inbox, update hotkeys, and remote announcements were intentionally removed as over-designed.
- Homebrew, pnpm, Yarn, Bun, `npx`, and source-checkout update detection are deferred.
- User-global notice state is deferred; this slice uses the existing workspace UI-state file.

### Phase execution and verification policy

The phase is complete only when:

- the update chooser works through registry detection, rendering, input, npm execution, result handling, and persisted ignore state
- the preview marker renders and clears through the app-shell flow
- in-scope focused tests and all relevant repository evals pass
- the covered app-shell and terminal flows run during tuning
- out-of-scope failures are recorded in the verification summary
- a minor `craig-cli` Changeset is included

Before marking the phase verified, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.

Every implementation session resumes from the first sub-phase that is not both implemented and verified. When implementation or verification changes, update the status summary, verification summary, and next resume point together.

## API and data model changes

There is no new public CLI command or network API.

Internal changes:

- `VersionCheckResult` continues to carry current version, latest version, and availability.
- Version comparison accepts only stable `X.Y.Z` strings.
- The shell layer owns the npm update adapter.
- `AppState` gains a transient update overlay with `ready`, `installing`, `success`, and `error` phases.
- `CraigUiRuntime` gains optional `ignoredUpdateVersion` and `seenPreviewIds` fields. Existing version-1 UI-state files remain valid.
- Terminal app options accept injected check/install functions for deterministic tests.

The npm artifact remains the existing minified `packages/cli/dist/cli.js`. No files are added to the package allowlist.

## Edge cases and failure modes

- A registry failure or timeout preserves the normal boot flow.
- A check that finishes after boot does not interrupt the main shell or PTY input.
- An ignored version suppresses itself but not a later version.
- Malformed and prerelease versions cannot reach npm execution.
- npm absence, permission errors, network errors, and non-zero exits keep Craig usable.
- Update errors are stripped of control characters and capped before rendering.
- Input is ignored after npm starts so Craig does not deliberately interrupt a global install.
- Successful installation does not relabel the running process as the new version.
- Missing optional UI-state fields mean no ignored version and no seen previews.
- Opening Feature Previews shows the item-level marker; leaving records all current preview ids as seen.

## Security and privacy

- Craig spawns `npm` directly with a hard-coded package name and validated exact version.
- No shell is involved, so registry version text cannot inject commands.
- Craig never invokes or recommends `sudo`.
- No credentials, npm configuration, workspace content, or telemetry are added.
- Release notes use a fixed Craig GitHub URL.
- Update errors are sanitized before terminal rendering and local logging.

## Observability

- Ordinary offline update checks remain silent.
- Attempted update failures use Craig's existing error log with the `update Craig` context.
- Renderer and app-shell tests protect the visible chooser, exact command, ignore behavior, and preview markers.

## Rollout plan

### Phase 1.1: Update chooser and preview marker

Ship the launch-time update chooser, exact npm updater, ignore-version persistence, and Feature Preview `NEW` marker as one small user-visible slice. The behavior is additive stable CLI functionality and requires a minor Changeset for `craig-cli`.

## Plan Mode handoff checklist and acceptance criteria

### 1.1 Handoff

#### Implementation

- validate stable semantic versions before reporting update availability
- render the launch chooser with versions, fixed release-notes URL, and exact npm command
- implement Update now, Continue, Ignore this version, and Escape-to-continue
- run npm directly with the exact validated target
- render installing, success, and failure states
- persist ignored version and seen preview ids through backward-compatible UI state
- show and clear Feature Preview `NEW` markers
- add a minor `craig-cli` Changeset

#### Verification

- cover valid, malformed, prerelease, equal, and older versions
- assert the exact npm executable and argument array and reject invalid targets
- cover chooser rendering, update success, Ignore persistence, and next-launch suppression
- cover preview marker rendering and clearing
- retain app-shell coverage for boot, PTY warm-up, direct task launch, and create-task direct agent transition
- run all release gates

#### Tracking update

- keep `1.1` open if update UI can interrupt an active shell, ignored versions reappear, npm can receive an unvalidated version, or preview markers cannot clear
- record any out-of-scope gate failures and their disposition
- update status summary, verification summary, and next resume point together

### Final acceptance criteria

- `[1.1]` A newer stable Craig version produces the launch chooser only while the boot overlay is active.
- `[1.1]` Enter selects an action and Escape continues into Craig.
- `[1.1]` Update now runs `npm install --global craig-cli@<exact-version>` without a shell.
- `[1.1]` Update success and failure are explicit and never make the current process unusable.
- `[1.1]` Ignore this version suppresses that version and allows a later version to appear.
- `[1.1]` Release notes use the fixed Craig GitHub releases URL.
- `[1.1]` Newly designated previews show `NEW` in Options and the preview list until the user leaves that screen.
- `[1.1]` Existing PTY boot, attach, and create-task direct-launch contracts remain covered and passing.
- `[1.1]` The shipping change includes a minor `craig-cli` Changeset and passes all release gates.
