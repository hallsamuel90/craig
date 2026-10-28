---
layout: ../../layouts/Docs.astro
title: Fury quickstart
description: Run a small, read-only agent workflow with explicit completion and a human-review checkpoint.
---

<div class="max-w-3xl mx-auto px-6 sm:px-10 prose">

# Your first Fury workflow

Fury is Craig's experimental workflow runner. This example asks an agent to inspect a repository's documentation, return structured findings, and stop for your review. It does not authorize code changes or publishing.

## 1. Prepare a workspace

You need Node.js 22+, Git, and an installed, authenticated coding-agent CLI. The commands below use Codex. Model usage follows your runner's account and billing; Craig does not supply a model.

```sh
npm install -g craig-cli@0.19.3
cd /path/to/your/scratch-workspace
craig workspace add /path/to/a/trusted/repo --json
```

Use a trusted, non-sensitive repository. Worktrees isolate Git changes, **not permissions or network access**. The read-only prompt is an instruction, not a sandbox policy.

Merge this setting into the workspace's `.craig/config.json`, preserving your existing configuration:

```json
{
  "previews": {
    "agentOrchestration": true
  }
}
```

From this workspace, run `craig`, select the repository workspace, and create a task named “Repository documentation check” with the Codex runner. Let its agent finish any trust or sign-in prompts. If the agent was already running when you enabled the preview, restart its agent tab so it receives a capability.

Leave Craig running. In a **separate, ordinary terminal**, return to the scratch-workspace directory and run:

```sh
craig task list --json
```

Copy the new task's ID. All subsequent commands run from this workspace root, not from inside another Craig agent session. Do not ask an agent to approve its own plan or checkpoint.

## 2. Save and inspect the workflow

Download the [complete example YAML](/examples/inspect-and-review.yaml), save it as `.craig/fury/inspect-and-review.yaml`, and read it before proceeding. Create the `fury` directory if it does not exist.

The definition has two steps: `inspect` targets your existing task and declares a `findings` output schema; `review` depends on `inspect` and waits for a human. Its overall deadline is 30 minutes and its review deadline is 15 minutes. Start with a small repository so the agent can finish within those limits.

```sh
craig fury validate .craig/fury/inspect-and-review.yaml --json
craig fury plan .craig/fury/inspect-and-review.yaml --root-task TASK_ID --input task_id=TASK_ID --json
```

Replace both occurrences of `TASK_ID` with the task ID you copied. JSON responses wrap results in `data`; the plan ID is `data.plan.id`. Inspect the resolved steps, target task, limits, and `data.plan.planHash`. Planning does not execute the workflow.

## 3. Approve the exact plan and start it

Only proceed if the plan matches what you want to run. As the human operator, in your ordinary terminal:

```sh
craig fury approve PLAN_ID --json
craig fury run PLAN_ID --json
```

Replace `PLAN_ID` with the returned ID. Starting a run returns `data.run.id`; copy it as `RUN_ID`. The daemon schedules work asynchronously, so an initial `pending` response is normal. Keep Craig open and watch the agent receive its instructions.

```sh
craig fury status RUN_ID --json
craig fury watch RUN_ID --format jsonl
```

`watch` streams until interrupted; use Ctrl+C to return to your prompt. It observes the run, rather than scheduling work. Editing YAML after planning does not change the approved plan: validate and plan again if you need different instructions.

## 4. Confirm explicit completion

Fury appends run-specific completion and failure commands to the agent's prompt. The agent must report its actual result; terminal silence or a conversational “done” does not complete a step.

For this example, the completion command has this shape, with the real run ID and actual findings supplied by the agent:

```sh
craig fury step complete --run RUN_ID --step inspect --output '{"findings":[]}' --json
```

The empty array is valid **only if the agent found no concrete gaps**. Do not submit it manually just to move the run forward. If the work fails, the agent should report the reason instead:

```sh
craig fury step fail --run RUN_ID --step inspect --reason 'Describe the actual failure' --json
```

After valid completion, status should show `data.run.stepRuns.inspect.state` as `succeeded` and the run as `waiting_for_review` once the daemon reconciles it. Inspect `data.run.stepRuns.inspect.output.findings` and check the cited files yourself. A schema-valid output is not a guarantee that the findings are correct.

## 5. Make the human review decision

```sh
craig fury reviews list --run RUN_ID --json
craig fury review show REVIEW_ID --json
```

Copy `REVIEW_ID` from `data.reviews` in the list response. In your ordinary terminal, choose **one** decision:

```sh
craig fury review approve REVIEW_ID --note 'I checked the findings against the repository' --json
```

Or reject the result:

```sh
craig fury review reject REVIEW_ID --reason 'Explain why the result is not acceptable' --json
```

Or send feedback back to the agent:

```sh
craig fury review request-changes REVIEW_ID --reason 'Explain what needs clarification' --json
```

Feedback includes a resubmission command for the agent. Resubmission records a revised summary; it does **not** overwrite the completed step's structured output. If you need a new structured artifact, define an explicit follow-on step or create a new plan.

After approval, check `craig fury status RUN_ID --json` again: this two-step run should become `succeeded`. Rejection makes it `failed`. Success here means the inspection and human review completed—not that code was changed, tests passed, or a PR was merged.

## Recovery and stopping

- If a trust, login, or update dialog blocks delivery, resolve it in the actual agent terminal. A delivered prompt only means the PTY accepted input, not that the agent completed it.
- If Craig reports saved state but an unavailable supervisor, reopen Craig for this same workspace and run `craig fury resume RUN_ID --json`. Do not create duplicate plans or workers to retry the same work.
- Use `craig fury cancel RUN_ID --json` to stop the workflow. Inspect `cleanupPending` and `cleanupError` until cleanup finishes. Cancellation does not terminate an existing target task; this example uses an existing task, not a new child.
- If the review expires, the run cannot be approved into success. Inspect the outcome and create a new plan when ready.

See the [orchestration reference](/docs/orchestration/) for capabilities, child tasks, and durable events, or the [CLI reference](/docs/cli/) for all command options.

</div>
