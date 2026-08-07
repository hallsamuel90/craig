import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";
import { configService } from "../../config/index.js";
import { taskService, type CommandCreateTaskResult, type TaskRecord } from "../../task/index.js";
import { appendEvent } from "../events/journal.js";
import type { CraigActor } from "../types.js";
import { withDelegationLock } from "../adapters/delegation-lock.js";
import { authorizeCapability, ensureTaskCapabilities, revokeTaskCapabilities } from "./capabilities.js";
import type {
  AgentCapabilityRecord,
  CommandCancelTreeResult,
  CommandCreateChildResult,
  CommandListChildrenResult,
  CreateChildInput,
} from "./types.js";

const HUMAN_LIMITS: AgentCapabilityRecord["limits"] = {
  maxChildren: 32,
  maxDepth: 8,
  maxConcurrentChildren: 16,
  maxPromptBytes: 32 * 1024,
};

export async function createRootTask(
  paths: CraigPaths,
  repoIdOrWorkspaceId: string,
  prompt: string,
  options: Parameters<typeof taskService.createTask>[3] = {},
): Promise<CommandCreateTaskResult> {
  const config = await configService.load(paths);
  if (!configService.previews.isEnabled(config, "agentOrchestration")) {
    return taskService.createTask(paths, repoIdOrWorkspaceId, prompt, options);
  }
  return taskService.createTask(paths, repoIdOrWorkspaceId, prompt, {
    ...options,
    onProvisioned: async (task) => ({
      CRAIG_WORKSPACE_ROOT: paths.workspaceRoot,
      CRAIG_TASK_ID: task.id,
      CRAIG_AGENT_TAB_ID: task.ptyTabs.find((tab) => tab.kind === "agent")?.id ?? "",
      ...await ensureTaskCapabilities(paths, task, { type: "human", source: "cli", processId: process.pid }),
    }),
  });
}

export async function createChildTask(paths: CraigPaths, input: CreateChildInput): Promise<CommandCreateChildResult> {
  return withDelegationLock(paths, async () => {
    const parent = await taskService.getTask(paths, input.parentTaskId);
    const authorization = input.capabilityId
      ? await authorizeCapability(paths, input.capabilityId, "task.create-child", parent.id)
      : null;
    const actor: CraigActor = authorization?.actor ?? { type: "human", source: "cli", processId: process.pid };
    const limits = authorization?.capability.limits ?? HUMAN_LIMITS;
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new CraigError("CLI_USAGE", "Child task prompt cannot be empty.", {});
    if (Buffer.byteLength(prompt) > limits.maxPromptBytes) limit("prompt bytes", limits.maxPromptBytes);
    if (parent.delegationDepth + 1 > limits.maxDepth) limit("delegation depth", limits.maxDepth);
    const allowedRepoIds = new Set([parent.repoId, ...parent.linkedRepoIds, ...(parent.repoTargets ?? []).map((target) => target.repoId)]);
    if (!allowedRepoIds.has(input.repoId)) {
      throw new CraigError("CAPABILITY_DENIED", `Repo ${input.repoId} is outside parent task ${parent.id}.`, {
        details: { parentTaskId: parent.id, repoId: input.repoId },
      });
    }

    const allTasks = (await taskService.listTasks(paths, { includeClosed: true })).tasks;
    const children = allTasks.filter((task) => task.parentTaskId === parent.id);
    const key = input.idempotencyKey?.trim() || null;
    if (key) {
      if (key.length > 256) throw new CraigError("CLI_USAGE", "Idempotency key exceeds 256 characters.", {});
      const existing = children.find((task) => task.delegationIdempotencyKey === key);
      if (existing) {
        if (existing.repoId !== input.repoId || existing.prompt.value !== prompt || (input.runner && existing.runner !== input.runner)) {
          throw new CraigError("COMMAND_STATE_CONFLICT", `Idempotency key "${key}" is already used by child ${existing.id}.`, {
            details: { idempotencyKey: key, taskId: existing.id },
          });
        }
        return childResult(existing, true);
      }
    }
    if (children.length >= limits.maxChildren) limit("children", limits.maxChildren);
    const activeChildren = children.filter((task) => task.status !== "closed" && task.status !== "merged");
    if (activeChildren.length >= limits.maxConcurrentChildren) limit("concurrent children", limits.maxConcurrentChildren);

    const created = await taskService.createTask(paths, input.repoId, prompt, {
      ...(input.runner ? { runner: input.runner } : {}),
      lineage: {
        parentTaskId: parent.id,
        rootTaskId: parent.rootTaskId,
        delegationDepth: parent.delegationDepth + 1,
        delegationIdempotencyKey: key,
        swarmRunId: parent.swarmRunId,
        swarmStepId: null,
      },
      onProvisioned: async (task) => ({
        CRAIG_WORKSPACE_ROOT: paths.workspaceRoot,
        CRAIG_TASK_ID: task.id,
        CRAIG_AGENT_TAB_ID: task.ptyTabs.find((tab) => tab.kind === "agent")?.id ?? "",
        ...await ensureTaskCapabilities(paths, task, actor),
      }),
    });
    const child = await taskService.getTask(paths, created.taskId);
    try {
      await appendEvent(paths, {
        workspaceId: child.workspaceId,
        taskId: child.id,
        agentTabId: actor.type === "agent" ? actor.agentTabId : null,
        type: "task.child.created",
        actor,
        data: { parentTaskId: parent.id, rootTaskId: child.rootTaskId, delegationDepth: child.delegationDepth },
      });
    } catch (error) {
      throw new CraigError("PARTIAL_RESULT", `Child ${child.id} was created, but its audit event could not be recorded.`, {
        details: { taskId: child.id, parentTaskId: parent.id, persisted: true },
        cause: error,
      });
    }
    return childResult(child, false);
  });
}

