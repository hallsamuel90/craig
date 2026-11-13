import { CraigError } from "../../domain/error/index.js";
import { RuntimeAcknowledgementUncertainError } from "../../domain/runtime/errors.js";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import type { PtyActivitySnapshot } from "../../domain/agent/index.js";
import { refreshAgentCapability, getExistingTaskAgentCapability, type AgentCapabilitySession } from "../../domain/orchestration/index.js";
import { taskService } from "../../domain/task/index.js";
import type { RunnerType } from "../../domain/config/index.js";
import { findRunnerStartupBlocker } from "../prompt-delivery.js";
import type { TerminalViewState } from "./terminal/types.js";
import type { PtySessionSpec, PtySize } from "./session-core.js";
import { readPrivateRecord, writePrivateRecord, workspaceRuntimeId, type RuntimeRecord } from "./records.js";
import { RuntimeTransport, type RuntimeFrame } from "./wire.js";

export interface SessionRoute { taskId: string; tabId: string; sessionId: string; creationId: string; hostId: string; disposed?: boolean }
export interface LogicalView { viewId: string; proof: string; token?: string }
interface HostFact extends SessionRoute { pid: number; status: string }

export class HostClient {
  private transport: RuntimeTransport | undefined;
  private facts: HostFact[] = [];
  private activities: PtyActivitySnapshot[] = [];
  private refresh: Promise<void> | undefined;
  // eslint-disable-next-line no-unused-vars
  constructor(readonly paths: CraigPaths, readonly host: RuntimeRecord, readonly controller: RuntimeRecord, private readonly changed?: (tabIds: string[]) => void) {}
  async connect(): Promise<void> {
    const workspaceId = await workspaceRuntimeId(this.paths);
    if (this.host.schemaVersion !== 1 || this.controller.schemaVersion !== 1 || this.host.role !== "host" || this.controller.role !== "control" || this.host.workspaceId !== workspaceId || this.controller.workspaceId !== workspaceId) throw new Error("Cross-workspace runtime registration rejected.");
    this.transport = await RuntimeTransport.connect(this.host.endpoint, (frame) => {
      if (frame.type !== "changed" || frame.instanceId !== this.host.instanceId) return;
      const previousTabs = this.facts.map((fact) => fact.tabId);
      void this.refreshInventory().then(() => this.changed?.([...new Set([...previousTabs, ...this.facts.map((fact) => fact.tabId)])])).catch(() => undefined);
    });
    await this.request({ type: "registerController", controllerPid: this.controller.pid });
    await this.refreshInventory();
    await this.request({ type: "subscribe" });
  }
  async request(frame: RuntimeFrame, timeoutMs?: number): Promise<RuntimeFrame> {
    if (!this.transport) throw new Error("Host transport unavailable; sessions are preserved.");
    return this.transport.request({ ...frame, credential: this.host.credential, workspaceId: this.host.workspaceId, instanceId: this.host.instanceId, controllerId: this.controller.instanceId }, timeoutMs);
  }
  async refreshInventory(): Promise<void> {
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const response = await this.request({ type: "enumerate" });
      if (response.hostProtocol !== 1 || response.instanceId !== this.host.instanceId || !Array.isArray(response.sessions) || !Array.isArray(response.activities)) throw new Error("Unverifiable host inventory.");
      this.facts = (response.sessions as HostFact[]).map((fact) => ({ ...fact, hostId: this.host.instanceId })); this.activities = response.activities as PtyActivitySnapshot[];
    })().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
  async lookup(taskId: string, tabId: string): Promise<SessionRoute | null> {
    await this.refreshInventory();
    return this.facts.find((fact) => fact.taskId === taskId && fact.tabId === tabId) ?? null;
  }
  private routePath(tabId: string): string { return path.join(this.paths.runtimeDir, "sessions", `${createHash("sha256").update(tabId).digest("hex")}.json`); }
  async route(taskId: string, tabId: string, reserve?: Pick<SessionRoute, "sessionId" | "creationId"> & { hostId?: string }): Promise<SessionRoute> {
    await this.refreshInventory();
    const known = await readPrivateRecord<SessionRoute>(this.routePath(tabId));
    const actual = this.facts.filter((fact) => fact.tabId === tabId);
    if (actual.length > 1) throw new Error("Multiple session owners; refusing launch.");
    if (known) {
      if (known.taskId !== taskId || known.hostId !== this.host.instanceId || known.disposed) throw new RuntimeAcknowledgementUncertainError("Session ownership unavailable or intentionally closed; a new incarnation must be explicit.");
      if (reserve && (known.sessionId !== reserve.sessionId || known.creationId !== reserve.creationId)) throw new Error("Reserved session identity conflict.");
      return known;
    }
    const recovered = actual[0];
    if (recovered && recovered.taskId !== taskId) throw new Error("Host task identity conflict.");
    const route: SessionRoute = recovered ? { taskId, tabId, sessionId: recovered.sessionId, creationId: recovered.creationId, hostId: this.host.instanceId } : { taskId, tabId, hostId: this.host.instanceId, sessionId: reserve?.sessionId ?? randomUUID(), creationId: reserve?.creationId ?? randomUUID() };
    await writePrivateRecord(this.routePath(tabId), route); return route;
  }
  async ensure(taskId: string, tabId: string, size: PtySize, spec: PtySessionSpec, reserve?: Pick<SessionRoute, "sessionId" | "creationId"> & { hostId?: string }): Promise<SessionRoute> {
    const route = await this.route(taskId, tabId, reserve);
    const task = await taskService.getTask(this.paths, taskId).catch((error: unknown) => {
      if (error instanceof CraigError && error.code === "TASK_NOT_FOUND") return null;
      throw error;
    });
    const tab = task?.ptyTabs.find((entry) => entry.id === tabId);
    const launchSpec = task ? { ...spec, env: { ...spec.env, CRAIG_WORKSPACE_ROOT: this.paths.workspaceRoot, CRAIG_TASK_ID: taskId,
      CRAIG_AGENT_TAB_ID: tab?.kind === "agent" ? tabId : "", CRAIG_AGENT_CAPABILITY: tab?.kind === "agent" ? spec.env?.CRAIG_AGENT_CAPABILITY ?? "" : "",
      CRAIG_FURY_RUN_ID: task.furyRunId ?? "", CRAIG_FURY_STEP_ID: task.furyStepId ?? "" } } : spec;
    const capabilityToken = launchSpec.env?.CRAIG_AGENT_CAPABILITY;
    if (capabilityToken) await refreshAgentCapability(this.paths, { taskId, agentTabId: tabId, capabilityToken }).catch(() => undefined);
    await this.request({ type: "ensure", session: { taskId, tabId, sessionId: route.sessionId, creationId: route.creationId }, size, spec: launchSpec });
    await this.refreshInventory(); return route;
  }
  async snapshot(route: SessionRoute, view?: LogicalView): Promise<TerminalViewState> {
    return (await this.request(view?.token ? { type: "view", ...route, viewId: view.viewId, viewToken: view.token } : { type: "snapshot", ...route })).view as TerminalViewState;
  }
  async acquireView(route: SessionRoute, view: LogicalView): Promise<LogicalView> {
    const response = await this.request({ type: "acquireView", ...route, viewId: view.viewId, viewProof: view.proof });
    if (typeof response.viewToken !== "string") throw new Error("Missing view ownership token.");
    return { ...view, token: response.viewToken };
  }
  async releaseView(route: SessionRoute, view: LogicalView): Promise<void> { await this.request({ type: "releaseView", ...route, viewId: view.viewId, viewToken: view.token }); }
  async scroll(route: SessionRoute, view: LogicalView, lines: number): Promise<TerminalViewState> { return (await this.request({ type: "scroll", ...route, viewId: view.viewId, viewToken: view.token, lines })).view as TerminalViewState; }
  async getActivitySnapshots(): Promise<PtyActivitySnapshot[]> { await this.refreshInventory(); return this.activities; }
  async hasRunningSession(tabId: string): Promise<boolean> { await this.refreshInventory(); return this.facts.some((fact) => fact.tabId === tabId && fact.status === "running"); }
  async getRunningAgentCapabilities(): Promise<AgentCapabilitySession[]> {
    await this.refreshInventory(); const sessions: AgentCapabilitySession[] = [];
    for (const fact of this.facts.filter((entry) => entry.status === "running")) {
      const task = await taskService.getTask(this.paths, fact.taskId).catch(() => null); if (!task) continue;
      const capabilityToken = await getExistingTaskAgentCapability(this.paths, task, fact.tabId);
      if (capabilityToken) sessions.push({ taskId: task.id, agentTabId: fact.tabId, capabilityToken });
    }
    return sessions;
  }
  async getStartupBlocker(tabId: string, runner: RunnerType): Promise<string | null> {
    await this.refreshInventory(); const route = this.facts.find((fact) => fact.tabId === tabId); if (!route) return null;
    const response = await this.request({ type: "snapshot", ...route });
    return typeof response.screen === "string" ? findRunnerStartupBlocker(runner, response.screen) : null;
  }
  async writeToSession(tabId: string, input: string): Promise<void> {
    await this.refreshInventory(); const route = this.facts.find((fact) => fact.tabId === tabId);
    if (!route) throw new Error("Session owner is unavailable; input was not replayed.");
    await this.request({ type: "write", ...route, input });
  }
  async disposeSession(tabId: string): Promise<void> {
    await this.refreshInventory(); const route = this.facts.find((fact) => fact.tabId === tabId); if (!route) return;
    await this.request({ type: "dispose", ...route });
    await writePrivateRecord(this.routePath(tabId), { ...route, disposed: true });
    await this.refreshInventory();
  }
  async inventory(): Promise<RuntimeFrame> { return this.request({ type: "enumerate" }); }
  close(): void { this.transport?.close(); }
}
