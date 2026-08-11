import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { CraigError } from "../../error/index.js";
import { withFuryLock } from "../adapters/fury-lock.js";
import type { FuryApproval, FuryPlan, HumanReviewCheckpoint, FuryRun } from "./runtime-types.js";

export const furyDirs = (paths: CraigPaths) => ({
  root: path.join(paths.craigDir, "fury"),
  definitions: path.join(paths.craigDir, "fury", "definitions"),
  plans: path.join(paths.craigDir, "fury", "plans"),
  approvals: path.join(paths.craigDir, "fury", "approvals"),
  runs: path.join(paths.craigDir, "fury", "runs"),
  reviews: path.join(paths.craigDir, "fury", "reviews"),
});

export function hashFuryPlan(plan: Omit<FuryPlan, "id" | "planHash" | "createdBy" | "createdAt">): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export async function persistFuryDefinition(paths: CraigPaths, hash: string, source: string): Promise<void> {
  const dirs = furyDirs(paths);
  await mkdir(dirs.definitions, { recursive: true });
  const file = path.join(dirs.definitions, `${hash}.yaml`);
  await writeFile(file, source, { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    if (!isMissingCode(error, "EEXIST")) throw error;
  });
}

export async function createFuryPlan(paths: CraigPaths, plan: FuryPlan): Promise<FuryPlan> {
  return withFuryLock(paths, async () => {
    const plans = await listFuryPlans(paths);
    const existing = plans.find((candidate) => candidate.planHash === plan.planHash);
    if (existing) return existing;
    const latestForSource = plans.filter((candidate) =>
      candidate.rootTaskId === plan.rootTaskId && candidate.sourceFile === plan.sourceFile).at(-1);
    const persisted = latestForSource && Date.parse(plan.createdAt) <= Date.parse(latestForSource.createdAt)
      ? { ...plan, createdAt: new Date(Date.parse(latestForSource.createdAt) + 1).toISOString() }
      : plan;
    await mkdir(furyDirs(paths).plans, { recursive: true });
    await atomicWriteJson(planPath(paths, persisted.id), persisted);
    return persisted;
  });
}

export async function readFuryPlan(paths: CraigPaths, id: string): Promise<FuryPlan> {
  assertId(id, "plan");
  try { return validatePlan(JSON.parse(await readFile(planPath(paths, id), "utf8")) as unknown, id); }
  catch (error) {
    if (isMissingCode(error, "ENOENT")) throw new CraigError("FURY_PLAN_NOT_FOUND", `Fury plan "${id}" was not found.`, {});
    throw error;
  }
}

