---
name: craig-rfc-writing
description: Draft or revise implementation-facing RFCs for the Craig repo. Use when Codex needs to create an RFC in docs/rfcs, turn product intent into a concrete implementation plan, or update an existing RFC to match this repo's naming, rollout, and handoff conventions.
---

# Craig RFC Writing

Read `docs/rfcs/README.md` before writing.

If you need an example of the desired tone or level of specificity, read `references/example-rfc.md`.

## Workflow

1. Infer the RFC scope from the user request and inspect any referenced docs, notes, or code.
2. Create or update an RFC in `docs/rfcs/` using the naming convention from the repo README.
3. Keep the RFC implementation-facing. Make concrete decisions instead of leaving broad options unless the user explicitly asks for options.
4. Unless the request clearly calls for a smaller edit, include an implementation tracker section that makes the RFC the source of truth for:
   - sub-phase implementation status
   - sub-phase verification status
   - the next resume point
   - any skipped or deferred phases
5. Include these sections unless the request clearly calls for a smaller edit:
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
6. Make rollout phases vertical slices. Do not split backend and frontend into separate phases unless the RFC explicitly justifies it.
7. If one phase is too large, use numbered sub-phases that are still independently verifiable.
8. Add a phase execution and verification policy that says in-scope evals must pass for a phase, covered end-to-end flows should run during tuning when applicable, and out-of-scope failures must be recorded explicitly.
9. Give each sub-phase its own handoff block with three subsections:
   - Implementation
   - Verification
   - Tracking update
10. In the tracker and rollout language, define explicit resume semantics: the next session resumes at the first phase that is not implemented, with skipped or deferred phases called out directly.
11. Tag final acceptance criteria with the sub-phase that delivers them, like `[1.2]`.
12. When the feature includes an AI interaction surface, make it ship early unless the request clearly argues for a later phase.

## Output expectations

When drafting a new RFC, write the file directly and summarize:
- the RFC path
- the main proposal
- any open questions or assumptions

When revising an existing RFC, preserve decisions that are still valid and call out substantive changes.
