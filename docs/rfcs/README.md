# RFCs

This folder contains Request For Comments (RFCs) and their final-state archives.
RFCs are implementation-facing design docs. They translate product intent into a concrete plan that can be implemented in Codex or Cursor plan-oriented sessions.

## Statuses and layout

- `docs/rfcs/` contains active RFCs only.
- `docs/rfcs/completed/` contains finished RFCs.
- `docs/rfcs/superseded/` contains RFCs that were replaced by newer RFCs.

Use these front matter status values:

- `In Flight` for active workstreams
- `Completed` for finished workstreams
- `Superseded` for replaced RFCs

`Completed` is a repo-and-owner judgment, not a strict checklist-backfill requirement. An RFC can be `Completed` even if its handoff checklist was not fully checked off retroactively.

Later RFCs may refine or supersede parts of an earlier completed RFC without making the earlier RFC active again. Use front matter relationship fields such as `Amends`, `Supersedes`, and `Superseded By` to preserve that history.

## Naming convention

- Format: `YYYY-MM-DD-rfc-<slug>.md`
- Slug rules:
  - lowercase
  - words separated by single hyphens
  - short and descriptive, usually 3-8 words
  - avoid punctuation

Examples:

- `2026-02-02-rfc-onboarding.md`
- `2026-03-15-rfc-report-delivery-scheduler.md`

## Recommended RFC structure

- Context and goals
- Non-goals
- Proposal
- Implementation tracker
- API and data model changes
- Edge cases and failure modes
- Security and privacy
- Observability
- Rollout plan
- Plan Mode handoff checklist and acceptance criteria

## Rollout plan conventions

Phases are vertical slices. Each phase should ship a complete user-facing capability end-to-end. Do not split backend-only and frontend-only phases unless there is a concrete reason to do so.

Phases may have numbered sub-phases such as `1.1` and `1.2` when a vertical slice is too large for one implementation session. Each sub-phase must be independently verifiable.

The Plan Mode handoff checklist is organized by sub-phase. Each sub-phase should have its own checklist that serves as the complete implementation spec for that session.

Each item in the final acceptance criteria section should be tagged with the sub-phase that delivers it, for example `[1.2]`.
