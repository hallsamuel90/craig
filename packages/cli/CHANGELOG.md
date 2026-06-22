# craig-cli

## 0.7.3

### Patch Changes

- ac64aef: Introduce config domain with colocated unit tests

## 0.7.2

### Patch Changes

- befc189: Correct the published README and site docs to match Craig's current TUI keybindings, read-only review panel, and agent-driven task workflow.

## 0.7.1

### Patch Changes

- 6497e9d: QoL improvements: focus flash hotkey, shift-guards for destructive keys, divider warp fix, directory styling, open PR hotkey, and polyrepo Enter bug fix

## 0.7.0

### Minor Changes

- ab6d94c: Add search to the TUI workspace browser and file inspector.

## 0.6.10

### Patch Changes

- 78a5f15: Keep the selected workspace browser entry visible in long directory lists and allow paging or wheel scrolling while choosing a workspace.

## 0.6.9

### Patch Changes

- 65d228b: Overhaul README with updated copy, tagline, and project links.

## 0.6.8

### Patch Changes

- 1af26a7: Overhaul README with updated copy, tagline, and project links.

## 0.6.7

### Patch Changes

- abc2f2a: Overhaul README with updated copy, tagline, and project links.

## 0.6.6

### Patch Changes

- a740375: Overhaul README with updated copy, tagline, and project links.

## 0.6.5

### Patch Changes

- 103b0a2: Declare all runtime dependencies in the published package instead of bundling some third-party packages into the CLI artifact.

## 0.6.4

### Patch Changes

- 68ceb22: Warm the restored selected PTY tab on shell boot when the daemon has no cached rows, so Craig renders the last selected agent or terminal instead of showing an extra attach prompt.

## 0.6.3

### Patch Changes

- 93783d1: Update package metadata and public documentation for Craig's MIT open-source release posture.

## 0.6.2

### Patch Changes

- 9dec550: Fix PTY session content not rendering after boot overlay dismiss

  The pre-hydrate fix from #81 fired `hydrateOpenPtyTabs()` as fire-and-forget at boot and then launched a _second_ concurrent call via `hydrateAndRenderOpenPtyTabs()` when the user pressed Enter. The two concurrent hydrations raced on the daemon socket, making the post-Enter re-render unreliable.

  Now the boot hydration promise is stored as `bootHydrationReady` and the Enter handler chains its re-render directly onto that promise — a single hydration, guaranteed re-render once it completes, no concurrent duplicate.

## 0.6.1

### Patch Changes

- 8aec68f: Fix the center panel tab rule width and render the terminal engaged indicator in green.

## 0.6.0

### Minor Changes

- 6b63bb8: Surface recoverable TUI errors as footer toasts and record them in a local Craig error log accessible from Options.

## 0.5.6

### Patch Changes

- 45803ac: Fix engaged tab underline to actually render in green

## 0.5.5

### Patch Changes

- 3332db4: Pre-hydrate PTY sessions at boot so agent content is visible on reopen without attaching

## 0.5.4

### Patch Changes

- 68d35a5: Use green underline on the active center panel tab to signal PTY engagement
- 945add2: Fix review panel PR badges so project rollups and merged child PR rows no longer show stale pending review state, and color approved review text green.

## 0.5.3

### Patch Changes

- a6425fe: Improve the review panel PR metadata display with draft and closed PR coloring, review-required blockers, recent comments, and deduped stale cancelled checks.

## 0.5.2

### Patch Changes

- c87c239: Prune stale PTY daemon sessions on startup to prevent forkpty exhaustion after crashes

## 0.5.1

### Patch Changes

- 1568ef8: Fix the in-app update check to compare against the published craig-cli package instead of an unrelated npm package, keep the selected PTY tab focused when attaching from the left task list, and reassert Craig's fullscreen terminal screen on resume/resize redraws.

## 0.5.0

### Minor Changes

- 8253158: Sequential PR support, bug fixes, and PTY engagement indicator.

  - Tasks now support multiple sequential PRs — when a PR is merged or closed, the poller and discovery logic automatically track the next open PR on the branch
  - Fixed `craig task show` corrupting project task PR state by querying the wrong repo
  - Fixed project tasks showing "not linked" in the CLI despite having per-target PRs
  - Fixed focused region not switching to the center panel when a new task creation attaches the PTY
  - Added `engaged ●` indicator in the center tab row when the terminal PTY is active
  - Footer brightens when the PTY is attached or a modal input is open to draw focus
  - Removed noisy `● live/idle` label from the top rail
  - Version number now displayed in the pause overlay

