import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { TaskPR, TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { readRawTask, writeTask } from "../adapters/task-store.js";
import { withTaskLock } from "../adapters/task-lock.js";
import { getCurrentBranch } from "../adapters/git.js";
import { validateTaskRecord } from "../tasks/validate.js";
import { fetchPrView, discoverPrView } from "../adapters/github.js";
import type { GhPrView } from "../adapters/github.js";
import { resolveArtifactPath } from "../tasks/artifacts.js";
import { getTaskPrimaryPr, upsertTaskPr, deriveTaskStatusFromPrs, normalizePr } from "./state.js";
import { CraigError } from "../../error/index.js";

export const writePrStatusArtifact = async (paths: CraigPaths, task: TaskRecord): Promise<void> => {
  const artifactPath = resolveArtifactPath(paths, task.artifacts.prStatusPath);

  if (!artifactPath) {
    return;
  }

  await mkdir(path.dirname(artifactPath), { recursive: true });
  await atomicWriteJson(artifactPath, {
    taskId: task.id,
    prs: task.prs,
  });
};

export const persistTaskAndPrStatus = async (
  paths: CraigPaths,
  task: TaskRecord,
  deps: {
    writeTask: typeof writeTask;
    writePrStatusArtifact: typeof writePrStatusArtifact;
  } = { writeTask, writePrStatusArtifact },
): Promise<TaskRecord> => {
  await deps.writeTask(paths, task);
  try {
    await deps.writePrStatusArtifact(paths, task);
  } catch (error) {
    throw new CraigError(
      "PARTIAL_RESULT",
      `Task ${task.id} was updated, but its PR status artifact could not be written.`,
      { retryable: true, details: { taskId: task.id }, cause: error },
    );
  }
  return task;
};

export const persistPullRequestView = async (
  paths: CraigPaths,
  task: TaskRecord,
  view: GhPrView,
  existingPr: TaskPR | null,
  deps: {
    readRawTask: typeof readRawTask;
    validateTaskRecord: typeof validateTaskRecord;
    writeTask: typeof writeTask;
    writePrStatusArtifact: typeof writePrStatusArtifact;
    withTaskLock: typeof withTaskLock;
  } = { readRawTask, validateTaskRecord, writeTask, writePrStatusArtifact, withTaskLock },
): Promise<TaskRecord> => {
  return deps.withTaskLock(paths, task.id, async () => {
    const raw = await deps.readRawTask(paths, task.id);
    const latest = deps.validateTaskRecord(raw, `${paths.tasksDir}/${task.id}.json`);
    const latestExisting = latest.prs.find((pr) =>
      existingPr?.number !== null && pr.number === existingPr?.number
    ) ?? existingPr;
    const normalized = normalizePr(view, latestExisting);
    const withPr = upsertTaskPr(latest, normalized);
    const status = latest.status === "closed"
      ? latest.status
      : deriveTaskStatusFromPrs(withPr.prs);
    const persistedTask = { ...withPr, status };
    return persistTaskAndPrStatus(paths, persistedTask, deps);
  });
};

export const refreshPullRequestState = async (
  paths: CraigPaths,
  task: TaskRecord,
): Promise<TaskRecord> => {
  const primaryPr = getTaskPrimaryPr(task);
  const selector = primaryPr?.number ? String(primaryPr.number) : task.branch;
  const payload = await fetchPrView(selector, task.worktreePath);
  return persistPullRequestView(paths, task, payload, primaryPr);
};

export const discoverPullRequestState = async (
  paths: CraigPaths,
  task: TaskRecord,
): Promise<{ discovered: boolean; task: TaskRecord }> => {
  for (const branch of await getPullRequestDiscoveryBranches(task)) {
    const payload = await discoverPrView(branch, task.worktreePath);

    if (!payload) {
      continue;
    }

    const persistedTask = await persistPullRequestView(paths, task, payload, null);

    return { discovered: true, task: persistedTask };
  }

  return { discovered: false, task };
};

export const getPullRequestDiscoveryBranches = async (task: TaskRecord): Promise<string[]> => {
  const currentBranch = await getCurrentBranch(task.worktreePath).catch(() => null);
  return [...new Set([currentBranch, task.branch].filter((branch): branch is string => Boolean(branch)))];
};
