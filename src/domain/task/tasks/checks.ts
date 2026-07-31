import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CommandChecksResult } from "../types.js";
import type { TaskCheckResult } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { configService } from "../../config/index.js";
import { mutateTask } from "../adapters/task-store.js";
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

  await mutateTask(paths, task.id, (current) => ({
    ...current,
    status: current.status === "running" ? task.status : current.status,
    checks: {
      ...current.checks,
      status: "running",
      commands: [...commands],
      results: [],
    },
  }));

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
      const lastFailureReason =
        execution.stderr.trim() ||
        execution.stdout.trim() ||
        `Check command failed: ${command}`;
      const failedTask = await mutateTask(paths, task.id, (current) => ({
        ...current,
        status: "review",
        checks: {
          ...current.checks,
          results,
          status: "failed",
          lastRunAt: finishedAt,
        },
        lastFailureReason,
      }));
      await writeCheckSummary(paths, failedTask);

      return {
        kind: "runChecks",
        taskId: task.id,
        status: "failed",
        commands,
      };
    }
  }

  const passedTask = await mutateTask(paths, task.id, (current) => ({
    ...current,
    status: current.status === "review" || current.status === "checked"
      ? "checked"
      : current.status,
    checks: {
      ...current.checks,
      results,
      status: "passed",
      lastRunAt: new Date().toISOString(),
    },
    lastFailureReason: null,
  }));
  await writeCheckSummary(paths, passedTask);

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
