import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { listWorkspaceRecords, readRepo } from "../../workspace/index.js";
import { CraigError } from "../../error/index.js";
import { branchExists, deleteBranch, removeWorktree } from "../adapters/git.js";
import { withTaskLock } from "../adapters/task-lock.js";
import { writeTask } from "../adapters/task-store.js";
import type { CommandAddTaskRepoTargetResult, TaskRecord } from "../types.js";
import { getTask } from "./inspect.js";
import { createReadyProjectRepoTarget, writeProjectBundleMetadata } from "./provision.js";

const PROJECT_BUNDLE_GUIDE_FILENAME = ["AGENTS", "md"].join(".");

export const addTaskRepoTarget = async (
  paths: CraigPaths,
  taskId: string,
  repoId: string,
): Promise<CommandAddTaskRepoTargetResult> => {
  return withTaskLock(paths, taskId, async () => {
    const task = await getTask(paths, taskId);
    assertProjectTask(task);

    const existing = task.repoTargets?.find((target) => target.repoId === repoId);
    if (existing) {
      return buildResult(task.id, existing.repoId, existing.branch, existing.worktreePath, "unchanged");
    }

    const [repo, workspace] = await Promise.all([
      readRepo(paths, repoId),
      listWorkspaceRecords(paths).then((workspaces) =>
        workspaces.find((candidate) => candidate.id === task.workspaceId) ?? null
      ),
    ]);
    if (
      !workspace ||
      workspace.kind !== "project" ||
      workspace.status !== "active" ||
      !workspace.discoveredRepoIds?.includes(repo.id)
    ) {
      throw new CraigError(
        "TASK_CONTEXT_CONFLICT",
        `Repo ${repo.id} is not a discovered repository in project workspace ${task.workspaceId}.`,
        { details: { taskId: task.id, repoId: repo.id, workspaceId: task.workspaceId } },
      );
    }

    const bundlePath = task.bundlePath ?? task.worktreePath;
    const worktreePath = path.join(bundlePath, allocateRepoDirectoryName(repo.name, task));
    const manifestPath = path.join(bundlePath, "manifest.json");
    const guidePath = path.join(bundlePath, PROJECT_BUNDLE_GUIDE_FILENAME);
    const [manifestBackup, guideBackup, branchAlreadyExisted] = await Promise.all([
      readFile(manifestPath, "utf8"),
      readFile(guidePath, "utf8"),
      branchExists(repo.rootPath, task.branch),
    ]);

    try {
      const target = await createReadyProjectRepoTarget(paths, repo, task.branch, worktreePath);
      const nextTask: TaskRecord = {
        ...task,
        linkedRepoIds: repo.id === task.repoId || task.linkedRepoIds.includes(repo.id)
          ? task.linkedRepoIds
          : [...task.linkedRepoIds, repo.id],
        repoTargets: [...(task.repoTargets ?? []), target],
      };
      const repos = await Promise.all((nextTask.repoTargets ?? []).map((candidate) => readRepo(paths, candidate.repoId)));
      await writeProjectBundleMetadata({
        taskId: task.id,
        workspaceId: task.workspaceId,
        prompt: readManifestPrompt(manifestBackup) ?? task.title,
        repos,
        repoTargets: nextTask.repoTargets ?? [],
        bundlePath,
      });
      await writeTask(paths, nextTask);
      return buildResult(task.id, repo.id, target.branch, target.worktreePath, "added");
    } catch (error) {
      const rollbackFailures = await rollbackFailedAttachment({
        repoRoot: repo.rootPath,
        branch: task.branch,
        worktreePath,
        branchAlreadyExisted,
        manifestPath,
        manifestBackup,
        guidePath,
        guideBackup,
      });
      if (rollbackFailures.length > 0) {
        throw new CraigError(
          "PARTIAL_RESULT",
          `Failed to attach repo ${repo.id} to task ${task.id}, and rollback was incomplete.`,
          {
            retryable: true,
            details: {
              taskId: task.id,
              repoId: repo.id,
              rollbackFailures: rollbackFailures.map((failure) =>
                failure instanceof Error ? failure.message : String(failure)
              ),
            },
            cause: error,
          },
        );
      }
      throw error;
    }
  });
};

const assertProjectTask = (task: TaskRecord): void => {
  if (task.type !== "project" || !task.bundlePath) {
    throw new CraigError(
      "TASK_CONTEXT_CONFLICT",
      `Task ${task.id} is not a project task and cannot accept repository targets.`,
      { details: { taskId: task.id, taskType: task.type } },
    );
  }
};

const allocateRepoDirectoryName = (repoName: string, task: TaskRecord): string => {
  const usedNames = new Set([
    "manifest.json",
    PROJECT_BUNDLE_GUIDE_FILENAME,
    ...(task.repoTargets ?? []).map((target) => path.basename(target.worktreePath)),
  ]);
  const baseName = usedNames.has(repoName) ? `${repoName}-repo` : repoName;
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

const readManifestPrompt = (manifest: string): string | null => {
  try {
    const value = JSON.parse(manifest) as { prompt?: unknown };
    return typeof value.prompt === "string" ? value.prompt : null;
  } catch {
    return null;
  }
};

const rollbackFailedAttachment = async (input: {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  branchAlreadyExisted: boolean;
  manifestPath: string;
  manifestBackup: string;
  guidePath: string;
  guideBackup: string;
}): Promise<unknown[]> => {
  const failures: unknown[] = [];
  await writeFile(input.manifestPath, input.manifestBackup, "utf8").catch((error) => failures.push(error));
  await writeFile(input.guidePath, input.guideBackup, "utf8").catch((error) => failures.push(error));
  const worktreeExists = await access(input.worktreePath).then(() => true).catch(() => false);
  if (worktreeExists) {
    await removeWorktree(input.repoRoot, input.worktreePath).catch(async (error) => {
      failures.push(error);
      await rm(input.worktreePath, { recursive: true, force: true }).catch((removeError) => failures.push(removeError));
    });
  }
  if (!input.branchAlreadyExisted) {
    const createdBranchExists = await branchExists(input.repoRoot, input.branch).catch((error) => {
      failures.push(error);
      return false;
    });
    if (createdBranchExists) {
      await deleteBranch(input.repoRoot, input.branch).catch((error) => failures.push(error));
    }
  }
  return failures;
};

const buildResult = (
  taskId: string,
  repoId: string,
  branch: string,
  worktreePath: string,
  disposition: CommandAddTaskRepoTargetResult["disposition"],
): CommandAddTaskRepoTargetResult => ({
  kind: "addTaskRepoTarget",
  disposition,
  taskId,
  repoId,
  branch,
  worktreePath,
});
