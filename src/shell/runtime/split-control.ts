import { HostPool } from "./host-pool.js";
import { RuntimeAdmissionGate } from "./admission-gate.js";
import { RuntimeAcknowledgementUncertainError, RuntimeUpgradeRetryError } from "../../domain/runtime/errors.js";
import { listTaskCreateOperations } from "../../domain/runtime/task-create/store.js";
import { reconcileEvents } from "../event-reconciliation.js";
import { runtimeRequest } from "./discovery.js";
import { readPrivateRecord } from "./records.js";
import { TaskCreateAdmission, type TaskCreateRequest, type TaskCreateAdmissionPorts } from "./task-create.js";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { CraigPaths } from "../../state/craig-paths.js";
import type { TerminalViewState } from "./terminal/types.js";
import { type SessionRoute, type LogicalView } from "./host-client.js";
import { readRuntimeFrames, writeRuntimeFrame, type RuntimeFrame } from "./wire.js";
import { writePrivateRecord, type RuntimeRecord } from "./records.js";
import { runtimeIdentity } from "./identity.js";
import { mapKeyToPtyInput, type PtySessionSpec, type PtySize } from "./session-core.js";
import { OrchestrationSupervisor } from "../orchestration-supervisor.js";
import { PullRequestSyncSupervisor } from "../pull-request-sync-supervisor.js";
import { configService } from "../../domain/config/index.js";
import { errorService } from "../../domain/error/index.js";
import path from "node:path";

interface ClientState {
  attached: SessionRoute | null;
  subscribed: SessionRoute | null;
  activity: boolean;
  navigation: boolean;
  views: Map<string, LogicalView>;
  viewNamespace: string;
  viewProof: string;
}
const idle = (): TerminalViewState => ({ status: "idle", rows: [], error: null, scrolledBack: false });

