import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";

import { appendEvent, readAllEvents, type CraigEvent } from "../domain/orchestration/index.js";
import { taskService, type TaskPR, type TaskRecord } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { agentStatusService } from "./agent-status.js";
import { atomicWriteJson, readJsonIfExists } from "../shared/atomic-write.js";
import { buildAgentRuntimeStatuses, type AgentRuntimeObserver } from "../domain/agent/index.js";

const actor = { type: "system" as const, component: "heartbeat" as const };

export async function reconcileEvents(
  paths: CraigPaths,
  options: { agentObserver?: AgentRuntimeObserver } = {},
): Promise<CraigEvent[]> {
  await mkdir(paths.orchestrationDir, { recursive: true });
  const [taskResult, observedAgents, existing, storedProjection] = await Promise.all([
    taskService.listTasks(paths, { includeClosed: true }),
    options.agentObserver ? Promise.resolve(null) : agentStatusService.listAgents(paths),
    readAllEvents(paths),
    loadProjection(paths),
  ]);
  const agentResult = observedAgents ?? buildAgentRuntimeStatuses(
    taskResult.tasks.filter((task) => task.status !== "closed"),
    options.agentObserver?.getSnapshots() ?? [],
    Date.now(),
  );
  const projection = validateProjection(storedProjection);
  const projectionNeedsRepair = projection !== storedProjection;
  const appended: CraigEvent[] = [];
  const latestTaskEvents = latestBy(existing.filter(isTaskLifecycleEvent), (event) => event.taskId);
  const latestPrEvents = latestBy(existing.filter((event) => event.type.startsWith("task.pr.")), (event) => event.taskId);
  const latestAgentEvents = latestBy(existing.filter((event) => event.type === "agent.state.changed"), (event) => event.agentTabId);

  for (const task of taskResult.tasks) {
    const taskData = buildTaskData(task);
    const previousTask = latestTaskEvents.get(task.id);
    const previousTaskData = asRecord(previousTask?.data) ?? projection.tasks[task.id] ?? null;
    let taskEventId = previousTask?.id ?? projection.tasks[task.id]?.eventId ?? null;
    if (previousTaskData?.signature !== taskData.signature) {
      const type = !previousTaskData
        ? "task.created"
        : task.status === "closed" && previousTaskData?.status !== "closed"
          ? "task.closed"
          : "task.updated";
      const event = await appendEvent(paths, {
        id: deterministicId(type, task.id, taskData.signature),
        type,
        taskId: task.id,
        workspaceId: task.workspaceId || null,
        occurredAt: task.updatedAt,
        actor,
        data: {
          ...taskData,
          changedFields: previousTaskData ? changedTaskFields(previousTaskData, taskData) : [],
        },
      });
      appended.push(event);
      taskEventId = event.id;
    }
    projection.tasks[task.id] = { ...taskData, eventId: taskEventId };

    const prData = buildPrData(task.prs);
    const previousPr = latestPrEvents.get(task.id);
    const previousPrData = asRecord(previousPr?.data) ?? projection.pullRequests[task.id] ?? null;
    let prEventId = previousPr?.id ?? projection.pullRequests[task.id]?.eventId ?? null;
    if ((previousPrData || prData.associations.length > 0) && previousPrData?.signature !== prData.signature) {
      const previousCount = Array.isArray(previousPrData?.associations) ? previousPrData.associations.length : 0;
      const type = prData.associations.length > previousCount
        ? "task.pr.linked"
        : prData.associations.length < previousCount
          ? "task.pr.unlinked"
          : "task.pr.refreshed";
      const event = await appendEvent(paths, {
        id: deterministicId(type, task.id, prData.signature),
        type,
        taskId: task.id,
        workspaceId: task.workspaceId || null,
        occurredAt: task.updatedAt,
        actor,
        data: prData,
      });
      appended.push(event);
      prEventId = event.id;
    }
    projection.pullRequests[task.id] = { ...prData, eventId: prEventId };
  }

  const taskStates = new Map(agentResult.tasks.map((task) => [task.taskId, task.state]));
  for (const agent of agentResult.agents) {
    const previous = latestAgentEvents.get(agent.tabId);
    const previousData = asRecord(previous?.data) ?? projection.agents[agent.tabId] ?? null;
    if (previousData?.state === agent.state) {
      projection.agents[agent.tabId] = {
        state: agent.state,
        eventId: previous?.id ?? projection.agents[agent.tabId]?.eventId ?? null,
      };
      continue;
    }
    const transitionKey = [
      previous?.id ?? projection.agents[agent.tabId]?.eventId ?? "initial",
      agent.state,
      agent.sessionState ?? "none",
      agent.lastActivityAt ?? "none",
      agent.exitCode ?? "none",
      agent.error ?? "none",
    ].join(":");
    const event = await appendEvent(paths, {
      id: deterministicId("agent.state.changed", agent.tabId, transitionKey),
      type: "agent.state.changed",
      taskId: agent.taskId,
      agentTabId: agent.tabId,
      actor,
      data: {
        previousState: typeof previousData?.state === "string" ? previousData.state : null,
        state: agent.state,
        taskState: taskStates.get(agent.taskId) ?? "idle",
        sessionState: agent.sessionState,
        lastActivityAt: agent.lastActivityAt,
        exitCode: agent.exitCode,
        error: agent.error,
      },
    });
    appended.push(event);
    projection.agents[agent.tabId] = { state: agent.state, eventId: event.id };
  }
  if (appended.length > 0 || projectionNeedsRepair) {
    await atomicWriteJson(projectionPath(paths), projection);
  }
  return appended;
}

