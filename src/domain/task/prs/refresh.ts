import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { TaskPR, TaskRecord } from "../../../types/task.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { readRawTask, writeTask } from "../adapters/task-store.js";
import { validateTaskRecord } from "../tasks/validate.js";
import { fetchPrView, discoverPrView } from "../adapters/github.js";
import type { GhPrView } from "../adapters/github.js";
import { resolveArtifactPath } from "../tasks/artifacts.js";
import { getTaskPrimaryPr, upsertTaskPr, deriveTaskStatusFromPrs, normalizePr } from "./state.js";

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
  } = { readRawTask, validateTaskRecord, writeTask, writePrStatusArtifact },
): Promise<TaskRecord> => {
  const normalized = normalizePr(view, existingPr);
  const withPr = upsertTaskPr(task, normalized);
  const status = deriveTaskStatusFromPrs(withPr.prs);
  const withStatus = { ...withPr, status };
  await deps.writePrStatusArtifact(paths, withStatus);
  const raw = await deps.readRawTask(paths, task.id);
  const latest = deps.validateTaskRecord(raw, `${paths.tasksDir}/${task.id}.json`);
  const finalStatus = latest.status === "closed" ? latest.status : status;
  const persistedTask = upsertTaskPr({ ...latest, status: finalStatus }, normalized);
  await deps.writeTask(paths, persistedTask);
  return persistedTask;
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
  const payload = await discoverPrView(task.branch, task.worktreePath);

  if (!payload) {
    return { discovered: false, task };
  }

  const persistedTask = await persistPullRequestView(paths, task, payload, null);

  return { discovered: true, task: persistedTask };
};
