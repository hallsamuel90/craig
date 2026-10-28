import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { configService } from "../domain/config/index.js";
import { CraigError } from "../domain/error/index.js";
import {
  appendEvent,
  approveFuryPlan,
  authorizeCapability,
  createFuryPlan,
  createFuryRun,
  furyDirs,
  hashFuryPlan,
  listEvents,
  listPromptCommands,
  listFuryReviews,
  listFuryRuns,
  mutateFuryReview,
  mutateFuryRun,
  persistFuryDefinition,
  planFuryFile,
  promptCommandService,
  readFuryApproval,
  readFuryPlan,
  readFuryReview,
  readFuryRun,
  writeFuryReview,
  ensureTaskCapabilities,
  type CommandActFuryReviewResult,
  type CommandApproveFuryResult,
  type CommandCancelFuryResult,
  type CommandListFuryReviewsResult,
  type CommandPlanFuryResult,
  type CommandResumeFuryResult,
  type CommandRunFuryResult,
  type CommandShowFuryResult,
  type CommandShowFuryReviewResult,
  type CommandStepFuryResult,
  type CommandWatchFuryResult,
  type CraigActor,
  type HumanReviewCheckpoint,
  type FuryPlanStep,
  type FuryPlan,
  type FuryReviewAction,
  type FuryRun,
  type FuryStepRun,
} from "../domain/orchestration/index.js";
import { taskService } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { cancelTaskTreeAndSessions, createChildTaskAndSession } from "./delegation.js";
import { wakeOrchestrationSupervisor } from "./pty-daemon-orchestration.js";

