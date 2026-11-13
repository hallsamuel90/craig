import { replaceControlUnderLock } from "../src/shell/runtime/replacement.js";
import { acquireRuntimeLock } from "../src/shell/runtime/ownership.js";
import { daemonStatus } from "../src/shell/runtime/discovery.js";
import { stopFixtureRuntimes } from "./runtime-fixtures.js";
import { runCommand } from "../src/shared/exec.js";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, expect, vi } from "vitest";
import { createCraigState, createGitRepo, writeRepoRecord, writeTaskRecord } from "./test-helpers.js";
import { listPromptCommands } from "../src/domain/orchestration/index.js";
import type { TaskCreateRequest } from "../src/shell/runtime/task-create.js";
import { appendTaskId } from "../src/domain/task/adapters/task-store.js";
import { configService } from "../src/domain/config/index.js";
import { taskService } from "../src/domain/task/index.js";
import { ensureRuntimeRunning } from "../src/shell/runtime/start.js";
import { readPrivateRecord, newRuntimeRecord, writePrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { RuntimeTransport } from "../src/shell/runtime/wire.js";
import { getClientRuntimeEndpoint } from "../src/shell/runtime/endpoint.js";
import { submitRuntimeTaskCreate } from "../src/shell/runtime/task-create-client.js";
import { readTaskCreateOperation } from "../src/domain/runtime/task-create/store.js";
import { requestDaemonShutdown } from "../src/ui/pty/daemon.js";

const sourceRoot = process.cwd();
test.each([["root", "admitted", "crash"], ["root", "provisioning_files", "crash"], ["root", "provisioned", "crash"], ["root", "spawned", "crash"], ["root", "task_started", "crash"], ["root", "completed", "crash"], ["child", "provisioned", "crash"], ["child", "completed", "crash"], ["root", "admitted", "drain_finish"], ["root", "provisioned", "drain_finish"], ["root", "admitted", "drain_timeout"], ["root", "provisioned", "drain_timeout"]] as const)("%s task-create checkpoint %s with %s", async (kind, checkpoint, behavior) => {
  const root = await mkdtemp(path.join(tmpdir(), "craig-create-crash-")).then((value) => realpath(value));
  const paths = await createCraigState(root, []);
  const previousCache = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = path.join(root, "cache");
  const repo = path.join(root, "repo"); await mkdir(repo); await createGitRepo(repo);
  await writeFile(path.join(repo, "README.md"), "Crash fixture\n");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "fixture"], { cwd: repo });
  await writeRepoRecord(root, { id: "repo_a", name: "fixture", rootPath: repo, defaultBranch: "main", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { id: "workspace_repo_a", primaryRepoId: "repo_a", branch: "main", status: "active", linkedRepoIds: [], archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const stub = path.join(root, "codex");
  await writeFile(stub, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(root, "spawn-pids"))},process.pid+'\\n'); require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'agent-context.json'))},JSON.stringify({taskId:process.env.CRAIG_TASK_ID,tabId:process.env.CRAIG_AGENT_TAB_ID,workspace:process.env.CRAIG_WORKSPACE_ROOT}));console.log('agent-ready');require('node:readline').createInterface({input:process.stdin}).on('line',()=>{});`);
  await chmod(stub, 0o755); await configService.save(paths, { runners: { codex: { path: stub } }, ...(kind === "child" ? { previews: { agentOrchestration: true } } : {}) });
  if (kind === "child") { await writeTaskRecord(root, { id: "task_parent", repoId: "repo_a", workspaceId: "workspace_repo_a", repoRoot: repo, worktreePath: repo }); await appendTaskId(paths, "task_parent"); }
  let fixtureController: ChildProcess | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    await ensureRuntimeRunning(paths);
    const original = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!;
    const stop = await RuntimeTransport.connect(original.endpoint); await stop.request({ type: "shutdown" }); stop.close();
    await vi.waitFor(async () => { try { process.kill(original.pid, 0); throw new Error("Still stopping"); } catch (error) { expect((error as { code?: string }).code).toBe("ESRCH"); } });
    const record = await newRuntimeRecord(paths, "control", original.artifact);
    await writePrivateRecord(path.join(paths.runtimeDir, "control.json"), record);
    const entry = path.join(root, "checkpoint-control.mts");
    await writeFile(entry, `import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';import path from 'node:path';