interface ReconciliationProjection {
  schemaVersion: 1;
  tasks: Record<string, { signature: string; status: string; eventId: string | null; [key: string]: unknown }>;
  pullRequests: Record<string, {
    signature: string;
    associations: unknown[];
    eventId: string | null;
    [key: string]: unknown;
  }>;
  agents: Record<string, { state: string; eventId: string | null }>;
}

function buildTaskData(task: TaskRecord) {
  const source = {
    status: task.status,
    title: task.title,
    runner: task.runner,
    branch: task.branch,
    lastCommitSha: task.lastCommit?.sha ?? null,
    checksStatus: task.checks.status,
    checksLastRunAt: task.checks.lastRunAt,
    sourceUpdatedAt: task.updatedAt,
    agentTabIds: task.ptyTabs.filter((tab) => tab.kind === "agent").map((tab) => tab.id),
  };
  return { ...source, signature: signature(source) };
}

const SEMANTIC_TASK_FIELDS = [
  "status",
  "title",
  "runner",
  "branch",
  "lastCommitSha",
  "checksStatus",
  "checksLastRunAt",
  "agentTabIds",
] as const;

function changedTaskFields(previous: Record<string, unknown>, current: Record<string, unknown>): string[] {
  return SEMANTIC_TASK_FIELDS.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]));
}

function buildPrData(prs: TaskPR[]) {
  const associations = prs.map((pr) => ({
    provider: pr.provider,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    status: pr.status,
    draft: pr.draft,
    headBranch: pr.headBranch,
    lastSyncedAt: pr.lastSyncedAt,
    lastSyncedHeadSha: pr.lastSyncedHeadSha,
  }));
  return { associations, signature: signature(associations) };
}

function latestBy(
  events: CraigEvent[],
  /* eslint-disable-next-line no-unused-vars */
  key: (event: CraigEvent) => string | null,
): Map<string, CraigEvent> {
  const result = new Map<string, CraigEvent>();
  for (const event of events) {
    const value = key(event);
    if (value) result.set(value, event);
  }
  return result;
}

const isTaskLifecycleEvent = (event: CraigEvent) =>
  event.type === "task.created" || event.type === "task.updated" || event.type === "task.closed";

const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deterministicId = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const projectionPath = (paths: CraigPaths) => path.join(paths.orchestrationDir, "event-reconciliation.json");

function validateProjection(value: ReconciliationProjection | null): ReconciliationProjection {
  if (
    value?.schemaVersion === 1 &&
    typeof value.tasks === "object" && value.tasks !== null &&
    typeof value.pullRequests === "object" && value.pullRequests !== null &&
    typeof value.agents === "object" && value.agents !== null
  ) return value;
  return { schemaVersion: 1, tasks: {}, pullRequests: {}, agents: {} };
}

async function loadProjection(paths: CraigPaths): Promise<ReconciliationProjection | null> {
  try {
    return await readJsonIfExists<ReconciliationProjection>(projectionPath(paths));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