const SYSTEM_ACTOR = { type: "system" as const, component: "orchestration-supervisor" as const };
const STEP_REFERENCE = /\$\{\{\s*steps\.([a-z][a-z0-9_-]{0,63})\.(task_id|output(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
interface FuryReconcileOptions {
  /* eslint-disable-next-line no-unused-vars */
  isAgentAvailable?: (tabId: string) => boolean;
  allowScheduling?: boolean;
}

export async function createPlan(
  paths: CraigPaths,
  file: string,
  inputs: Record<string, string>,
  rootTaskId: string,
  actor: CraigActor,
  capabilityToken?: string,
): Promise<CommandPlanFuryResult> {
  await assertEnabled(paths);
  const sourceFile = await assertFurySourcePath(paths, file);
  await taskService.getTask(paths, rootTaskId);
  if (actor.type === "agent") {
    if (!capabilityToken || actor.taskId !== rootTaskId) {
      throw new CraigError("CAPABILITY_DENIED", "An agent may only plan Fury work rooted at its own task.", {});
    }
    await authorizeCapability(paths, capabilityToken, "fury.plan", rootTaskId);
  }
  const spec = await planFuryFile(file, inputs);
  assertPlanTargetsRoot(spec.steps, rootTaskId);
  const createdAt = new Date().toISOString();
  const hashable = {
    schemaVersion: 1 as const,
    definitionHash: spec.definitionHash,
    name: spec.name,
    sourceFile,
    rootTaskId,
    inputs: spec.inputs,
    limits: spec.limits,
    order: spec.order,
    waves: spec.waves,
    steps: spec.steps,
  };
  const plan: FuryPlan = {
    ...hashable,
    id: `fury_plan_${randomUUID()}`,
    planHash: hashFuryPlan(hashable),
    createdBy: actor,
    createdAt,
  };
  await persistFuryDefinition(paths, spec.definitionHash, await readFile(file, "utf8"));
  const persistedPlan = await createFuryPlan(paths, plan);
  try {
    await appendEvent(paths, {
      id: `${persistedPlan.id}:fury.plan.created`, taskId: rootTaskId, type: "fury.plan.created",
      occurredAt: persistedPlan.createdAt, actor: persistedPlan.createdBy,
      data: { planId: persistedPlan.id, planHash: persistedPlan.planHash, name: persistedPlan.name },
    });
  } catch (error) {
    throw new CraigError("PARTIAL_RESULT", `Fury plan ${persistedPlan.id} was persisted, but its audit event could not be recorded.`, {
      details: { planId: persistedPlan.id, planHash: persistedPlan.planHash, persisted: true }, cause: error,
    });
  }
  return { kind: "planFury", plan: persistedPlan };
}

export async function approvePlan(
  paths: CraigPaths,
  planId: string,
  actor: CraigActor,
): Promise<CommandApproveFuryResult> {
  await assertEnabled(paths);
  if (actor.type !== "human") throw new CraigError("CAPABILITY_DENIED", "Only a human can approve a Fury plan.", {});
  const plan = await readFuryPlan(paths, planId);
  const requested = {
    schemaVersion: 1 as const, planId: plan.id, planHash: plan.planHash,
    approvedBy: actor, approvedAt: new Date().toISOString(),
  };
  const result = await approveFuryPlan(paths, requested);
  try {
    await appendEvent(paths, {
      id: `${plan.id}:fury.plan.approved`, taskId: plan.rootTaskId, type: "fury.plan.approved",
      occurredAt: result.approval.approvedAt, actor: result.approval.approvedBy,
      data: { planId: plan.id, planHash: plan.planHash },
    });
  } catch (error) {
    throw new CraigError("PARTIAL_RESULT", `Fury plan ${plan.id} was approved, but its audit event could not be recorded.`, {
      details: { planId: plan.id, planHash: plan.planHash, persisted: true, approved: true }, cause: error,
    });
  }
  return { kind: "approveFury", plan, approval: result.approval, created: result.created };
}

export async function runFury(
  paths: CraigPaths,
  planId: string,
  actor: CraigActor,
  capabilityToken?: string,
): Promise<CommandRunFuryResult> {
  await assertEnabled(paths);
  const plan = await readFuryPlan(paths, planId);
  const approval = await readFuryApproval(paths, planId);
  if (approval.planHash !== plan.planHash) {
    throw new CraigError("FURY_APPROVAL_REQUIRED", `Fury plan ${planId} changed after approval.`, {});
  }
  if (actor.type === "agent") {
    if (!capabilityToken) throw new CraigError("CAPABILITY_DENIED", "Fury run requires an agent capability.", {});
    await authorizeCapability(paths, capabilityToken, "fury.run", plan.rootTaskId);
  }
  await ensureTaskCapabilities(paths, await taskService.getTask(paths, plan.rootTaskId));
  const now = new Date();
  const runId = `fury_${randomUUID()}`;
  const run: FuryRun = {
    schemaVersion: 1,
    id: runId,
    planId: plan.id,
    planHash: plan.planHash,
    definitionHash: plan.definitionHash,
    name: plan.name,
    sourceFile: plan.sourceFile,
    rootTaskId: plan.rootTaskId,
    state: "pending",
    inputs: plan.inputs,
    limits: plan.limits,
    order: plan.order,
    stepRuns: Object.fromEntries(plan.steps.map((step): [string, FuryStepRun] => [step.id, {
      id: step.id, kind: step.kind, needs: step.needs, state: "pending", plan: step,
      taskId: null, agentTabId: null, commandId: null, reviewId: null, output: null, error: null,
      startedAt: null, completedAt: null, deadlineAt: null,
      completedBy: null,
    }])),
    actor,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    stateChangedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + plan.limits.timeoutMs).toISOString(),
    completedAt: null,
  };
  const persisted = await createFuryRun(paths, run);
  try {
    await event(paths, persisted.run, null, "fury.run.created", persisted.run.actor, { state: "pending" });
  } catch (error) {
    throw new CraigError("PARTIAL_RESULT", `Fury run ${persisted.run.id} was persisted, but its audit event could not be recorded.`, {
      details: { runId: persisted.run.id, planId: persisted.run.planId, persisted: true }, cause: error,
    });
  }
  if (!isTerminalRun(persisted.run)) await requireFuryWake(paths, persisted.run.id);
  return { kind: "runFury", run: await readFuryRun(paths, persisted.run.id), created: persisted.created };
}

export async function showFury(paths: CraigPaths, runId: string): Promise<CommandShowFuryResult> {
  return { kind: "showFury", run: await readFuryRun(paths, runId) };
}

export async function reconcileFuryRuns(
  paths: CraigPaths,
  options: FuryReconcileOptions = {},
): Promise<void> {
  const config = await configService.load(paths);
  const allowScheduling = configService.previews.isEnabled(config, "agentOrchestration");
  for (const run of await listFuryRuns(paths)) {
    await reconcileFuryRun(paths, run.id, { ...options, allowScheduling });
  }
}

export async function reconcileFuryRun(
  paths: CraigPaths,
  runId: string,
  options: FuryReconcileOptions = {},
): Promise<void> {
  const allowScheduling = options.allowScheduling ?? configService.previews.isEnabled(await configService.load(paths), "agentOrchestration");
  let run = await readFuryRun(paths, runId);
  await reconcileFuryAudit(paths, run);
  if (isTerminalRun(run)) {
    if (run.cleanupPending) await cleanupFuryRun(paths, run);
    return;
  }
  run = await reconcileReviewDecisions(paths, run);
  await reconcileReviewFeedback(paths, run);
  if (Date.now() >= Date.parse(run.deadlineAt)) {
    run = await mutateFuryRun(paths, runId, (current) => isTerminalRun(current) ? current : finishTimedOut(current));
    if (run.state !== "timed_out") return;
    for (const step of Object.values(run.stepRuns)) {
      if (!step.reviewId) continue;
      await mutateFuryReview(paths, step.reviewId, (review) =>
        ["waiting_for_review", "changes_requested"].includes(review.state)
          ? { ...review, state: "timed_out", version: review.version + 1, updatedAt: new Date().toISOString() }
          : review);
    }
    await event(paths, run, null, "fury.run.timed_out", SYSTEM_ACTOR, { state: run.state });
    return;
  }

  const commands = new Map((await listPromptCommands(paths)).map((command) => [command.id, command]));
  for (const stepId of run.order) {
    const step = run.stepRuns[stepId]!;
    if (allowScheduling && step.state === "running" && !step.taskId) {
      run = await scheduleAgentStep(paths, run, step);
      continue;
    }
    if (step.state === "running" && step.commandId && commands.get(step.commandId)?.state === "failed") {
      run = await failStepRecord(paths, run.id, step.id, commands.get(step.commandId)?.lastError?.message ?? "Prompt delivery failed.", SYSTEM_ACTOR);
    }
    const commandDelivered = !step.commandId || commands.get(step.commandId)?.state === "delivered";
    if (
      step.state === "running" && step.agentTabId && commandDelivered && options.isAgentAvailable &&
      step.startedAt && Date.now() - Date.parse(step.startedAt) > 2_000 && !options.isAgentAvailable(step.agentTabId)
    ) {
      run = await failStepRecord(paths, run.id, step.id, `Agent session ${step.agentTabId} disappeared.`, SYSTEM_ACTOR);
    }
    if (step.state === "running" && step.deadlineAt && Date.now() >= Date.parse(step.deadlineAt)) {
      run = await mutateFuryRun(paths, run.id, (current) => isTerminalRun(current) ? current : updateStep(current, step.id, {
        state: "timed_out", error: "Step timed out.", completedAt: new Date().toISOString(), completedBy: SYSTEM_ACTOR,
      }));
      if (run.stepRuns[step.id]?.state === "timed_out") await event(paths, run, step.id, "fury.step.timed_out", SYSTEM_ACTOR, {});
    }
    if ((step.state === "waiting_for_review" || step.state === "changes_requested") && step.deadlineAt && Date.now() >= Date.parse(step.deadlineAt)) {
      if (step.reviewId) {
        await mutateFuryReview(paths, step.reviewId, (review) => ({
          ...review, state: "timed_out", version: review.version + 1, updatedAt: new Date().toISOString(),
        }));
      }
      run = await mutateFuryRun(paths, run.id, (current) => isTerminalRun(current) ? current : updateStep(current, step.id, {
        state: "timed_out", error: "Review timed out.", completedAt: new Date().toISOString(), completedBy: SYSTEM_ACTOR,
      }));
      if (run.stepRuns[step.id]?.state === "timed_out") await event(paths, run, step.id, "fury.review.timed_out", SYSTEM_ACTOR, { reviewId: step.reviewId });
    }
  }
  if (Object.values(run.stepRuns).some((step) => step.state === "failed" || step.state === "timed_out")) {
    await setRunState(paths, run.id, "failed", SYSTEM_ACTOR);
    return;
  }

  let active = Object.values(run.stepRuns).filter((step) => step.state === "running").length;
  for (const stepId of run.order) {
    if (active >= run.limits.maxConcurrency) break;
    const step = run.stepRuns[stepId]!;
    if (step.state !== "pending" || !step.needs.every((id) => run.stepRuns[id]?.state === "succeeded")) continue;
    if (step.kind === "human_review") {
      run = await openReview(paths, run, step);
    } else if (allowScheduling) {
      run = await scheduleAgentStep(paths, run, step);
      active += 1;
    }
  }
  await refreshRunState(paths, run.id);
}

async function scheduleAgentStep(paths: CraigPaths, run: FuryRun, step: FuryStepRun): Promise<FuryRun> {
  const now = new Date();
  run = await mutateFuryRun(paths, run.id, (current) => isTerminalRun(current) ? current : updateStep(current, step.id, {
    state: "running", startedAt: current.stepRuns[step.id]?.startedAt ?? now.toISOString(), deadlineAt: current.deadlineAt,
  }));
  if (isTerminalRun(run)) return run;
  await event(paths, run, step.id, "fury.step.started", SYSTEM_ACTOR, {});
  const current = run.stepRuns[step.id]!;
  if (current.taskId) return run;
  try {
    const prompt = `${resolveReferences(current.plan.prompt!, run)}\n\n${completionInstructions(run.id, step.id, current.plan.outputSchema)}`;
    let taskId: string;
    let agentTabId: string;
    let commandId: string | null = null;
    if (current.plan.target?.type === "create_child") {
      const created = await createChildTaskAndSession(paths, {
        parentTaskId: run.rootTaskId,
        ...(current.plan.target.repo
          ? { repoId: resolveReferences(current.plan.target.repo, run) }
          : {}),
        ...(current.plan.target.workspace
          ? { workspaceId: resolveReferences(current.plan.target.workspace, run) }
          : {}),
        prompt,
        ...(current.plan.runner ? { runner: current.plan.runner } : {}),
        idempotencyKey: `fury:${run.id}:${step.id}`,
        fury: { runId: run.id, stepId: step.id },
      });
      const task = await taskService.getTask(paths, created.taskId);
      const tab = task.ptyTabs.find((candidate) => candidate.kind === "agent");
      if (!tab) throw new CraigError("TASK_CONTEXT_CONFLICT", `Created task ${task.id} has no agent tab.`, {});
      taskId = task.id;
      agentTabId = tab.id;
      commandId = (await listPromptCommands(paths)).find((command) => command.idempotencyKey === `task-start:${task.id}`)?.id ?? null;
    } else {
      taskId = resolveReferences(current.plan.target!.task, run);
      const task = await taskService.getTask(paths, taskId);
      const tab = task.ptyTabs.find((candidate) =>
        candidate.kind === "agent" && (!current.plan.runner || (candidate.runner ?? task.runner) === current.plan.runner));
      if (!tab) {
        throw new CraigError(
          "TASK_CONTEXT_CONFLICT",
          current.plan.runner
            ? `Task ${task.id} has no ${current.plan.runner} agent tab for fury step ${step.id}.`
            : `Task ${task.id} has no agent tab.`,
          {},
        );
      }
      await ensureTaskCapabilities(paths, task, SYSTEM_ACTOR, tab.id);
      agentTabId = tab.id;
      const dispatched = await promptCommandService.create(paths, {
        taskId, agentTabId, prompt: { source: "inline", text: prompt }, delivery: "when-ready",
        timeoutMs: Math.min(run.limits.timeoutMs, 86_400_000),
        idempotencyKey: `fury:${run.id}:${step.id}`,
        actor: SYSTEM_ACTOR,
      });
      commandId = dispatched.command.id;
    }
    run = await mutateFuryRun(paths, run.id, (record) => isTerminalRun(record)
      ? { ...record, cleanupPending: true }
      : updateStep(record, step.id, { taskId, agentTabId, commandId }));
    if (isTerminalRun(run)) return run;
    await event(paths, run, step.id, "fury.step.dispatched", SYSTEM_ACTOR, { taskId, agentTabId, commandId });
    return run;
  } catch (error) {
    const latest = await readFuryRun(paths, run.id);
    if (isTerminalRun(latest)) return latest;
    return failStepRecord(paths, run.id, step.id, error instanceof Error ? error.message : "Step dispatch failed.", SYSTEM_ACTOR);
  }
}

async function openReview(paths: CraigPaths, run: FuryRun, step: FuryStepRun): Promise<FuryRun> {
  const spec = step.plan.review!;
  const now = new Date();
  const reviewId = `review_${run.id.slice("fury_".length)}_${step.id}`;
  const feedbackTask = spec.feedbackTask ? resolveReferences(spec.feedbackTask, run) : null;
  const feedbackStep = feedbackTask
    ? Object.values(run.stepRuns).find((candidate) => candidate.taskId === feedbackTask && candidate.agentTabId)
    : null;
  const existing = await readFuryReview(paths, reviewId).catch((error: unknown) => {
    if (error instanceof CraigError && error.code === "FURY_REVIEW_NOT_FOUND") return null;
    throw error;
  });
  const review: HumanReviewCheckpoint = existing ?? {
    schemaVersion: 1, id: reviewId, runId: run.id, stepId: step.id, state: "waiting_for_review",
    title: resolveReferences(spec.title, run), summary: resolveReferences(spec.summary, run),
    feedbackTarget: feedbackTask ? { taskId: feedbackTask, agentTabId: feedbackStep?.agentTabId ?? null } : null,
    round: 1, requestedAt: now.toISOString(),
    deadlineAt: new Date(Math.min(Date.parse(run.deadlineAt), now.getTime() + spec.timeoutMs)).toISOString(),
    version: 1, lastDecision: null, history: [], updatedAt: now.toISOString(),
  };
  if (!existing) await writeFuryReview(paths, review);
  run = await mutateFuryRun(paths, run.id, (record) => isTerminalRun(record)
    ? { ...record, cleanupPending: true }
    : updateStep(record, step.id, {
      state: "waiting_for_review", reviewId, startedAt: review.requestedAt, deadlineAt: review.deadlineAt,
    }));
  if (isTerminalRun(run)) return run;
  await event(paths, run, step.id, "fury.review.requested", SYSTEM_ACTOR, { reviewId, title: review.title });
  return run;
}

export async function completeFuryStep(
  paths: CraigPaths, runId: string, stepId: string, output: unknown, actor: CraigActor, capabilityToken?: string,
): Promise<CommandStepFuryResult> {
  let run = await readFuryRun(paths, runId);
  const step = requireRunningAgentStep(run, stepId);
  await authorizeStepActor(paths, step, actor, capabilityToken, "fury.step.complete");
  validateOutput(output, step.plan.outputSchema);
  const now = new Date().toISOString();
  run = await mutateFuryRun(paths, runId, (current) => {
    if (isTerminalRun(current) || current.stepRuns[stepId]?.state !== "running" || Date.now() >= Date.parse(current.deadlineAt)) {
      throw new CraigError("FURY_STATE_CONFLICT", `Step ${stepId} is no longer running or its deadline has elapsed.`, {});
    }
    return updateStep(current, stepId, { state: "succeeded", output, completedAt: now, completedBy: actor });
  });
  await event(paths, run, stepId, "fury.step.succeeded", actor, { taskId: step.taskId });
  await requireFuryWake(paths, runId);
  run = await readFuryRun(paths, runId);
  return { kind: "completeFuryStep", run, step: run.stepRuns[stepId]! };
}

export async function failFuryStep(
  paths: CraigPaths, runId: string, stepId: string, reason: string, actor: CraigActor, capabilityToken?: string,
): Promise<CommandStepFuryResult> {
  const run = await readFuryRun(paths, runId);
  const step = requireRunningAgentStep(run, stepId);
  await authorizeStepActor(paths, step, actor, capabilityToken, "fury.step.fail");
  const failed = await failStepRecord(paths, runId, stepId, reason, actor);
  await setRunState(paths, runId, "failed", actor);
  await requireFuryWake(paths, runId);
  return { kind: "failFuryStep", run: await readFuryRun(paths, runId), step: failed.stepRuns[stepId]! };
}

export async function cancelFury(
  paths: CraigPaths, runId: string, actor: CraigActor, capabilityToken?: string,
): Promise<CommandCancelFuryResult> {
  const before = await readFuryRun(paths, runId);
  if (actor.type === "agent") {
    if (!capabilityToken) throw new CraigError("CAPABILITY_DENIED", "Fury cancellation requires an agent capability.", {});
    await authorizeCapability(paths, capabilityToken, "fury.cancel", before.rootTaskId);
  }
  if (isTerminalRun(before)) {
    if (before.cleanupPending) await requireFuryWake(paths, runId);
    return { kind: "cancelFury", run: await readFuryRun(paths, runId), changed: false };
  }
  const now = new Date().toISOString();
  let changed = false;
  const run = await mutateFuryRun(paths, runId, (current) => {
    if (isTerminalRun(current)) return current;
    changed = true;
    return {
      ...current, state: "cancelled" as const, cleanupPending: true, cleanupError: null, completedAt: now, updatedAt: now, stateChangedAt: now,
      stepRuns: Object.fromEntries(Object.entries(current.stepRuns).map(([id, step]) => [id,
        step.state === "succeeded" ? step : { ...step, state: "cancelled", completedAt: now, completedBy: actor },
      ])),
    };
  });
  if (!changed) return { kind: "cancelFury", run, changed: false };
  await event(paths, run, null, "fury.run.cancelled", actor, {});
  await requireFuryWake(paths, runId);
  return { kind: "cancelFury", run: await readFuryRun(paths, runId), changed };
}

export async function resumeFury(
  paths: CraigPaths, runId: string, actor: CraigActor, capabilityToken?: string,
): Promise<CommandResumeFuryResult> {
  const run = await readFuryRun(paths, runId);
  if (actor.type === "agent") {
    if (!capabilityToken) throw new CraigError("CAPABILITY_DENIED", "Fury resume requires an agent capability.", {});
    await authorizeCapability(paths, capabilityToken, "fury.resume", run.rootTaskId);
  }
  if (isTerminalRun(run)) throw new CraigError("FURY_STATE_CONFLICT", `Cannot resume ${run.id} while it is ${run.state}.`, {});
  await requireFuryWake(paths, runId);
  return { kind: "resumeFury", run: await readFuryRun(paths, runId) };
}

export async function listReviews(paths: CraigPaths, runId?: string, state?: string): Promise<CommandListFuryReviewsResult> {
  const reviews = (await listFuryReviews(paths)).filter((review) => (!runId || review.runId === runId) && (!state || review.state === state));
  return { kind: "listFuryReviews", reviews };
}
export async function showReview(paths: CraigPaths, id: string): Promise<CommandShowFuryReviewResult> {
  return { kind: "showFuryReview", review: await readFuryReview(paths, id) };
}

export async function actOnReview(
  paths: CraigPaths, id: string, action: FuryReviewAction, message: string | null, actor: CraigActor, capabilityToken?: string,
): Promise<CommandActFuryReviewResult> {
  let review = await readFuryReview(paths, id);
  let run = await readFuryRun(paths, review.runId);
  if (action !== "resubmit" && actor.type !== "human") throw new CraigError("CAPABILITY_DENIED", "Only a human can decide a fury review.", {});
  if (action === "resubmit" && actor.type !== "human" && actor.type !== "agent") {
    throw new CraigError("CAPABILITY_DENIED", "Only a human or the feedback-target agent can resubmit a review.", {});
  }
  if (action === "resubmit" && actor.type === "agent") {
    if (!review.feedbackTarget || actor.taskId !== review.feedbackTarget.taskId || !capabilityToken) {
      throw new CraigError("CAPABILITY_DENIED", "Only the feedback-target agent can resubmit this review.", {});
    }
    await authorizeCapability(paths, capabilityToken, "fury.review.resubmit", actor.taskId);
  }
  if (isTerminalRun(run) || Date.now() >= Math.min(Date.parse(run.deadlineAt), Date.parse(review.deadlineAt))) {
    throw new CraigError("FURY_STATE_CONFLICT", `Review ${id} belongs to a terminal or expired run.`, {});
  }
  const allowed = action === "resubmit" ? review.state === "changes_requested" : review.state === "waiting_for_review";
  if (!allowed) throw new CraigError("FURY_STATE_CONFLICT", `Review ${id} cannot ${action} while ${review.state}.`, {});
  if ((action === "reject" || action === "request_changes") && !message?.trim()) throw new CraigError("CLI_USAGE", `${action} requires a reason.`, {});
  if (action === "request_changes" && !review.feedbackTarget) throw new CraigError("FURY_STATE_CONFLICT", `Review ${id} has no feedback target.`, {});
  const feedbackCommandId: string | null = null;
  if (action === "request_changes") {
    const task = await taskService.getTask(paths, review.feedbackTarget!.taskId);
    const tab = review.feedbackTarget!.agentTabId
      ? task.ptyTabs.find((candidate) => candidate.kind === "agent" && candidate.id === review.feedbackTarget!.agentTabId)
      : task.ptyTabs.find((candidate) => candidate.kind === "agent");
    if (!tab) throw new CraigError("TASK_CONTEXT_CONFLICT", `Feedback task ${task.id} has no agent tab.`, {});
  }
  const now = new Date().toISOString();
  const decision = { sequence: review.history.length + 1, round: review.round, action, message, actor, feedbackCommandId, occurredAt: now };
  const nextState = action === "approve" ? "approved" : action === "reject" ? "rejected" : action === "request_changes" ? "changes_requested" : "waiting_for_review";
  review = await mutateFuryReview(paths, id, (current) => {
    const stillAllowed = action === "resubmit" ? current.state === "changes_requested" : current.state === "waiting_for_review";
    if (!stillAllowed || current.version !== review.version || Date.now() >= Math.min(Date.parse(run.deadlineAt), Date.parse(current.deadlineAt))) {
      throw new CraigError("FURY_STATE_CONFLICT", `Review ${id} changed concurrently.`, {});
    }
    return { ...current, state: nextState, round: action === "resubmit" ? current.round + 1 : current.round,
      version: current.version + 1, lastDecision: decision, history: [...current.history, decision], updatedAt: now };
  });
  run = await mutateFuryRun(paths, run.id, (current) => {
    if (isTerminalRun(current)) throw new CraigError("FURY_STATE_CONFLICT", `Run ${current.id} is ${current.state}.`, {});
    return updateStep(current, review.stepId, action === "approve"
      ? { state: "succeeded", completedAt: now, completedBy: actor }
      : action === "reject" ? { state: "failed", error: message, completedAt: now, completedBy: actor }
        : action === "request_changes" ? { state: "changes_requested" }
          : { state: "waiting_for_review" });
  });
  await event(paths, run, review.stepId, `fury.review.${action}`, actor, { reviewId: id, round: review.round, feedbackCommandId });
  if (action === "reject") await setRunState(paths, run.id, "failed", actor);
  await requireFuryWake(paths, run.id);
  return { kind: "actFuryReview", review, run: await readFuryRun(paths, run.id) };
}

export async function watchFury(
  paths: CraigPaths, runId: string, after: string | undefined,
  options: {
    signal?: AbortSignal;
    /* eslint-disable-next-line no-unused-vars */
    onEvent(event: Awaited<ReturnType<typeof listEvents>>["events"][number]): void;
  },
): Promise<CommandWatchFuryResult> {
  await readFuryRun(paths, runId);
  let cursor = after;
  let count = 0;
  let lastSequence = 0;
  while (!options.signal?.aborted) {
    const result = await listEvents(paths, { typeGlob: "fury.*", ...(cursor ? { after: cursor } : {}) });
    for (const item of result.events.filter((event) => event.furyRunId === runId)) { options.onEvent(item); count += 1; }
    cursor = result.cursor.after ?? cursor;
    lastSequence = result.cursor.sequence;
    if (isTerminalRun(await readFuryRun(paths, runId))) {
      return { kind: "watchFury", eventCount: count, lastSequence, cancelled: false };
    }
    await wait(250, options.signal);
  }
  return { kind: "watchFury", eventCount: count, lastSequence, cancelled: true };
}

function resolveReferences(value: string, run: FuryRun): string {
  return value.replace(STEP_REFERENCE, (_match, stepId: string, field: string) => {
    const step = run.stepRuns[stepId];
    if (!step || step.state !== "succeeded") throw new CraigError("FURY_STATE_CONFLICT", `Step ${stepId} is not complete.`, {});
    if (field === "task_id") return step.taskId ?? "";
    let output = step.output;
    for (const segment of field.split(".").slice(1)) output = isObject(output) ? output[segment] : undefined;
    if (output === undefined) throw new CraigError("FURY_OUTPUT_INVALID", `Step ${stepId} has no output at ${field}.`, {});
    return typeof output === "string" ? output : JSON.stringify(output);
  });
}

function validateOutput(output: unknown, schema: Record<string, unknown> | null): void {
  if (!schema) {
    if (output !== null && output !== undefined) throw new CraigError("FURY_OUTPUT_INVALID", "This step does not declare output.", {});
    return;
  }
  const issues: string[] = [];
  validateSchemaValue(output, schema, "$", issues);
  if (issues.length) throw new CraigError("FURY_OUTPUT_INVALID", "Fury step output does not match its schema.", { details: { issues } });
}
function validateSchemaValue(value: unknown, schema: Record<string, unknown>, at: string, issues: string[]): void {
  const type = schema.type;
  const valid = type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? isObject(value)
    : type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value)
      : typeof value === type;
  if (!valid) { issues.push(`${at} must be ${String(type)}.`); return; }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) issues.push(`${at} is not in enum.`);
  if (type === "object" && isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) if (typeof required === "string" && !Object.hasOwn(value, required)) issues.push(`${at}.${required} is required.`);
    for (const [key, child] of Object.entries(value)) {
      if (isObject(properties[key])) validateSchemaValue(child, properties[key], `${at}.${key}`, issues);
      else if (schema.additionalProperties === false) issues.push(`${at}.${key} is not allowed.`);
    }
  }
  if (type === "array" && Array.isArray(value) && isObject(schema.items)) value.forEach((item, index) => validateSchemaValue(item, schema.items as Record<string, unknown>, `${at}[${index}]`, issues));
}

