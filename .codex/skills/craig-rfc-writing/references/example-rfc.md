# Example RFC

Use this example as a style and specificity reference for Muscat RFCs. It is not a required template, but it shows the expected level of implementation detail, rollout planning, and concrete decision-making.

Source: user-provided example adapted from Loopr.

## Title

`RFC: Production Launch and BYO LLM Billing`

## Front matter pattern

- Date
- Status
- Author
- Relationship fields such as `Amends`, `Superseded RFCs`, or related RFC links when relevant

## Structural expectations shown by the example

- Start with concrete context and explicit goals.
- Name non-goals clearly to keep scope bounded.
- Make proposal sections decision-oriented rather than exploratory.
- Include concrete topology, dependency, and state-model decisions when the feature needs them.
- Keep rollout planning implementation-facing rather than aspirational.
- Make ownership boundaries explicit when introducing new domains or services.
- Spell out blocking conditions, runtime resolution rules, and validation flows when they affect shipping behavior.

## Example characteristics to emulate

- Concrete infrastructure and deployment decisions
- Explicit config and secret delivery model
- Clear domain ownership and dependency direction
- User-visible plan definition, not just system design
- Rollout slices that can be implemented and verified incrementally

## What not to cargo-cult

- Do not copy Loopr-specific domains, AWS choices, or billing assumptions into Muscat RFCs unless the Muscat feature actually needs them.
- Do not preserve the exact section depth from the example when the Muscat feature is smaller.
- Do not leave generic placeholders where the RFC should make a concrete call.
