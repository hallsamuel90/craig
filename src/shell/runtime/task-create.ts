import { lstat } from "node:fs/promises";
import path from "node:path";
import { readRepo, listWorkspaceRecords } from "../../domain/workspace/index.js";
import { RuntimeAcknowledgementUncertainError } from "../../domain/runtime/errors.js";
import { randomUUID } from "node:crypto";
import type { CraigPaths } from "../../state/craig-paths.js";
import { taskService, type TaskCreationOptions, type CommandCreateTaskResult, type TaskRecord } from "../../domain/task/index.js";
import { createChildTask, createRootTask, ensureTaskCapabilities, promptCommandService, authorizeCapability, type CreateChildInput, type CommandCreateChildResult } from "../../domain/orchestration/index.js";
import { listTaskCreateOperations, readTaskCreateOperation, writeTaskCreateOperation, taskCreateRequestDigest, type TaskCreateOperation } from "../../domain/runtime/task-create/store.js";
import { buildEmbeddedAgentCommand } from "../agent-command.js";
import type { HostClient } from "./host-client.js";

export type TaskCreateRequest =
  | { kind: "root"; targetId: string; prompt: string; options?: Pick<TaskCreationOptions, "runner" | "workspaceId" | "owningWorkspaceId" | "allowLinkedProjectRepo"> }
  | { kind: "child"; input: CreateChildInput };
export type TaskCreateResult = CommandCreateTaskResult | CommandCreateChildResult;