export async function listFuryPlans(paths: CraigPaths): Promise<FuryPlan[]> {
  const dir = furyDirs(paths).plans;
  const names = await readdir(dir).catch((error: unknown) => isMissingCode(error, "ENOENT") ? [] : Promise.reject(error));
  const plans = await Promise.all(names.filter((name) => name.endsWith(".json")).sort()
    .map((name) => readFuryPlan(paths, name.slice(0, -5))));
  return plans.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function listPendingFuryPlans(paths: CraigPaths): Promise<FuryPlan[]> {
  const plans = await listFuryPlans(paths);
  const approvals = await Promise.all(plans.map((plan) => readApprovalIfPresent(paths, plan.id)));
  const latestBySource = new Map<string, FuryPlan>();
  for (const [index, plan] of plans.entries()) {
    if (approvals[index] !== null) continue;
    latestBySource.set(`${plan.rootTaskId}\0${plan.sourceFile}`, plan);
  }
  return [...latestBySource.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function approveFuryPlan(
  paths: CraigPaths,
  approval: FuryApproval,
): Promise<{ approval: FuryApproval; created: boolean }> {
  return withFuryLock(paths, async () => {
    const existing = await readApprovalIfPresent(paths, approval.planId);
    if (existing) {
      if (existing.planHash !== approval.planHash) {
        throw new CraigError("FURY_STATE_CONFLICT", `Fury plan ${approval.planId} changed after approval.`, {});
      }
      return { approval: existing, created: false };
    }
    await mkdir(furyDirs(paths).approvals, { recursive: true });
    await atomicWriteJson(approvalPath(paths, approval.planId), approval);
    return { approval, created: true };
  });
}

export async function readFuryApproval(paths: CraigPaths, planId: string): Promise<FuryApproval> {
  assertId(planId, "plan");
  const approval = await readApprovalIfPresent(paths, planId);
  if (!approval) throw new CraigError("FURY_APPROVAL_REQUIRED", `Fury plan ${planId} requires human approval.`, {});
  return approval;
}

export async function createFuryRun(paths: CraigPaths, run: FuryRun): Promise<{ run: FuryRun; created: boolean }> {
  return withFuryLock(paths, async () => {
    const runs = await listFuryRunsUnlocked(paths);
    const existing = runs.find((item) => item.planId === run.planId);
    if (existing) {
      if (existing.planHash !== run.planHash) {
        throw new CraigError("FURY_STATE_CONFLICT", `Fury plan ${run.planId} changed after its run was created.`, {});
      }
      return { run: existing, created: false };
    }
    await mkdir(furyDirs(paths).runs, { recursive: true });
    await atomicWriteJson(runPath(paths, run.id), run);
    return { run, created: true };
  });
}

export async function readFuryRun(paths: CraigPaths, id: string): Promise<FuryRun> {
  assertId(id, "run");
  try { return validateRun(JSON.parse(await readFile(runPath(paths, id), "utf8")) as unknown, id); }
  catch (error) {
    if (isMissingCode(error, "ENOENT")) throw new CraigError("FURY_RUN_NOT_FOUND", `Fury run "${id}" was not found.`, {});
    throw error;
  }
}

export async function listFuryRuns(paths: CraigPaths): Promise<FuryRun[]> { return listFuryRunsUnlocked(paths); }
async function listFuryRunsUnlocked(paths: CraigPaths): Promise<FuryRun[]> {
  const dir = furyDirs(paths).runs;
  const names = await readdir(dir).catch((error: unknown) => isMissingCode(error, "ENOENT") ? [] : Promise.reject(error));
  const runs = await Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
    const id = name.slice(0, -5);
    return validateRun(JSON.parse(await readFile(path.join(dir, name), "utf8")) as unknown, id);
  }));
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function mutateFuryRun(
  paths: CraigPaths,
  id: string,
  /* eslint-disable-next-line no-unused-vars */
  mutation: (run: FuryRun) => FuryRun,
): Promise<FuryRun> {
  return withFuryLock(paths, async () => {
    const current = await readFuryRun(paths, id);
    const next = mutation(current);
    if (next.id !== id) throw new CraigError("INTERNAL_ERROR", "Fury mutation cannot change its id.", {});
    await atomicWriteJson(runPath(paths, id), next);
    return next;
  });
}

export async function writeFuryReview(paths: CraigPaths, review: HumanReviewCheckpoint): Promise<void> {
  await mkdir(furyDirs(paths).reviews, { recursive: true });
  await atomicWriteJson(reviewPath(paths, review.id), review);
}

export async function mutateFuryReview(
  paths: CraigPaths,
  id: string,
  /* eslint-disable-next-line no-unused-vars */
  mutation: (review: HumanReviewCheckpoint) => HumanReviewCheckpoint,
): Promise<HumanReviewCheckpoint> {
  return withFuryLock(paths, async () => {
    const current = await readFuryReview(paths, id);
    const next = mutation(current);
    if (next.id !== id) throw new CraigError("INTERNAL_ERROR", "Fury review mutation cannot change its id.", {});
    await atomicWriteJson(reviewPath(paths, id), next);
    return next;
  });
}

export async function readFuryReview(paths: CraigPaths, id: string): Promise<HumanReviewCheckpoint> {
  assertId(id, "review");
  try { return validateReview(JSON.parse(await readFile(reviewPath(paths, id), "utf8")) as unknown, id); }
  catch (error) {
    if (isMissingCode(error, "ENOENT")) throw new CraigError("FURY_REVIEW_NOT_FOUND", `Fury review "${id}" was not found.`, {});
    throw error;
  }
}

export async function listFuryReviews(paths: CraigPaths): Promise<HumanReviewCheckpoint[]> {
  const dir = furyDirs(paths).reviews;
  const names = await readdir(dir).catch((error: unknown) => isMissingCode(error, "ENOENT") ? [] : Promise.reject(error));
  return Promise.all(names.filter((name) => name.endsWith(".json")).sort().map((name) => readFuryReview(paths, name.slice(0, -5))));
}

function validateRun(value: unknown, id: string): FuryRun {
  const states = ["pending", "running", "waiting_for_review", "succeeded", "failed", "cancelled", "timed_out"];
  if (
    !isObject(value) || value.schemaVersion !== 1 || value.id !== id ||
    typeof value.planId !== "string" || !/^fury_plan_[A-Za-z0-9_-]+$/.test(value.planId) ||
    typeof value.planHash !== "string" || !/^[a-f0-9]{64}$/.test(value.planHash) ||
    typeof value.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.definitionHash) ||
    typeof value.name !== "string" || !value.name || typeof value.sourceFile !== "string" || !value.sourceFile ||
    typeof value.rootTaskId !== "string" || !value.rootTaskId || !states.includes(String(value.state)) ||
    !isObject(value.inputs) || !isLimits(value.limits) || !Array.isArray(value.order) ||
    value.order.some((step) => typeof step !== "string") || new Set(value.order).size !== value.order.length ||
    !hasStepRuns(value.stepRuns, value.order) || !isActor(value.actor) ||
    !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || !isTimestamp(value.stateChangedAt) || !isTimestamp(value.deadlineAt) ||
    (value.completedAt !== null && !isTimestamp(value.completedAt))
  ) {
    throw new CraigError("FURY_RECORD_INVALID", `Fury run record ${id} is invalid.`, {});
  }
  return value as unknown as FuryRun;
}
function validatePlan(value: unknown, id: string): FuryPlan {
  if (
    !isObject(value) || value.schemaVersion !== 1 || value.id !== id ||
    typeof value.planHash !== "string" || !/^[a-f0-9]{64}$/.test(value.planHash) ||
    typeof value.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.definitionHash) ||
    typeof value.name !== "string" || !value.name || typeof value.sourceFile !== "string" || !value.sourceFile ||
    typeof value.rootTaskId !== "string" || !value.rootTaskId || !isObject(value.inputs) || !isLimits(value.limits) ||
    !Array.isArray(value.order) || value.order.some((step) => typeof step !== "string") ||
    !Array.isArray(value.waves) || value.waves.some((wave) => !Array.isArray(wave) || wave.some((step) => typeof step !== "string")) ||
    !Array.isArray(value.steps) || value.steps.length !== value.order.length || !isActor(value.createdBy) || !isTimestamp(value.createdAt)
  ) throw new CraigError("FURY_RECORD_INVALID", `Fury plan record ${id} is invalid.`, {});
  const hashable = { ...value };
  delete hashable.id;
  delete hashable.planHash;
  delete hashable.createdBy;
  delete hashable.createdAt;
  if (hashFuryPlan(hashable as Omit<FuryPlan, "id" | "planHash" | "createdBy" | "createdAt">) !== value.planHash) {
    throw new CraigError("FURY_RECORD_INVALID", `Fury plan record ${id} no longer matches its approved content hash.`, {});
  }
  return value as unknown as FuryPlan;
}
function validateReview(value: unknown, id: string): HumanReviewCheckpoint {
  const states = ["waiting_for_review", "changes_requested", "approved", "rejected", "timed_out", "cancelled"];
  if (
    !isObject(value) || value.schemaVersion !== 1 || value.id !== id ||
    typeof value.runId !== "string" || typeof value.stepId !== "string" || !states.includes(String(value.state)) ||
    typeof value.title !== "string" || typeof value.summary !== "string" ||
    (value.feedbackTarget !== null && (!isObject(value.feedbackTarget) || typeof value.feedbackTarget.taskId !== "string" ||
      (value.feedbackTarget.agentTabId !== null && typeof value.feedbackTarget.agentTabId !== "string"))) ||
    !Number.isInteger(value.round) || Number(value.round) < 1 || !Number.isInteger(value.version) || Number(value.version) < 1 ||
    !isTimestamp(value.requestedAt) || !isTimestamp(value.deadlineAt) || !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.history) || value.history.some((decision) => !isDecision(decision)) ||
    (value.lastDecision !== null && !isDecision(value.lastDecision))
  ) {
    throw new CraigError("FURY_RECORD_INVALID", `Fury review record ${id} is invalid.`, {});
  }
  return value as unknown as HumanReviewCheckpoint;
}
function hasStepRuns(value: unknown, order: unknown[]): boolean {
  return isObject(value) && Object.keys(value).length === order.length &&
    order.every((step) => typeof step === "string" && isStepRun(value[step], step));
}
function isStepRun(value: unknown, id: string): boolean {
  if (!isObject(value) || value.id !== id || !["agent", "human_review"].includes(String(value.kind)) ||
    !["pending", "running", "waiting_for_review", "changes_requested", "succeeded", "failed", "cancelled", "timed_out"].includes(String(value.state)) ||
    !Array.isArray(value.needs) || value.needs.some((need) => typeof need !== "string") || !isObject(value.plan)) return false;
  return [value.taskId, value.agentTabId, value.commandId, value.reviewId, value.error]
    .every((item) => item === null || typeof item === "string") &&
    [value.startedAt, value.completedAt, value.deadlineAt].every((item) => item === null || isTimestamp(item)) &&
    (value.completedBy === null || isActor(value.completedBy));
}
function isDecision(value: unknown): boolean {
  return isObject(value) && Number.isInteger(value.sequence) && Number.isInteger(value.round) &&
    ["approve", "reject", "request_changes", "resubmit"].includes(String(value.action)) &&
    (value.message === null || typeof value.message === "string") && isActor(value.actor) &&
    (value.feedbackCommandId === null || typeof value.feedbackCommandId === "string") && isTimestamp(value.occurredAt);
}
function isLimits(value: unknown): boolean {
  return isObject(value) && Number.isInteger(value.maxConcurrency) && Number(value.maxConcurrency) > 0 &&
    Number.isInteger(value.maxTasks) && Number(value.maxTasks) > 0 && Number.isInteger(value.timeoutMs) && Number(value.timeoutMs) > 0;
}
function isActor(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "human") return ["cli", "tui"].includes(String(value.source)) && Number.isInteger(value.processId);
  if (value.type === "agent") return typeof value.taskId === "string" && typeof value.agentTabId === "string" && typeof value.capabilityId === "string";
  return value.type === "system" && ["orchestration-supervisor", "heartbeat"].includes(String(value.component));
}
const runPath = (paths: CraigPaths, id: string) => path.join(furyDirs(paths).runs, `${id}.json`);
const planPath = (paths: CraigPaths, id: string) => path.join(furyDirs(paths).plans, `${id}.json`);
const approvalPath = (paths: CraigPaths, id: string) => path.join(furyDirs(paths).approvals, `${id}.json`);
const reviewPath = (paths: CraigPaths, id: string) => path.join(furyDirs(paths).reviews, `${id}.json`);
const assertId = (id: string, type: "plan" | "run" | "review") => {
  const pattern = type === "plan" ? /^fury_plan_[A-Za-z0-9_-]+$/ : type === "run" ? /^fury_[A-Za-z0-9_-]+$/ : /^review_[A-Za-z0-9_-]+$/;
  if (!pattern.test(id)) throw new CraigError("CLI_USAGE", `Invalid fury ${type} id "${id}".`, {});
};
async function readApprovalIfPresent(paths: CraigPaths, planId: string): Promise<FuryApproval | null> {
  try {
    const value = JSON.parse(await readFile(approvalPath(paths, planId), "utf8")) as unknown;
    if (!isObject(value) || value.schemaVersion !== 1 || value.planId !== planId ||
      typeof value.planHash !== "string" || !/^[a-f0-9]{64}$/.test(value.planHash) ||
      !isActor(value.approvedBy) || !isObject(value.approvedBy) || value.approvedBy.type !== "human" || !isTimestamp(value.approvedAt)) {
      throw new CraigError("FURY_RECORD_INVALID", `Fury approval record ${planId} is invalid.`, {});
    }
    return value as unknown as FuryApproval;
  } catch (error) {
    if (isMissingCode(error, "ENOENT")) return null;
    throw error;
  }
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTimestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isMissingCode = (error: unknown, code: string) => typeof error === "object" && error !== null && "code" in error && error.code === code;
