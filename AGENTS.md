# Repo Guidance

## Skills

### Available repo-local skills

- `craig-rfc-writing`: Draft or revise implementation-facing RFCs for this repo. Source: `.codex/skills/craig-rfc-writing/`.

## How to use them

- Mention the skill explicitly in your prompt, for example: `Use $craig-rfc-writing to draft a new RFC for <feature>.`
- The skill reads `docs/rfcs/README.md` for this repo's RFC naming and rollout conventions.

## Source of truth

- `docs/rfcs/README.md`
- `.codex/skills/craig-rfc-writing/SKILL.md`

## Phase tracking

- When a session completes or verifies an RFC phase, update that RFC's tracker in the same change.
- Update all three tracker sections together: status summary, verification summary, and next resume point.

## Release packaging

- Add a Changeset for every user-visible `craig-cli` fix, feature, or behavior change before opening or updating a PR intended to ship; use `craig-cli` as the package name and choose `patch`, `minor`, or `major` according to the public CLI impact.
- Publish only `craig-cli` from `packages/cli`; do not add platform packages or binary-only package targets.
- Build the npm artifact with `pnpm build:npm`, which must emit a minified esbuild bundle at `packages/cli/dist/cli.js` without source maps.
- Keep `packages/cli/package.json` on a strict `files` allowlist of `dist/cli.js`, `README.md`, and `package.json`.
- Do not publish source, declarations, tests, docs/RFCs, repo guidance, `.codex`, `.context`, `.craig`, `.github`, lockfiles, logs, env files, local state, source maps, or private workspace paths.
- Publishing is CI-only through Changesets. Do not publish locally and do not edit package versions manually.
- The release workflow applies Changesets, runs gates, commits version/changelog updates back to `main` with `[skip ci]`, and publishes to npm from the same merge-triggered run.
- Release gates must include `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.

## Architecture

### Dependency direction
`input/ → shell/ → domain/` — the domain layer has zero UI knowledge. Never import from a higher layer into a lower one. The one crossing exception is `domain/task/` importing `RepoRecord` from `domain/workspace/` (tasks need repo context); this is acceptable intra-domain coupling.

### Result types belong in the domain
Command result types (e.g. `CommandCreateTaskResult`, `TaskInspection`) live in the domain layer that owns them — `domain/task/types.ts` for task results, `domain/workspace/types.ts` for workspace results. The `commands/` layer imports from domain, not the other way around.

### State vs. reducer separation
- `src/ui/state.ts` owns: type definitions, constants, state initialization (`createInitialShellState`), state restoration (`restoreShellState`), and small utility predicates (`isEnterKey`, `isPrintableKey`, `isLegacyPtySurface`, etc.).
- `src/ui/input/reducer.ts` owns: all key-reduction logic — `reduceMainKey`, `reduceFileSearchKey`, `scrollInspectionContent`, and their private helpers.
- `src/ui/shell/loader.ts` re-exports `getLeftItemIds` from `state.ts`; do not define it again.

### No duplicate navigation functions
`getLeftItemIds` has a single definition in `src/ui/state.ts` (exported). If you need it in a shell module, import from `state.ts` and re-export — do not copy the body.

## Terminal harness

- Preserve the shell launcher UX as a testable contract, not an informal behavior.
- When changing task launch or PTY boot flows, keep harness coverage for both:
  - opening or attaching the selected task’s `agent` PTY and proving the Codex command started in the task worktree
  - creating a new task and proving the shell transitions directly into the new agent session without extra attach steps
- Prefer real-terminal E2E coverage in `tests/terminal-e2e.test.ts` for PTY bootstrap behavior, using a stub `codex` binary when needed to prove the agent command actually started in the expected cwd.
- If the create-task path is covered at the app-shell level instead of full real-terminal E2E, keep that contract explicit in `tests/ui-app-terminal.test.ts`.