export interface TaskCreateAdmissionPorts {
  // eslint-disable-next-line no-unused-vars
  checkpoint?: (stage: TaskCreateOperation["state"] | "provisioning_files" | "spawned" | "task_started", operation: TaskCreateOperation) => Promise<void>;
}
export class TaskCreateAdmission {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<TaskCreateResult>>();
  // eslint-disable-next-line no-unused-vars
  constructor(private readonly paths: CraigPaths, private readonly host: HostClient, private readonly ports: TaskCreateAdmissionPorts = {}) {}
  submit(operationId: string, request: TaskCreateRequest): Promise<TaskCreateResult> {
    const existing = this.pending.get(operationId); if (existing) return existing.then(async (result) => {
      const record = await readTaskCreateOperation(this.paths, operationId);
      if (record?.requestDigest !== taskCreateRequestDigest(request)) throw new Error("Operation id was reused with different inputs.");
      return result;
    });
    const job = this.chain.then(() => this.execute(operationId, request));
    this.chain = job.catch(() => undefined); this.pending.set(operationId, job);
    void job.finally(() => this.pending.delete(operationId)).catch(() => undefined);
    return job;
  }
  get pendingCount(): number { return this.pending.size; }
  async inspect(operationId: string): Promise<TaskCreateOperation | null> { return readTaskCreateOperation(this.paths, operationId); }
  private async execute(operationId: string, request: TaskCreateRequest): Promise<TaskCreateResult> {
    if (request.kind === "child" && request.input.capabilityId) await authorizeCapability(this.paths, request.input.capabilityId, "task.create-child", request.input.parentTaskId);
    const digest = taskCreateRequestDigest(request);
    let operation = await readTaskCreateOperation(this.paths, operationId);
    if (operation && operation.requestDigest !== digest) throw new Error("Operation id was reused with different inputs.");
    if (operation?.state === "completed") return operation.result!;
    if (operation?.state === "failed" || operation?.state === "recovery_required") throw new Error(`${operation.state}: operation ${operationId}, task ${operation.taskId}: ${operation.error ?? "Inspect existing work before proceeding."}`);
    if (!operation) {
      // Validate read-only inputs before reserving identities. Domain provisioning
      // retains authority over repo/lineage/capability validation.
      const prompt = request.kind === "root" ? request.prompt : request.input.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Task prompt cannot be empty.");
      const reserved = new Set((await listTaskCreateOperations(this.paths)).map((entry) => entry.taskId));
      const existing = request.kind === "child" && request.input.idempotencyKey ? (await taskService.listTasks(this.paths, { includeClosed: true })).tasks.find((task) => task.parentTaskId === request.input.parentTaskId && task.delegationIdempotencyKey === request.input.idempotencyKey!.trim()) : undefined;
      const parent = request.kind === "child" ? await taskService.getTask(this.paths, request.input.parentTaskId) : null;
      const workspaceId = request.kind === "root" ? request.options?.workspaceId : request.input.workspaceId ?? (!request.input.repoId && parent?.type === "project" ? parent.workspaceId : undefined);
      let repoId = request.kind === "root" ? request.targetId : request.input.repoId ?? parent!.repoId;
      let project = false;
      if (workspaceId) {
        const workspace = (await listWorkspaceRecords(this.paths)).find((entry) => entry.id === workspaceId && entry.status === "active");
        if (!workspace) throw new Error("Task target workspace is unavailable.");
        project = workspace.kind === "project"; repoId = workspace.primaryRepoId ?? repoId;
      }
      const taskId = existing?.id ?? (project ? await taskService.allocateProjectTaskId(this.paths, [...reserved]) : await taskService.allocateTaskIdForRepo(this.paths, (await readRepo(this.paths, repoId)).rootPath, [...reserved]));
      const existingSession = existing ? await this.host.lookup(existing.id, existing.ptyTabs.find((tab) => tab.kind === "agent")?.id ?? `${taskId}:agent`) : null;
      operation = { schemaVersion: 1, operationId, requestDigest: digest, taskId, agentTabId: existingSession?.tabId ?? `${taskId}:agent`, creationId: existingSession?.creationId ?? randomUUID(), sessionId: existingSession?.sessionId ?? randomUUID(), hostId: this.host.host.instanceId, state: "admitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeTaskCreateOperation(this.paths, operation);
      await this.host.request({ type: "reserveCreation", reservationId: operationId, session: { taskId: operation.taskId, tabId: operation.agentTabId, sessionId: operation.sessionId, creationId: operation.creationId } });
      await this.ports.checkpoint?.("admitted", operation);
    }
    const record = operation;
    let completionPersisted = false;
    const transition = async (state: TaskCreateOperation["state"]) => { record.state = state; await writeTaskCreateOperation(this.paths, record); if (state === "completed") completionPersisted = true; await this.ports.checkpoint?.(state, record); };
    const launch = async (task: TaskRecord, environment?: Record<string, string>) => {
      await transition("launching");
      const tab = task.ptyTabs.find((entry) => entry.kind === "agent"); if (!tab || tab.id !== record.agentTabId) throw new Error("Reserved task/session identity mismatch.");
      const route = await this.host.ensure(task.id, tab.id, { columns: 120, rows: 36 }, { cwd: task.worktreePath, command: buildEmbeddedAgentCommand(request.kind === "child" ? tab.command : task.runnerSession.command, task.runner), ...(environment ? { env: environment } : {}) }, { creationId: record.creationId, sessionId: record.sessionId });
      await this.ports.checkpoint?.("spawned", record);
      const retainedView = await this.host.acquireView(route, { viewId: `creation:${record.creationId}`, proof: record.operationId });
      record.creationViewToken = retainedView.token!;
      await writeTaskCreateOperation(this.paths, record);
      if (request.kind === "child") await promptCommandService.create(this.paths, { taskId: task.id, agentTabId: tab.id, prompt: { source: "inline", text: task.prompt.value }, delivery: "when-ready", timeoutMs: 60000, idempotencyKey: `task-start:${task.id}`, actor: { type: "system", component: "orchestration-supervisor" } });
    };
    if (record.state === "provisioning") {
      record.error = "Provisioning was interrupted with an ambiguous Git/filesystem outcome. Existing worktree and task were preserved.";
      await transition("recovery_required"); throw new Error(`recovery_required: operation ${record.operationId}, task ${record.taskId}`);
    }
    try {
      let result: TaskCreateResult;
      if (record.state === "provisioned" || record.state === "launching") {
        const task = await taskService.getTask(this.paths, record.taskId);
        // Inventory/route deduplication in the host recovers spawn-before-ack.
        await launch(task, { CRAIG_WORKSPACE_ROOT: this.paths.workspaceRoot, CRAIG_TASK_ID: task.id, CRAIG_AGENT_TAB_ID: record.agentTabId, ...(task.furyRunId ? { CRAIG_FURY_RUN_ID: task.furyRunId } : {}), ...(task.furyStepId ? { CRAIG_FURY_STEP_ID: task.furyStepId } : {}), ...await ensureTaskCapabilities(this.paths, task) });
        const started = request.kind === "child" ? await taskService.getTask(this.paths, task.id) : await taskService.markTaskStarted(this.paths, task.id);
        result = { kind: "createTask", taskId: started.id, repoId: started.repoId, workspaceId: started.workspaceId, agentTabId: record.agentTabId, status: started.status, branch: started.branch, worktreePath: started.worktreePath, runner: started.runner };
        if (request.kind === "child") result = { kind: "createChildTask", taskId: started.id, parentTaskId: started.parentTaskId!, rootTaskId: started.rootTaskId, delegationDepth: started.delegationDepth, targetType: request.input.workspaceId ? "workspace" : "repo", targetId: request.input.workspaceId ?? request.input.repoId ?? started.repoId, repoId: started.repoId, workspaceId: started.workspaceId, agentTabId: record.agentTabId, status: started.status, branch: started.branch, worktreePath: started.worktreePath, runner: started.runner, idempotentReplay: true };
      } else {
        await transition("provisioning");
        const createOptions = (options: TaskCreationOptions = {}): TaskCreationOptions => ({ ...options, reservedTaskId: record.taskId,
          onProvisioningStarted: async () => { await this.ports.checkpoint?.("provisioning_files", record); },
          onLaunchRecorded: async () => { await this.ports.checkpoint?.("task_started", record); },
          onProvisioned: async (task) => { await transition("provisioned"); return options.onProvisioned?.(task); }, launchProvisioned: launch });
        if (request.kind === "root") result = await createRootTask(this.paths, request.targetId, request.prompt, createOptions(request.options));
        else result = await createChildTask(this.paths, request.input, { createTask: (paths, targetId, prompt, options) => taskService.createTask(paths, targetId, prompt, { ...createOptions(options), markStartedAfterLaunch: false }) });
      }
      record.result = result; await transition("completed"); await this.host.request({ type: "completeCreation", creationId: record.creationId, reservationId: record.operationId }); return result;
    } catch (error) {
      if (completionPersisted) return record.result!; // Lost reservation-release ack cannot undo a durable result.
      // A lost host acknowledgement after spawn is recoverable, never a fresh
      // task creation. Keep the original launch identity for inspect/resubmit.
      if (record.state === "launching" && error instanceof RuntimeAcknowledgementUncertainError) throw new RuntimeAcknowledgementUncertainError(`Operation ${record.operationId} for task ${record.taskId} requires inspection; launch acknowledgement was lost. ${error instanceof Error ? error.message : ""}`);
      record.error = error instanceof Error ? error.message : "Task creation failed.";
      if ((await readTaskCreateOperation(this.paths, record.operationId))?.state === "provisioning") {
        const task = await taskService.getTask(this.paths, record.taskId).catch(() => null);
        const footprint = await lstat(task?.worktreePath ?? path.join(this.paths.craigDir, "task-bundles", record.taskId)).catch(() => null);
        if (footprint) { await transition("recovery_required"); throw new Error(`recovery_required: operation ${record.operationId}, task ${record.taskId}; partial provisioning preserved. ${record.error}`); }
      }
      await transition("failed"); await this.host.request({ type: "completeCreation", creationId: record.creationId, reservationId: record.operationId }); throw new Error(`Task-create operation ${record.operationId} failed for task ${record.taskId}: ${record.error}`);
    }
  }
}
