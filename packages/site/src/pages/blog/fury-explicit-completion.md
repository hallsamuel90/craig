---
layout: ../../layouts/Blog.astro
title: Introducing Craig Fury
description: An experimental preview of repeatable agent workflows, explicit completion, and human review—all inside Craig.
author: The Craig project
order: 1
---

<p class="text-xs uppercase tracking-widest"><strong>Experimental preview</strong></p>

# Introducing Craig Fury

Repeatable agent workflows, explicit completion, and human review—all inside Craig.

Fury is opt-in, not enabled by default. In Craig, go to **Options → Feature Previews → Agent orchestration**, then create or restart an agent tab. The [quickstart](/docs/fury-quickstart/) covers setup and a small workflow to try. Commands and state formats may change while this is experimental.

Running a few coding agents in parallel is one thing. Knowing when one has actually finished—and whether the next step should start—is a different problem.

A quiet terminal could mean the agent finished. It could also mean it is waiting for permission, stuck at a login prompt, or asking a question. Treating all of those as success makes a pretty fragile workflow.

Fury is an experimental part of Craig for defining repeatable agent workflows. You describe the steps in YAML, inspect and approve the resolved plan, then let Craig run it. The graph is fixed up front. This isn't an open-ended swarm inventing its own next steps.

## Start with something small

Take a repository documentation check:

1. Ask an agent to read the README and test configuration, without changing anything.
2. Have it return concrete findings as structured output.
3. Stop and let a human check the findings.

Nothing glamorous. But it gives us a useful contract: the inspection has an actual result, and accepting that result is a separate decision.

The [Fury quickstart](/docs/fury-quickstart/) includes the full YAML and commands for this workflow. It targets an existing Craig task, so you can watch the work happen in the same agent terminal you normally use.

## Completion is explicit

Fury gives each agent step a run-specific completion command. The agent reports success with `craig fury step complete`, or failure with `craig fury step fail`.

If a step declares an output schema, Craig validates the submitted JSON before dependent steps can proceed. In our example, the result must contain a `findings` array. That checks the shape, not the truth: a human still needs to look at the cited files.

The distinction matters. “Prompt delivered,” “agent stopped typing,” and “step completed with a valid result” are three different events.

## Review is a step, not a suggestion

The next step is a human-review checkpoint. The run waits there until a human approves, rejects, requests changes, or the deadline expires. The agent cannot approve its own checkpoint.

Approval of the original plan is separate from this review. You first approve what the workflow is allowed to do; later, you decide whether its result is acceptable.

Requesting changes sends feedback to the target agent. Resubmission adds a revised summary to the review history—it doesn't silently rewrite an already completed step's structured output. A workflow that needs a revised artifact should explicitly include another step to produce it.

## Still a preview

Fury is opt-in through the `agentOrchestration` feature preview. Commands and state formats can change. It uses workspace-local durable state, with the Craig daemon handling scheduling and reconciliation.

It is not a security sandbox. Git worktrees separate changes, not system permissions. Your runner still needs its own authentication, and its model usage follows that account's billing. Start with a small, trusted repository and bounded tasks.

The interesting part isn't “more agents.” It's making the handoffs explicit enough that you can tell what happened, what failed, and what is waiting on you.

[Try the walkthrough](/docs/fury-quickstart/) or read the [orchestration reference](/docs/orchestration/). If something gets stuck, report the Craig version, runner version, and redacted error—never credentials or capability tokens—in a [GitHub issue](https://github.com/hallsamuel90/craig/issues).