export async function listTaskChildren(
  paths: CraigPaths,
  taskId: string,
  capabilityId?: string,
): Promise<CommandListChildrenResult> {
  if (capabilityId) await authorizeCapability(paths, capabilityId, "task.children", taskId);
  await taskService.getTask(paths, taskId);
  const tasks = (await taskService.listTasks(paths, { includeClosed: true })).tasks
    .filter((task) => task.parentTaskId === taskId)
    .sort((left, right) => left.id.localeCompare(right.id));
  return { kind: "listTaskChildren", taskId, children: tasks };
}

export async function cancelTaskTree(
  paths: CraigPaths,
  taskId: string,
  capabilityId?: string,
): Promise<CommandCancelTreeResult> {
  return withDelegationLock(paths, async () => {
    const authorization = capabilityId
      ? await authorizeCapability(paths, capabilityId, "task.cancel-tree", taskId)
      : null;
    const actor: CraigActor = authorization?.actor ?? { type: "human", source: "cli", processId: process.pid };
    await taskService.getTask(paths, taskId);
    const allTasks = (await taskService.listTasks(paths, { includeClosed: true })).tasks;
    const byId = new Map(allTasks.map((task) => [task.id, task]));
    const byParent = new Map<string, TaskRecord[]>();
    for (const task of allTasks) {
      if (!task.parentTaskId) continue;
      byParent.set(task.parentTaskId, [...(byParent.get(task.parentTaskId) ?? []), task]);
    }
    const ordered: TaskRecord[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) {
        throw new CraigError("TASK_RECORD_INVALID", `Task lineage contains a cycle at ${id}.`, {
          details: { taskId: id, rootTaskId: taskId },
        });
      }
      const task = byId.get(id);
      if (!task) return;
      visited.add(id);
      ordered.push(task);
      for (const child of (byParent.get(id) ?? []).sort((left, right) => left.id.localeCompare(right.id))) visit(child.id);
    };
    visit(taskId);
    const cancelled: CommandCancelTreeResult["cancelled"] = [];
    const auditFailures: string[] = [];
    const revocationFailures: string[] = [];
    try {
      await revokeTaskCapabilities(paths, new Set(ordered.map((task) => task.id)), actor);
    } catch {
      revocationFailures.push(...ordered.map((task) => task.id));
    }
    for (const task of ordered) {
      const previousStatus = task.status;
      if (previousStatus === "closed") {
        cancelled.push({ taskId: task.id, previousStatus, status: "closed", disposition: "already-closed" });
        continue;
      }
      await taskService.cleanupTask(paths, task, { preserveWorktree: true });
      const closed = await taskService.closeTask(paths, task.id);
      cancelled.push({ taskId: task.id, previousStatus, status: closed.status, disposition: "cancelled" });
      try {
        await appendEvent(paths, {
          workspaceId: task.workspaceId,
          taskId: task.id,
          type: "task.tree.cancelled",
          actor,
          data: { rootTaskId: taskId, previousStatus },
        });
      } catch {
        auditFailures.push(task.id);
      }
    }
    if (auditFailures.length > 0 || revocationFailures.length > 0) {
      throw new CraigError("PARTIAL_RESULT", "The task tree was cancelled, but some audit or capability updates failed.", {
        details: { taskId, cancelled, auditFailures, revocationFailures, persisted: true },
      });
    }
    return { kind: "cancelTaskTree", taskId, cancelled };
  });
}

function childResult(task: TaskRecord, idempotentReplay: boolean): CommandCreateChildResult {
  return {
    kind: "createChildTask",
    taskId: task.id,
    parentTaskId: task.parentTaskId!,
    rootTaskId: task.rootTaskId,
    delegationDepth: task.delegationDepth,
    repoId: task.repoId,
    workspaceId: task.workspaceId,
    sessionId: task.sessionId,
    status: task.status,
    branch: task.branch,
    worktreePath: task.worktreePath,
    runner: task.runner,
    idempotentReplay,
  };
}

function limit(name: string, maximum: number): never {
  throw new CraigError("DELEGATION_LIMIT_EXCEEDED", `Delegation ${name} limit of ${maximum} was exceeded.`, {
    details: { limit: name, maximum },
  });
}
