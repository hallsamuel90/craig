import { realpath } from "node:fs/promises";
import path from "node:path";

import { CraigError } from "../../error/index.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import type { ResolvedTaskContext, TaskContextSource, TaskRecord } from "../types.js";
import { getTask } from "./inspect.js";
import { listTasks } from "./list.js";

export interface ResolveTaskContextInput {
  cwd: string;
  explicitTaskId?: string;
  environmentTaskId?: string;
  environmentAgentTabId?: string;
  required?: boolean;
}

export async function resolveTaskContext(
  paths: CraigPaths,
  input: ResolveTaskContextInput,
): Promise<ResolvedTaskContext | null> {
  if (input.explicitTaskId !== undefined) {
    const task = await requireTask(paths, input.explicitTaskId, "explicit");
    return buildResolvedTask(task, "explicit", input.environmentAgentTabId);
  }

  if (input.environmentTaskId !== undefined) {
    const task = await requireTask(paths, input.environmentTaskId, "environment");
    return buildResolvedTask(task, "environment", input.environmentAgentTabId);
  }

  const cwd = await realpath(input.cwd).catch(() => path.resolve(input.cwd));
  const listed = await listTasks(paths, { includeClosed: true });
  const matchingTasks = await Promise.all(
    listed.tasks.map(async (task) => ({
      task,
      matches: await taskMatchesCwd(task, cwd),
    })),
  );
  const matches = matchingTasks.filter((entry) => entry.matches).map((entry) => entry.task);
  const uniqueMatches = [...new Map(matches.map((task) => [task.id, task])).values()];

  if (uniqueMatches.length > 1) {
    throw new CraigError(
      "TASK_CONTEXT_AMBIGUOUS",
      `Multiple Craig tasks match ${cwd}: ${uniqueMatches.map((task) => task.id).join(", ")}. Use --task <id>.`,
      {
        details: { cwd, taskIds: uniqueMatches.map((task) => task.id) },
      },
    );
  }

  const task = uniqueMatches[0];
  if (task) {
    return buildResolvedTask(task, "cwd", input.environmentAgentTabId);
  }

  if (input.environmentAgentTabId !== undefined) {
    throw new CraigError(
      "TASK_CONTEXT_CONFLICT",
      `CRAIG_AGENT_TAB_ID is set to ${input.environmentAgentTabId}, but no task context could be resolved.`,
      { details: { agentTabId: input.environmentAgentTabId } },
    );
  }

  if (input.required) {
    throw new CraigError(
      "TASK_CONTEXT_NOT_FOUND",
      `No Craig task was found from ${cwd}. Use --task <id> or run the command inside a task worktree.`,
      { details: { cwd } },
    );
  }

  return null;
}

async function requireTask(
  paths: CraigPaths,
  taskId: string,
  source: Extract<TaskContextSource, "explicit" | "environment">,
): Promise<TaskRecord> {
  try {
    return await getTask(paths, taskId);
  } catch (error) {
    if (!(error instanceof CraigError) || error.code !== "TASK_NOT_FOUND") {
      throw error;
    }
    throw new CraigError(
      "TASK_CONTEXT_NOT_FOUND",
      `Craig task "${taskId}" from ${source === "explicit" ? "--task" : "CRAIG_TASK_ID"} was not found.`,
      { details: { taskId, source }, cause: error },
    );
  }
}

function buildResolvedTask(
  task: TaskRecord,
  source: TaskContextSource,
  environmentAgentTabId: string | undefined,
): ResolvedTaskContext {
  const agentTabId = environmentAgentTabId ?? null;

  if (agentTabId !== null) {
    const tab = task.ptyTabs.find((entry) => entry.id === agentTabId);
    if (!tab || tab.kind !== "agent") {
      throw new CraigError(
        "TASK_CONTEXT_CONFLICT",
        `Agent tab ${agentTabId} does not belong to Craig task ${task.id}.`,
        { details: { taskId: task.id, agentTabId } },
      );
    }
  }

  return { task, source, agentTabId };
}

function getTaskContextRoots(task: TaskRecord): string[] {
  return [
    task.worktreePath,
    ...(task.bundlePath ? [task.bundlePath] : []),
    ...(task.repoTargets ?? []).map((target) => target.worktreePath),
  ];
}

async function taskMatchesCwd(task: TaskRecord, cwd: string): Promise<boolean> {
  const roots = await Promise.all(
    getTaskContextRoots(task).map((root) => realpath(root).catch(() => path.resolve(root))),
  );
  return roots.some((root) => isPathWithin(root, cwd));
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