/** Replaceable orchestration/presentation router. Owns no PTY or terminal emulator. */
export async function serveSplitControl(paths: CraigPaths, record: RuntimeRecord, hostRecord: RuntimeRecord | RuntimeRecord[], admissionPorts: TaskCreateAdmissionPorts = {}): Promise<void> {
  const clients = new Map<Socket, ClientState>();
  let shuttingDown = false;
  const gate = new RuntimeAdmissionGate();
  let preparedTransaction: string | null = null;
  let preparation: { id: string; promise: Promise<void> } | null = null;
  const externalAdmissions = new Map<string, () => void>();
  const host = new HostPool(paths, Array.isArray(hostRecord) ? hostRecord : [hostRecord], record, (tabIds) => { void broadcast(tabIds); });
  await host.connect();
  for (const operation of await listTaskCreateOperations(paths)) {
    if (!host.hasHost(operation.hostId)) {
      if (operation.state === "completed" || operation.state === "failed") continue;
      throw new Error("Task-create recovery references an unsupported host; owner preserved.");
    }
    if (operation.state === "completed" || operation.state === "failed") await host.request({ type: "completeCreation", hostId: operation.hostId, creationId: operation.creationId, reservationId: operation.operationId });
    else await host.request({ type: "reserveCreation", hostId: operation.hostId, reservationId: operation.operationId, session: { taskId: operation.taskId, tabId: operation.agentTabId, sessionId: operation.sessionId, creationId: operation.creationId } });
  }
  if (record.handoffId) await host.request({ type: "adoptHold", holdId: record.handoffId });
  await host.refreshInventory();
  await host.request({ type: "releaseHold", holdId: `recovery:${record.instanceId}` });
  const admission = new TaskCreateAdmission(paths, host, admissionPorts);
  // Leadership is acquired by the supervisor and cannot overlap a living old owner.
  const config = await configService.load(paths);
  const supervisor = new OrchestrationSupervisor(paths, host, { admit: (work) => gate.background(work), onError: (error) => { void errorService.appendErrorLogBestEffort(paths, { context: "split orchestration", message: error instanceof Error ? error.message : "Orchestration error" }); } });
  await supervisor.start({ deferReconciliation: true });
  const polling = new PullRequestSyncSupervisor(paths, { admit: (work) => gate.background(work), reconcileEvents: async () => { let events: Awaited<ReturnType<typeof reconcileEvents>> = []; await gate.background(async () => { const activities = await host.getActivitySnapshots(); events = await reconcileEvents(paths, { agentObserver: { daemonAvailable: true, getSnapshots: () => activities, subscribe: () => () => undefined, close: () => undefined } }); }); return events; }, minimumIntervalMs: (config.github?.watchIntervalSeconds ?? 5) * 1000,
    onTasksChanged: async (taskIds) => { for (const socket of clients.keys()) writeRuntimeFrame(socket, { type: "tasksChanged", taskIds }); } });
  const adoptedActivities = await host.getActivitySnapshots();
  await reconcileEvents(paths, { agentObserver: { daemonAvailable: true, getSnapshots: () => adoptedActivities, subscribe: () => () => undefined, close: () => undefined } });
  polling.start();
  let retirementJob: Promise<void> | null = null;
  const retirementTimer = setInterval(() => {
    if (!retirementJob) retirementJob = gate.whenIdle(() => host.retireUnused()).catch(() => undefined).finally(() => { retirementJob = null; });
  }, 1000);

  async function broadcast(tabIds: string[]): Promise<void> {
    try {
      const activities = await host.getActivitySnapshots();
      for (const [socket, state] of clients) {
        if (state.activity) {
          for (const snapshot of activities) writeRuntimeFrame(socket, { type: "activity", snapshot });
          for (const tabId of tabIds) if (!activities.some((snapshot) => snapshot.tabId === tabId)) writeRuntimeFrame(socket, { type: "activityRemoved", tabId });
        }
        if (state.subscribed && tabIds.includes(state.subscribed.tabId)) {
          const exists = (await host.inventory()).sessions as SessionRoute[];
          const view = exists.some((session) => session.sessionId === state.subscribed!.sessionId) ? await host.snapshot(state.subscribed, state.views.get(state.subscribed.tabId)) : idle();
          writeRuntimeFrame(socket, { type: "update", tabId: state.subscribed.tabId, view });
        }
      }
    } catch { /* Transport loss is not evidence of an exited agent. */ }
  }
  async function attachView(state: ClientState, route: SessionRoute): Promise<LogicalView> {
    const known = state.views.get(route.tabId) ?? { viewId: `${state.viewNamespace}:${route.sessionId}`, proof: state.viewProof };
    const view = await host.acquireView(route, known); state.views.set(route.tabId, view); return view;
  }
  async function routeFor(tabId: string): Promise<SessionRoute | null> {
    const inventory = await host.inventory();
    const sessions = inventory.sessions as SessionRoute[];
    const session = sessions.find((entry) => entry.tabId === tabId);
    return session ?? null;
  }
  const server = createServer((socket) => {
    const state: ClientState = { attached: null, subscribed: null, activity: false, navigation: false, views: new Map(), viewNamespace: randomUUID(), viewProof: randomUUID() };
    clients.set(socket, state); socket.on("close", () => clients.delete(socket)); socket.on("error", () => undefined);
    // Socket transport order is retained for writes/resize/view operations.
    let chain = Promise.resolve();
    let pendingRequests = 0;
    readRuntimeFrames(socket, (frame) => {
      if (++pendingRequests > 128) { socket.destroy(); return; }
      chain = chain.then(async () => {
        try { const ungated = ["ping", "getViewState", "getActivitySnapshots", "inspectTaskCreate", "prepareReplacement", "commitReplacement", "abortReplacement", "endMutation", "beginMutation"];
          const admitted = typeof frame.admissionToken === "string" && externalAdmissions.has(frame.admissionToken);
          if (frame.admissionToken !== undefined && !admitted) throw new RuntimeAcknowledgementUncertainError("Mutation admission belongs to another control; inspect its outcome before retrying.");
          const result = admitted || ungated.includes(frame.type ?? "") ? await handle(socket, state, frame) : await gate.run(() => handle(socket, state, frame)); writeRuntimeFrame(socket, { ...result, id: frame.id, ok: true }); }
        catch (error) { writeRuntimeFrame(socket, { id: frame.id, ok: false, error: error instanceof Error ? error.message : "Runtime request failed.", retryable: error instanceof RuntimeUpgradeRetryError, uncertain: error instanceof RuntimeAcknowledgementUncertainError }); }
        finally { pendingRequests--; }
      });
    });
  });
  let stop: (() => void) | undefined;
  async function handle(socket: Socket, state: ClientState, frame: RuntimeFrame): Promise<RuntimeFrame> {
    if (!["getActivitySnapshots", "getViewState", "shutdownWorkspace", "shutdown"].includes(frame.type ?? "")) {
      const guard = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "guard.json"));
      const response = guard ? await runtimeRequest(guard.endpoint, { type: "ping" }).catch(() => null) : null;
      if (!guard || !response || (response as { instanceId?: unknown }).instanceId !== guard.instanceId || response.protocolVersion !== 0) throw new RuntimeAcknowledgementUncertainError("Compatibility guard is unavailable; runtime mutations are blocked until it is repaired.");
    }
    if (shuttingDown && frame.type !== "ping") throw new Error("Control is shutting down; retry reads after reconnect. Do not replay writes.");
    if (["prepareReplacement", "commitReplacement", "abortReplacement"].includes(frame.type ?? "")) {
      if (frame.credential !== record.credential || frame.instanceId !== record.instanceId || frame.workspaceId !== record.workspaceId || typeof frame.transactionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(frame.transactionId)) throw new Error("Control lifecycle authentication rejected.");
    }
    switch (frame.type) {
      case "beginMutation": { const release = gate.enter(); const token = randomUUID(); externalAdmissions.set(token, release); return { token }; }
      case "endMutation": { const release = externalAdmissions.get(String(frame.token)); if (!release) throw new Error("Unknown mutation admission."); externalAdmissions.delete(String(frame.token)); release(); return {}; }
      case "prepareReplacement": {
        const transactionId = String(frame.transactionId);
        if (preparedTransaction === transactionId) return { prepared: true };
        if (preparation) {
          if (preparation.id !== transactionId) throw new Error("Another replacement owns the drain.");
          await preparation.promise; return { prepared: true };
        }
        if (preparedTransaction) throw new Error("Another replacement owns the drain.");
        const prepare = async () => {
          const deadline = Date.now() + 5000;
          const draining = gate.drain(4900);
          for (const client of clients.keys()) writeRuntimeFrame(client, { type: "lifecycle", state: "draining" });
          try {
            await draining;
            await host.request({ type: "hold", holdId: `upgrade:${transactionId}` }, Math.max(1, deadline - Date.now()));
            preparedTransaction = transactionId;
          } catch (error) {
            gate.reopen();
            for (const client of clients.keys()) writeRuntimeFrame(client, { type: "lifecycle", state: "ready" });
            throw error;
          }
        };
        const pending = prepare(); preparation = { id: transactionId, promise: pending };
        try { await pending; return { prepared: true }; } finally { preparation = null; }
      }
      case "abortReplacement": {
        if (preparation) {
          if (preparation.id !== frame.transactionId) throw new Error("Different replacement owns the drain.");
          await preparation.promise.catch(() => undefined);
        }
        if (preparedTransaction && preparedTransaction !== frame.transactionId) throw new Error("Different replacement owns the drain.");
        await host.request({ type: "releaseHold", holdId: `upgrade:${frame.transactionId}` });
        preparedTransaction = null; gate.reopen(); for (const client of clients.keys()) writeRuntimeFrame(client, { type: "lifecycle", state: "ready" }); return {};
      }
      case "commitReplacement": {
        if (preparedTransaction !== frame.transactionId || gate.state !== "draining" || gate.pendingCount) throw new Error("Control has not completed this drain.");
        shuttingDown = true; setImmediate(() => stop?.()); return {};
      }
      case "ping": { const inventory = await host.inventory(); return { ...runtimeIdentity(), capabilities: [...runtimeIdentity().capabilities!, "splitRuntime", "controlReplacement"], lifecycle: record.ready ? gate.state : "draining", pendingMutations: gate.pendingCount, replacementProtocol: 1, durableStateVersions: [1], sessionCount: (inventory.sessions as unknown[]).length, role: "control", instanceId: record.instanceId, workspaceId: record.workspaceId, hosts: inventory.hosts }; }
      case "registerViewClient": {
        if (typeof frame.clientId !== "string" || typeof frame.proof !== "string" || frame.clientId.length > 128 || frame.proof.length > 128) throw new Error("Invalid view client identity.");
        state.viewNamespace = frame.clientId; state.viewProof = frame.proof; return {};
      }
      case "submitTaskCreate": return { result: await admission.submit(String(frame.operationId), frame.request as TaskCreateRequest) };
      case "inspectTaskCreate": return { operation: await admission.inspect(String(frame.operationId)) };
      case "acknowledgeView": {
        const view = state.views.get(String(frame.tabId));
        if (!view || view.viewId !== frame.viewId || view.token !== frame.viewToken) throw new Error("View acknowledgement identity mismatch.");
        return {};
      }
      case "ensureSession": {
        const holdId = `attach:${randomUUID()}`;
        await host.request({ type: "hold", holdId });
        try {
          const route = await host.ensure(String(frame.taskId), String(frame.tabId), frame.size as PtySize, frame.spec as PtySessionSpec);
          const lease = await attachView(state, route); state.attached = route; state.subscribed = route;
          return { view: await host.snapshot(route, lease), viewToken: lease.token, viewId: lease.viewId, sessionId: route.sessionId };
        } finally { await host.request({ type: "releaseHold", holdId }); }
      }
      case "attachExisting": {
        const route = await routeFor(String(frame.tabId));
        if (!route) return { view: idle() };
        const lease = await attachView(state, route); state.attached = route;
        return { view: await host.snapshot(route, lease), viewId: lease.viewId, viewToken: lease.token, sessionId: route.sessionId };
      }
      case "hydrateSession": { const route = await routeFor(String(frame.tabId)); if (!route) return { view: idle() }; const lease = await attachView(state, route); return { view: await host.snapshot(route, lease), viewId: lease.viewId, viewToken: lease.token, sessionId: route.sessionId }; }
      case "subscribeView": {
        state.subscribed = frame.tabId === null ? null : await routeFor(String(frame.tabId));
        if (!state.subscribed) return { view: idle() };
        const lease = await attachView(state, state.subscribed); return { view: await host.snapshot(state.subscribed, lease), viewId: lease.viewId, viewToken: lease.token, sessionId: state.subscribed.sessionId };
      }
      case "getViewState": { const route = frame.tabId === null ? null : await routeFor(String(frame.tabId)); return { view: route ? await host.snapshot(route, state.views.get(route.tabId)) : idle() }; }
      case "write": case "writeKey": {
        if (!state.attached) throw new Error("No attached session; input was not accepted.");
        const input = frame.type === "writeKey" ? mapKeyToPtyInput(String(frame.key)) : frame.input;
        if (typeof input === "string") await host.writeToSession(state.attached.tabId, input); return {};
      }
      case "resize": { if (!state.attached) return { view: idle() }; await host.request({ type: "resize", ...state.attached, size: frame.size }); return { view: await host.snapshot(state.attached, state.views.get(state.attached.tabId)) }; }
      case "scrollViewport": {
        if (!state.attached) return { view: idle() };
        const lease = await attachView(state, state.attached); return { view: await host.scroll(state.attached, lease, Number(frame.lines)) };
      }
      case "detach": {
        // Deliberate detach releases this client's view only. Socket closure does not.
        if (state.attached) { const view = state.views.get(state.attached.tabId); if (view) await host.releaseView(state.attached, view); state.views.delete(state.attached.tabId); }
        state.attached = null; return {};
      }
      case "disposeSession": await host.disposeSession(String(frame.tabId)); return {};
      case "pruneStale": return {};
      case "setViewUpdateMode": return {};
      case "setActivityEnabled": state.activity = frame.enabled === true; return {};
      case "getActivitySnapshots": return { activities: await host.getActivitySnapshots() };
      case "setPullRequestPollView": polling.setView(frame.view as Parameters<typeof polling.setView>[0]); return {};
      case "subscribeNavigation": state.navigation = true; return {};
      case "openFile": { let deliveredCount = 0; for (const [other, subscription] of clients) if (other !== socket && subscription.navigation && !other.destroyed) { writeRuntimeFrame(other, { type: "openFile", path: frame.path }); deliveredCount++; } return { deliveredCount }; }
      case "wakeOrchestration": void supervisor.wake().catch(() => undefined); return {};
      case "shutdownWorkspace": {
        // Explicit whole-workspace shutdown, never an upgrade or disconnect path.
        if (admission.pendingCount || (await listTaskCreateOperations(paths)).some((operation) => operation.state !== "completed" && operation.state !== "failed")) throw new Error("Task creates remain admitted or require recovery; workspace shutdown refused.");
        const inventory = await host.inventory();
        for (const session of inventory.sessions as SessionRoute[]) await host.disposeSession(session.tabId);
        await host.request({ type: "shutdownIfUnused" });
        host.close(); shuttingDown = true; setImmediate(() => stop?.()); return {};
      }
      case "shutdown": shuttingDown = true; setImmediate(() => stop?.()); return {};
      default: throw new Error("Unsupported split control operation.");
    }
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(record.endpoint, resolve); });
    // Host-held views/leases and durable create reservations are adopted before
    // readiness. Release the transaction hold only after that adoption.
    if (record.handoffId) await host.request({ type: "releaseHold", holdId: record.handoffId });
    record.ready = true; await writePrivateRecord(path.join(paths.runtimeDir, "control.json"), record);
    await new Promise<void>((resolve) => {
      stop = () => { shuttingDown = true; for (const socket of clients.keys()) socket.destroy(); server.close(() => resolve()); };
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
    });
  } finally {
    shuttingDown = true; gate.closeAdmission(); clearInterval(retirementTimer);
    await retirementJob;
    await polling.stop(); await supervisor.stop(); host.close();
    // Host, guard, logical leases and screens remain alive independently.
    record.ready = false; await writePrivateRecord(path.join(paths.runtimeDir, "control.json"), record);
  }
}
