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

- Publish only `craig-cli` from `packages/cli`; do not add platform packages or binary-only package targets.
- Build the npm artifact with `pnpm build:npm`, which must emit a minified esbuild bundle at `packages/cli/dist/cli.js` without source maps.
- Keep `packages/cli/package.json` on a strict `files` allowlist of `dist/cli.js`, `README.md`, and `package.json`.
- Do not publish source, declarations, tests, docs/RFCs, repo guidance, `.codex`, `.context`, `.craig`, `.github`, lockfiles, logs, env files, local state, source maps, or private workspace paths.
- Publishing is CI-only through Changesets. Do not publish locally and do not edit package versions manually.
- The release workflow applies Changesets, runs gates, commits version/changelog updates back to `main` with `[skip ci]`, and publishes to npm from the same merge-triggered run.
- Release gates must include `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm build:npm`, `pnpm package:audit`, and `pnpm package:smoke`.

## Terminal harness

- Preserve the shell launcher UX as a testable contract, not an informal behavior.
- When changing task launch or PTY boot flows, keep harness coverage for both:
  - opening or attaching the selected task’s `agent` PTY and proving the Codex command started in the task worktree
  - creating a new task and proving the shell transitions directly into the new agent session without extra attach steps
- Prefer real-terminal E2E coverage in `tests/terminal-e2e.test.ts` for PTY bootstrap behavior, using a stub `codex` binary when needed to prove the agent command actually started in the expected cwd.
- If the create-task path is covered at the app-shell level instead of full real-terminal E2E, keep that contract explicit in `tests/ui-app-terminal.test.ts`.
