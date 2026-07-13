import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CommandChecksResult } from "../types.js";
import type { TaskCheckResult } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { configService } from "../../config/index.js";
import { writeTask } from "../adapters/task-store.js";
import { hasUncommittedDiff } from "../adapters/git.js";
import { getTask, assertTaskWorktreeExists } from "./inspect.js";
import { resolveArtifactPath } from "./artifacts.js";
import { runCommandAllowingFailure } from "../../../shared/exec.js";

export const runChecks = async (paths: CraigPaths, taskId: string): Promise<CommandChecksResult> => {
  const task = await getTask(paths, taskId);
  await assertTaskWorktreeExists(task);

  if (task.status === "draft" || task.status === "merged") {
    throw new Error(`Task ${task.id} cannot run checks from status "${task.status}".`);
  }

  if (task.status === "running" && (await hasUncommittedDiff(task.worktreePath))) {
    task.status = "review";
  }

  if (task.status !== "review" && task.status !== "checked") {
    throw new Error(`Task ${task.id} cannot run checks from status "${task.status}".`);
  }

  const config = await configService.load(paths);
  const commands = config.checks?.commands ?? [];

  if (commands.length === 0) {
    throw new Error(`Craig config at ${paths.configFile} does not define any "checks.commands".`);
  }

  task.checks.status = "running";
  task.checks.commands = [...commands];
  task.checks.results = [];
  await writeTask(paths, task);

  const results: TaskCheckResult[] = [];

  for (const command of commands) {
    const startedAt = new Date().toISOString();
    const execution = await runCommandAllowingFailure("sh", ["-lc", command], {
      cwd: task.worktreePath,
    });
    const finishedAt = new Date().toISOString();
    const exitCode = execution.exitCode ?? 1;

    results.push({
      command,
      startedAt,
      finishedAt,
      exitCode,
    });

    if (exitCode !== 0) {
      task.checks.results = results;
      task.checks.status = "failed";
      task.checks.lastRunAt = finishedAt;
      task.status = "review";
      task.lastFailureReason =
        execution.stderr.trim() ||
        execution.stdout.trim() ||
        `Check command failed: ${command}`;
      await writeCheckSummary(paths, task);
      await writeTask(paths, task);

      return {
        kind: "runChecks",
        taskId: task.id,
        status: "failed",
        commands,
      };
    }
  }

  task.checks.results = results;
  task.checks.status = "passed";
  task.checks.lastRunAt = new Date().toISOString();
  task.status = "checked";
  task.lastFailureReason = null;

  await writeCheckSummary(paths, task);
  await writeTask(paths, task);

  return {
    kind: "runChecks",
    taskId: task.id,
    status: "passed",
    commands,
  };
};

const writeCheckSummary = async (paths: CraigPaths, task: Awaited<ReturnType<typeof getTask>>) => {
  const artifactPath = resolveArtifactPath(paths, task.artifacts.checkSummaryPath);

  if (!artifactPath) {
    return;
  }

  await mkdir(path.dirname(artifactPath), { recursive: true });
  await atomicWriteJson(artifactPath, {
    taskId: task.id,
    status: task.checks.status,
    lastRunAt: task.checks.lastRunAt,
    commands: task.checks.commands,
    results: task.checks.results,
  });
};