async function authorizeStepActor(paths: CraigPaths, step: FuryStepRun, actor: CraigActor, token: string | undefined, family: "fury.step.complete" | "fury.step.fail") {
  if (actor.type === "human") return;
  if (actor.type !== "agent" || !token || actor.taskId !== step.taskId) throw new CraigError("CAPABILITY_DENIED", "The step actor does not own this fury step.", {});
  await authorizeCapability(paths, token, family, actor.taskId);
}
function requireRunningAgentStep(run: FuryRun, id: string): FuryStepRun {
  if (isTerminalRun(run)) throw new CraigError("FURY_STATE_CONFLICT", `Run ${run.id} is ${run.state}.`, {});
  const step = run.stepRuns[id];
  if (!step) throw new CraigError("FURY_STATE_CONFLICT", `Run ${run.id} has no step ${id}.`, {});
  if (step.kind !== "agent" || step.state !== "running") throw new CraigError("FURY_STATE_CONFLICT", `Step ${id} is ${step.state}.`, {});
  return step;
}
async function assertFurySourcePath(paths: CraigPaths, file: string): Promise<string> {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(furyDirs(paths).root), realpath(file)]);
  const relative = path.relative(canonicalRoot, canonicalFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !/\.ya?ml$/i.test(relative)) {
    throw new CraigError("FURY_DEFINITION_INVALID", "Fury plans must use a YAML definition stored under .craig/fury/.", {
      details: { file, furyRoot: furyDirs(paths).root },
    });
  }
  return path.join(".craig", "fury", relative);
}
function assertPlanTargetsRoot(steps: FuryPlanStep[], rootTaskId: string): void {
  for (const step of steps) {
    const target = step.target?.type === "task" ? step.target.task : step.review?.feedbackTask;
    if (!target) continue;
    if (target.includes("${{ steps.")) {
      if (/^\$\{\{\s*steps\.[a-z][a-z0-9_-]{0,63}\.task_id\s*\}\}$/.test(target)) continue;
      throw new CraigError("FURY_DEFINITION_INVALID", `Fury step ${step.id} has an unsafe dynamic task target.`, {
        details: { stepId: step.id, target },
      });
    }
    if (target !== rootTaskId) {
      throw new CraigError("FURY_DEFINITION_INVALID", `Fury step ${step.id} targets ${target} outside its planning task.`, {
        details: { stepId: step.id, targetTaskId: target, rootTaskId },
      });
    }
  }
}
function completionInstructions(runId: string, stepId: string, schema: Record<string, unknown> | null): string {
  return schema
    ? `When the work is complete, report it explicitly with: craig fury step complete --run ${runId} --step ${stepId} --output '<json matching ${JSON.stringify(schema)}>' --json\nIf it fails, run: craig fury step fail --run ${runId} --step ${stepId} --reason '<reason>' --json`
    : `When the work is complete, report it explicitly with: craig fury step complete --run ${runId} --step ${stepId} --json\nIf it fails, run: craig fury step fail --run ${runId} --step ${stepId} --reason '<reason>' --json`;
}
async function failStepRecord(paths: CraigPaths, runId: string, stepId: string, reason: string, actor: CraigActor): Promise<FuryRun> {
  const now = new Date().toISOString();
  let changed = false;
  const run = await mutateFuryRun(paths, runId, (current) => {
    if (current.stepRuns[stepId]?.state === "failed") return current;
    if (isTerminalRun(current) || current.stepRuns[stepId]?.state !== "running") {
      throw new CraigError("FURY_STATE_CONFLICT", `Step ${stepId} is no longer running.`, {});
    }
    changed = true;
    return updateStep(current, stepId, { state: "failed", error: reason, completedAt: now, completedBy: actor });
  });
  if (changed) await event(paths, run, stepId, "fury.step.failed", actor, { reason });
  return run;
}
function updateStep(run: FuryRun, id: string, patch: Partial<FuryStepRun>): FuryRun {
  const now = new Date().toISOString();
  return { ...run, updatedAt: now, stepRuns: { ...run.stepRuns, [id]: { ...run.stepRuns[id]!, ...patch } } };
}
async function refreshRunState(paths: CraigPaths, id: string): Promise<void> {
  const run = await readFuryRun(paths, id);
  const steps = Object.values(run.stepRuns);
  const state = steps.every((step) => step.state === "succeeded") ? "succeeded"
    : steps.some((step) => step.state === "failed" || step.state === "timed_out") ? "failed"
      : steps.some((step) => step.state === "running") ? "running"
        : steps.some((step) => step.state === "waiting_for_review" || step.state === "changes_requested") ? "waiting_for_review"
          : steps.some((step) => step.state === "pending") ? "running" : run.state;
  await setRunState(paths, id, state, SYSTEM_ACTOR);
}
async function setRunState(paths: CraigPaths, id: string, state: FuryRun["state"], actor: CraigActor): Promise<FuryRun> {
  const before = await readFuryRun(paths, id);
  if (before.state === state) return before;
  const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(state);
  const now = new Date().toISOString();
  const run = await mutateFuryRun(paths, id, (current) => isTerminalRun(current)
    ? current
    : ({ ...current, state, updatedAt: now, stateChangedAt: now, completedAt: terminal ? now : null,
      ...(["failed", "cancelled", "timed_out"].includes(state) ? { cleanupPending: true, cleanupError: null,
        stepRuns: Object.fromEntries(Object.entries(current.stepRuns).map(([stepId, step]) => [stepId,
          ["pending", "running", "waiting_for_review", "changes_requested"].includes(step.state)
            ? { ...step, state: "cancelled" as const, completedAt: now, completedBy: SYSTEM_ACTOR } : step,
        ])),
      } : {}),
    }));
  if (run.state !== state) return run;
  await event(paths, run, null, `fury.run.${state}`, actor, { state });
  return run;
}
function finishTimedOut(run: FuryRun): FuryRun {
  const now = new Date().toISOString();
  return { ...run, state: "timed_out", cleanupPending: true, cleanupError: null, updatedAt: now, stateChangedAt: now, completedAt: now, stepRuns: Object.fromEntries(Object.entries(run.stepRuns).map(([id, step]) => [id,
    step.state === "succeeded" ? step : { ...step, state: "timed_out", completedAt: now, completedBy: SYSTEM_ACTOR },
  ])) };
}
async function event(paths: CraigPaths, run: FuryRun, stepId: string | null, type: string, actor: CraigActor, data: unknown): Promise<void> {
  const round = isObject(data) && Number.isInteger(data.round) ? `:round-${String(data.round)}` : "";
  const step = stepId ? run.stepRuns[stepId] : null;
  const occurrenceKey = type === "fury.run.created" ? run.createdAt
    : type.startsWith("fury.run.") ? run.stateChangedAt
      : type === "fury.step.started" || type === "fury.review.requested" ? step?.startedAt
        : type === "fury.step.dispatched" ? `${step?.taskId ?? "task"}:${step?.commandId ?? "launch"}`
          : type.startsWith("fury.step.") ? step?.completedAt
            : round || run.updatedAt;
  await appendEvent(paths, {
    id: `${run.id}:${stepId ?? "run"}:${type}:${occurrenceKey ?? "unknown"}${round}`,
    furyRunId: run.id,
    furyStepId: stepId,
    taskId: stepId ? run.stepRuns[stepId]?.taskId ?? run.rootTaskId : run.rootTaskId,
    type,
    occurredAt: typeof occurrenceKey === "string" && Number.isFinite(Date.parse(occurrenceKey)) ? occurrenceKey : run.updatedAt,
    actor,
    data,
  });
}
async function reconcileFuryAudit(paths: CraigPaths, run: FuryRun): Promise<void> {
  await event(paths, run, null, "fury.run.created", run.actor, { state: "pending" });
  if (run.state !== "pending") await event(paths, run, null, `fury.run.${run.state}`, SYSTEM_ACTOR, { state: run.state });
  for (const step of Object.values(run.stepRuns)) {
    if (step.startedAt) await event(paths, run, step.id, "fury.step.started", SYSTEM_ACTOR, {});
    if (step.taskId) await event(paths, run, step.id, "fury.step.dispatched", SYSTEM_ACTOR, {
      taskId: step.taskId, agentTabId: step.agentTabId, commandId: step.commandId,
    });
    if (["succeeded", "failed", "timed_out", "cancelled"].includes(step.state)) {
      await event(paths, run, step.id, `fury.step.${step.state}`, step.completedBy ?? SYSTEM_ACTOR, { reason: step.error });
    }
    if (!step.reviewId) continue;
    const review = await readFuryReview(paths, step.reviewId);
    await event(paths, run, step.id, "fury.review.requested", SYSTEM_ACTOR, {
      reviewId: review.id, title: review.title,
    });
    for (const decision of review.history) {
      await event(paths, run, step.id, `fury.review.${decision.action}`, decision.actor, {
        reviewId: review.id, round: decision.round, feedbackCommandId: decision.feedbackCommandId,
      });
    }
  }
}
async function cleanupFuryRun(paths: CraigPaths, run: FuryRun): Promise<void> {
  try {
    const tasks = (await taskService.listTasks(paths, { includeClosed: true })).tasks;
    const owned = tasks.filter((task) => task.furyRunId === run.id &&
      (run.state === "cancelled" || run.stepRuns[task.furyStepId ?? ""]?.state !== "succeeded"));
    const taskIds = new Set(owned.map((task) => task.id));
    const commandIds = new Set(Object.values(run.stepRuns).map((step) => step.commandId).filter(Boolean));
    const reviews = (await listFuryReviews(paths)).filter((item) => item.runId === run.id);
    const reviewIds = new Set(reviews.map((review) => review.id));
    for (const command of await listPromptCommands(paths)) {
      const feedbackReviewId = command.idempotencyKey?.match(/^fury-review:([^:]+):[0-9]+$/)?.[1];
      if (command.state === "queued" && (commandIds.has(command.id) || taskIds.has(command.taskId) ||
        (feedbackReviewId && reviewIds.has(feedbackReviewId)))) {
        await promptCommandService.cancel(paths, command.id, SYSTEM_ACTOR);
      }
    }
    for (const task of owned) await cancelTaskTreeAndSessions(paths, task.id);
    for (const review of reviews) {
      await mutateFuryReview(paths, review.id, (current) =>
        ["waiting_for_review", "changes_requested"].includes(current.state)
          ? { ...current, state: run.state === "timed_out" ? "timed_out" : "cancelled", version: current.version + 1, updatedAt: new Date().toISOString() }
          : current);
    }
    const cleaned = await mutateFuryRun(paths, run.id, (current) => ({ ...current, cleanupPending: false, cleanupError: null }));
    await event(paths, cleaned, null, "fury.run.cleanup_completed", SYSTEM_ACTOR, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fury cleanup failed.";
    await mutateFuryRun(paths, run.id, (current) => ({ ...current, cleanupPending: true, cleanupError: message }));
    if (run.cleanupError !== message) await event(paths, run, null, "fury.run.cleanup_failed", SYSTEM_ACTOR, { reason: message });
  }
}

async function requireFuryWake(paths: CraigPaths, runId: string): Promise<void> {
  if (await wakeOrchestrationSupervisor(paths)) return;
  throw new CraigError("PARTIAL_RESULT", `Fury run ${runId} was saved, but its supervisor is unavailable. Start Craig for this workspace and resume the run.`, {
    retryable: true, details: { runId, persisted: true, reason: "ORCHESTRATION_UNAVAILABLE" },
  });
}

// The committed review decision is durable dispatch intent. Enqueueing before
// that decision wins its version check can leak feedback from a losing caller.
async function reconcileReviewFeedback(paths: CraigPaths, run: FuryRun): Promise<void> {
  for (const step of Object.values(run.stepRuns)) {
    if (!step.reviewId) continue;
    const review = await readFuryReview(paths, step.reviewId);
    const decision = review.lastDecision;
    if (review.state !== "changes_requested" || !review.feedbackTarget ||
      decision?.action !== "request_changes" || decision.feedbackCommandId ||
      Date.now() >= Math.min(Date.parse(run.deadlineAt), Date.parse(review.deadlineAt))) continue;
    const task = await taskService.getTask(paths, review.feedbackTarget.taskId);
    const tab = review.feedbackTarget.agentTabId
      ? task.ptyTabs.find((candidate) => candidate.kind === "agent" && candidate.id === review.feedbackTarget!.agentTabId)
      : task.ptyTabs.find((candidate) => candidate.kind === "agent");
    if (!tab) throw new CraigError("TASK_CONTEXT_CONFLICT", `Feedback task ${task.id} has no agent tab.`, {});
    const { command } = await promptCommandService.create(paths, {
      taskId: task.id, agentTabId: tab.id,
      prompt: { source: "inline", text: `Fury review ${review.id} changes requested:\n\n${decision.message}\n\nAfter revisions, resubmit with: craig fury review resubmit ${review.id} --summary '<revised summary>' --json\nOnly a human can approve this review.` },
      delivery: "when-ready", timeoutMs: Math.min(run.limits.timeoutMs, 86_400_000),
      idempotencyKey: `fury-review:${review.id}:${decision.round}`, actor: decision.actor,
    });
    await mutateFuryReview(paths, review.id, (current) => {
      if (current.state !== "changes_requested" || current.version !== review.version) return current;
      const bound = { ...decision, feedbackCommandId: command.id };
      return { ...current, lastDecision: bound,
        history: current.history.map((item) => item.sequence === decision.sequence ? bound : item),
      };
    });
  }
}

async function reconcileReviewDecisions(paths: CraigPaths, run: FuryRun): Promise<FuryRun> {
  for (const step of Object.values(run.stepRuns)) {
    if (!step.reviewId || step.kind !== "human_review") continue;
    const review = await readFuryReview(paths, step.reviewId);
    const state = review.state === "approved" ? "succeeded" : review.state === "rejected" ? "failed" : review.state;
    if (step.state === state) continue;
    run = await mutateFuryRun(paths, run.id, (current) => isTerminalRun(current) ? current : updateStep(current, step.id, {
      state, completedBy: review.lastDecision?.actor ?? SYSTEM_ACTOR,
      ...(["succeeded", "failed", "timed_out", "cancelled"].includes(state) ? { completedAt: review.updatedAt } : {}),
    }));
  }
  return run;
}

async function assertEnabled(paths: CraigPaths) {
  if (!configService.previews.isEnabled(await configService.load(paths), "agentOrchestration")) throw new CraigError("CLI_USAGE", "Fury execution is a feature preview. Enable agentOrchestration first.", { details: { preview: "agentOrchestration" } });
}
function isTerminalRun(run: FuryRun) { return ["succeeded", "failed", "cancelled", "timed_out"].includes(run.state); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function wait(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve) => { const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true }); }); }

export const furyRuntimeService = {
  plan: createPlan, approve: approvePlan, run: runFury, show: showFury, watch: watchFury, cancel: cancelFury, resume: resumeFury,
  completeStep: completeFuryStep, failStep: failFuryStep,
  listReviews, showReview, actOnReview, reconcile: reconcileFuryRuns,
};
