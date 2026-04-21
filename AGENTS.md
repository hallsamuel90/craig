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
