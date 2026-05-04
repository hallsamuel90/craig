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

## Terminal harness

- Preserve the shell launcher UX as a testable contract, not an informal behavior.
- When changing task launch or PTY boot flows, keep harness coverage for both:
  - opening or attaching the selected task’s `agent` PTY and proving the Codex command started in the task worktree
  - creating a new task and proving the shell transitions directly into the new agent session without extra attach steps
- Prefer real-terminal E2E coverage in `tests/terminal-e2e.test.ts` for PTY bootstrap behavior, using a stub `codex` binary when needed to prove the agent command actually started in the expected cwd.
- If the create-task path is covered at the app-shell level instead of full real-terminal E2E, keep that contract explicit in `tests/ui-app-terminal.test.ts`.