import {getCraigPaths} from ${JSON.stringify(path.join(sourceRoot, "src/state/craig-paths.ts"))};
import {readPrivateRecord,writePrivateRecord} from ${JSON.stringify(path.join(sourceRoot, "src/shell/runtime/records.ts"))};
import {serveSplitControl} from ${JSON.stringify(path.join(sourceRoot, "src/shell/runtime/split-control.ts"))};
import {acquireRuntimeLock} from ${JSON.stringify(path.join(sourceRoot, "src/shell/runtime/ownership.ts"))};
import {taskService} from ${JSON.stringify(path.join(sourceRoot, "src/domain/task/index.ts"))};
const root=${JSON.stringify(root)},paths=getCraigPaths(root),file=path.join(paths.runtimeDir,'control.json');
const record=await readPrivateRecord(file);record.pid=process.pid;await writePrivateRecord(file,record);
const hostName=(await readdir(path.join(paths.runtimeDir,'hosts')))[0];const host=await readPrivateRecord(path.join(paths.runtimeDir,'hosts',hostName));
const release=await acquireRuntimeLock(paths,'control-owner');try{await serveSplitControl(paths,record,host,{checkpoint:async(stage,operation)=>{
if(stage!==${JSON.stringify(checkpoint)})return;
if(stage==='provisioning_files'){const task=await taskService.getTask(paths,operation.taskId);await mkdir(task.worktreePath,{recursive:true});await writeFile(path.join(task.worktreePath,'partial-fixture'),'preserve partial work');}
await writeFile(path.join(root,'checkpoint.json'),JSON.stringify(operation));if(${JSON.stringify(behavior)}==='crash')await new Promise(()=>{});else {while(!await readFile(path.join(root,'continue-create'),'utf8').catch(()=>null))await new Promise(r=>setTimeout(r,20));}
}});}finally{await release();}`);
    fixtureController = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), entry], { cwd: root, env: process.env, stdio: "ignore" });
    await vi.waitFor(async () => { const connection = await RuntimeTransport.connect(getClientRuntimeEndpoint(paths).socketPath); try { expect((await connection.request({ type: "ping" })).role).toBe("control"); } finally { connection.close(); } }, { timeout: 10000 });
    const request: TaskCreateRequest = kind === "root" ? { kind: "root", targetId: "repo_a", prompt: "Crash recovery fixture" } : { kind: "child", input: { parentTaskId: "task_parent", repoId: "repo_a", prompt: "Crash recovery fixture", idempotencyKey: "fixture-child-key" } };
    pending = submitRuntimeTaskCreate(paths, "fixture-operation", request).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(root, "checkpoint.json"), "utf8")).operationId).toBe("fixture-operation"), { timeout: 10000 });
    const before = (await readTaskCreateOperation(paths, "fixture-operation"))!;
    expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))?.pid).toBe(fixtureController.pid);
    if (behavior !== "crash") {
      const release = await acquireRuntimeLock(paths, "lifecycle");
      const replacement = replaceControlUnderLock(paths, true, { artifact: original.artifact }).finally(release);
      // Attach a rejection handler immediately while intentionally holding create.
      const observed = replacement.then((result) => ({ result }), (error: unknown) => ({ error }));
      await vi.waitFor(async () => expect((await daemonStatus(paths)).state).toBe("draining"));
      await expect(submitRuntimeTaskCreate(paths, "unadmitted-operation", request)).rejects.toThrow("not admitted");
      expect(await readTaskCreateOperation(paths, "unadmitted-operation")).toBeNull();
      if (behavior === "drain_timeout") {
        const outcome = await observed;
        expect("error" in outcome && String(outcome.error)).toContain("drain timed out");
        expect((await daemonStatus(paths)).state).toBe("ready");
        expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))?.pid).toBe(fixtureController.pid);
      }
      await writeFile(path.join(root, "continue-create"), "finish the admitted operation");
      const result = await pending as { taskId: string };
      expect(result.taskId).toBe(before.taskId);
      if (behavior === "drain_finish") {
        const outcome = await observed;
        expect(outcome).toMatchObject({ result: { state: "restarted" } });
      }
      expect((await readTaskCreateOperation(paths, "fixture-operation"))?.state).toBe("completed");
      expect((await taskService.getTask(paths, before.taskId)).runnerSession.lastKnownState).not.toBe("failed");
      await vi.waitFor(async () => expect((await readFile(path.join(root, "spawn-pids"), "utf8")).trim().split("\n")).toHaveLength(1));
      expect((await submitRuntimeTaskCreate(paths, "fixture-operation", request)).taskId).toBe(before.taskId);
      return;
    }
    fixtureController.kill("SIGKILL"); await new Promise<void>((resolve) => fixtureController!.once("exit", () => resolve())); await pending;
    await ensureRuntimeRunning(paths);
    if (checkpoint === "provisioning_files") {
      await expect(submitRuntimeTaskCreate(paths, "fixture-operation", request)).rejects.toThrow("recovery_required");
      const task = await taskService.getTask(paths, before.taskId);
      expect(await readFile(path.join(task.worktreePath, "partial-fixture"), "utf8")).toBe("preserve partial work");
      expect((await readTaskCreateOperation(paths, "fixture-operation"))?.state).toBe("recovery_required");
    } else {
      const result = await submitRuntimeTaskCreate(paths, "fixture-operation", request);
      expect(result.taskId).toBe(before.taskId);
      const after = (await readTaskCreateOperation(paths, "fixture-operation"))!;
      expect(after).toMatchObject({ state: "completed", taskId: before.taskId, creationId: before.creationId, sessionId: before.sessionId });
      await vi.waitFor(async () => expect((await readFile(path.join(root, "spawn-pids"), "utf8")).trim().split("\n")).toHaveLength(1));
      expect((await taskService.listTasks(paths)).tasks).toHaveLength(kind === "root" ? 1 : 2);
      expect(JSON.parse(await readFile(path.join(root, "agent-context.json"), "utf8"))).toEqual({ taskId: before.taskId, tabId: before.agentTabId, workspace: root });
      if (kind === "child") { expect(result.kind).toBe("createChildTask"); expect((await taskService.getTask(paths, result.taskId)).parentTaskId).toBe("task_parent"); expect(await listPromptCommands(paths)).toHaveLength(1); const replay = await submitRuntimeTaskCreate(paths, "legacy-child-key-replay", request); expect(replay.taskId).toBe(result.taskId); expect((await readTaskCreateOperation(paths, "legacy-child-key-replay"))?.taskId).toBe(result.taskId); }
      await expect(submitRuntimeTaskCreate(paths, "fixture-operation", request.kind === "root" ? { ...request, prompt: "Different input" } : { ...request, input: { ...request.input, prompt: "Different input" } })).rejects.toThrow("different inputs");
    }
  } catch (error) {
    process.stdout.write(`Crash fixture ${checkpoint}: ${String(error)}\n`);
    throw error;
  } finally {
    if (fixtureController?.exitCode === null && fixtureController.signalCode === null) { fixtureController.kill("SIGKILL"); await new Promise<void>((resolve) => fixtureController!.once("exit", () => resolve())); }
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 500))]);
    await requestDaemonShutdown(paths).catch(() => undefined);
    await stopFixtureRuntimes(paths, path.join(root, "cache"));
    if (previousCache === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previousCache;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);


test("durable task reservations remain unique beyond the daily two-digit sequence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "craig-reserved-task-id-"));
  const date = new Date(); const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const paths = await createCraigState(root, [`task_${day}_99`, `task_${day}_100`]);
  try { expect(await taskService.allocateProjectTaskId(paths, [`task_${day}_101`])).toBe(`task_${day}_102`); }
  finally { await rm(root, { recursive: true, force: true }); }
});