## 0.4.15

### Patch Changes

- 33ee994: Map Ghostty/Kitty Shift+Enter terminal input to a PTY line feed instead of forwarding the raw escape sequence.

## 0.4.14

### Patch Changes

- a13996a: Batch background pull request polling by GitHub repository and retry rate-limited batch requests with exponential backoff plus jitter.

## 0.4.13

### Patch Changes

- f502c32: Tighten review panel layout: collapse PR number and GitHub link to one line, split merge state and sync time onto separate lines, simplify branch display, and reduce whitespace in checks rows.

## 0.4.12

### Patch Changes

- e4cb800: Preserve closed task state when background pull request refreshes complete after a task is removed from the TUI.

## 0.4.11

### Patch Changes

- 7a3f5ac: Fix project workspace arrow-key navigation so the new project task row follows existing task rows.

## 0.4.10

### Patch Changes

- bfc7fc3: Generate an `AGENTS.md` guide in project task bundles so agents can identify the child repo worktrees and avoid running repo Git commands from the bundle root.

## 0.4.9

### Patch Changes

- 7327b64: Fix project workspace registration so discovered repos use their trunk/default branch instead of the currently checked-out feature branch, and prevent project task PTYs from accidentally resolving Git commands to a parent repo outside the task bundle.

## 0.4.8

### Patch Changes

- 55f4e5b: Fix project workspace PR check refreshes so target PR checks update through the manual refresh path and tracked target refresh failures are reported instead of being treated as missing PRs.

## 0.4.7

### Patch Changes

- 479d21b: Fix project workspace PR tracking so polyrepo task refresh and polling surface per-repo PR/check state in the task list and review header.

## 0.4.6

### Patch Changes

- 3f2d0c3: Avoid injecting OSC color query responses into embedded terminal sessions so interactive prompts such as `gh auth login` do not receive unexpected escape sequences as input.

## 0.4.5

### Patch Changes

- 25f5f16: Fix project task bundle creation for repositories whose default branch is not `main`, and fail cleanly instead of creating a manifest-only bundle when every repo target cannot be provisioned.

## 0.4.4

### Patch Changes

- e9fd244: Provision project task repo worktrees directly inside the task bundle root, beside `manifest.json`, so agents can immediately see checked-out project repos from the launch directory.

## 0.4.3

### Patch Changes

- 7ab23ca: Add `craig workspace remove <workspace-id>` for deleting archived workspace records once no task records reference them.

## 0.4.2

### Patch Changes

- 9170984: Fix terminal rendering so rich PTY output cannot shift Craig's frame down.

## 0.4.1

### Patch Changes

- e7f3bcc: Show PR lifecycle and CI check status icons on left nav task rows.

  Each task row in the left panel now displays a right-aligned badge with the PR state icon and check status icon when a PR exists. Icons reuse the same color coding as the right inspection panel. Text status labels (`running`, `merge_ready`, etc.) are removed from task rows in favour of the icons.

## 0.4.0

### Minor Changes

- 55e1e3d: Add project workspace support with multi-repo task provisioning and review panel.

  Project workspaces span multiple repos under a shared root directory. Craig discovers child repos automatically and provisions a worktree for each when a project task is created. The agent runs once with access to all worktrees through a shared bundle root.

  The TUI left panel shows project workspaces with a `▦` icon and a `Repos (N)` summary. The Review inspector panel displays per-repo PR and check state for project tasks.

  Also fixes a workspace resolution bug where a stale `selectedWorkspaceId` could cause the TUI to display the wrong workspace when navigating between tasks.

## 0.3.1

### Patch Changes

- 3620dfb: Fix alternate-runner agent tabs so creating and attaching a second runner tab opens the live PTY instead of showing the attach prompt.

## 0.3.0

### Minor Changes

- f59cffe: TUI polish: full-width context-aware footer and panel navigation fixes

  The command bar is now a full-width footer spanning all three panels, showing keybinding hints that update based on which panel and mode is active. The review panel's "sync PR" and "close task" actions moved into the footer. Arrow keys no longer cross panel boundaries (use Tab/Shift-Tab), and Tab from the inspector panel no longer drops into an invisible focus region.

## 0.2.1

### Patch Changes

- 0554da4: Add package license metadata and update the README around TUI-first usage.

## 0.2.0

### Minor Changes

- 7320da7: Ship Craig as a minified Node CLI package.
