import { RuntimeTransport } from "../src/shell/runtime/wire.js";
import { runtimeMutationContext } from "../src/shell/runtime/mutation-context.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, realpath, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createCraigState, createGitRepo, writeRepoRecord } from "./test-helpers.js";
import { buildPackagedUpgradeFixtures } from "./runtime-packages.js";
import { stopFixtureRuntimes } from "./runtime-fixtures.js";
import { createDaemonPtyRuntime } from "../src/ui/pty/daemon.js";
import { daemonStatus, runtimeRequest } from "../src/shell/runtime/discovery.js";
import { configService } from "../src/domain/config/index.js";
import { submitRuntimeTaskCreate } from "../src/shell/runtime/task-create-client.js";
import { readTaskCreateOperation } from "../src/domain/runtime/task-create/store.js";
import { readPrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { verifyRuntimeArtifact } from "../src/shell/runtime/artifacts.js";
import { collectRuntimeArtifacts } from "../src/shell/runtime/artifact-retention.js";
const execute = promisify(execFile);

test("real A/B npm installations roll new tasks to B, retain A after removal, restart across both, and retire only unused A", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "craig-packaged-rollover-")).then((value) => realpath(value));
  const paths = await createCraigState(root, []); const cache = path.join(root, "cache");
  const previous = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = cache;
  let aClient: Awaited<ReturnType<typeof createDaemonPtyRuntime>> | undefined; let bClient: typeof aClient;
  try {
    const packages = await buildPackagedUpgradeFixtures(path.join(root, "packages"));
    expect(packages.a.version).not.toBe(packages.b.version);
    const env = { ...process.env, CRAIG_RUNTIME_CACHE: cache, CRAIG_WORKSPACE_ROOT: root };
    await execute(process.execPath, [packages.a.binary, "__craig-runtime-bootstrap", root], { cwd: root, env });
    const command = [process.execPath, "-e", "let memory='';const nonce=require('node:crypto').randomUUID();const tty=require('node:fs').fstatSync(0);console.log('IDENTITY '+JSON.stringify({pid:process.pid,cwd:process.cwd(),nonce,dev:tty.dev,ino:tty.ino}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(line.startsWith('remember ')){memory=line.slice(9);console.log('REMEMBERED')};if(line==='recall')console.log('MEMORY '+memory+' '+nonce)});"];
    aClient = await createDaemonPtyRuntime({ paths, workspaceRoot: root, viewClient: { clientId: "package-a", proof: "a-proof" }, resolveSessionSpec: () => ({ cwd: root, command }) });
    await aClient.ensureSession("fixture-a", "fixture-a:agent", { columns: 300, rows: 30 }); aClient.setViewedTab("fixture-a:agent");
    const screenA = () => aClient!.getViewState("fixture-a:agent").rows.map((row) => row.segments.map((part) => part.text).join("")).join("\n");
    await vi.waitFor(() => expect(screenA()).toContain("IDENTITY")); const identity = JSON.parse(screenA().match(/IDENTITY (\{[^\n]+\})/)![1]!);
    aClient.write("remember installation-a-conversation\r"); await vi.waitFor(() => expect(screenA()).toContain("REMEMBERED"));
    const before = (await daemonStatus(paths)).runtime!; const oldHost = before.hosts![0]!;
    const controlA = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!;
    await rm(packages.a.installation, { recursive: true }); await verifyRuntimeArtifact(controlA.artifact);
    await execute(process.execPath, [packages.b.binary, "__craig-runtime-bootstrap", root], { cwd: root, env });
    await vi.waitFor(() => expect(aClient!.connectionMessage ?? "").not.toContain("Reconnecting"));
    aClient.write("recall\r"); await vi.waitFor(() => expect(screenA()).toContain(`MEMORY installation-a-conversation ${identity.nonce}`));
    const repo = path.join(root, "repo"); await mkdir(repo); await createGitRepo(repo); await writeFile(path.join(repo, "README.md"), "fixture\n");
    await execute("git", ["add", "README.md"], { cwd: repo }); await execute("git", ["commit", "-m", "fixture"], { cwd: repo });
    const now = new Date().toISOString(); await writeRepoRecord(root, { id: "repo_a", name: "fixture", rootPath: repo, defaultBranch: "main", createdAt: now, updatedAt: now }, { id: "workspace_repo_a", primaryRepoId: "repo_a", branch: "main", status: "active", linkedRepoIds: [], archivedAt: null, createdAt: now, updatedAt: now });
    const stub = path.join(root, "codex"); await writeFile(stub, "#!/usr/bin/env node\nconsole.log('NEW_HOST_AGENT '+JSON.stringify({pid:process.pid,cwd:process.cwd()}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log('NEW_REPLY '+line));"); await chmod(stub, 0o755);
    await configService.save(paths, { runners: { codex: { path: stub } } });
    const task = await submitRuntimeTaskCreate(paths, "packaged-new-task", { kind: "root", targetId: "repo_a", prompt: "New host worktree" });
    const operation = (await readTaskCreateOperation(paths, "packaged-new-task"))!;
    expect(operation.hostId).not.toBe(oldHost.instanceId);
    bClient = await createDaemonPtyRuntime({ paths, workspaceRoot: root }); await bClient.ensureSession(task.taskId, task.agentTabId, { columns: 300, rows: 30 }); bClient.setViewedTab(task.agentTabId);
    const screenB = () => bClient!.getViewState(task.agentTabId).rows.map((row) => row.segments.map((part) => part.text).join("")).join("\n");
    await vi.waitFor(() => expect(screenB()).toContain("NEW_HOST_AGENT")); const newIdentity = JSON.parse(screenB().match(/NEW_HOST_AGENT (\{[^\n]+\})/)![1]!);
    expect(newIdentity.cwd).toBe(task.worktreePath);
    let status = (await daemonStatus(paths)).runtime!;
    await vi.waitFor(async () => {
      const observed = await daemonStatus(paths); expect(observed.state, observed.reason ?? "runtime discovery").toBe("ready");
      status = observed.runtime!; expect(status.hosts).toHaveLength(2);
    }, { timeout: 5000 });
    expect(status.hosts!.find((host) => host.instanceId === oldHost.instanceId)?.pid).toBe(oldHost.pid);
    expect(status.hosts!.find((host) => host.instanceId === operation.hostId)?.hostRevision).not.toBe(oldHost.hostRevision);
    await execute(process.execPath, [packages.b.binary, "--workspace-root", root, "daemon", "restart", "--json"], { cwd: root, env });
    await vi.waitFor(() => expect(aClient!.connectionMessage ?? "").not.toContain("Reconnecting")); await vi.waitFor(() => expect(bClient!.connectionMessage ?? "").not.toContain("Reconnecting"));
    bClient.write("still-new\r"); await vi.waitFor(() => expect(screenB()).toContain("NEW_REPLY still-new"));
    aClient.write("recall\r"); await vi.waitFor(() => expect(screenA()).toContain(`MEMORY installation-a-conversation ${identity.nonce}`));
    process.kill(identity.pid, 0); process.kill(newIdentity.pid, 0);
    expect((await collectRuntimeArtifacts(paths)).retained).toContain(path.basename(controlA.artifact));
    const guard = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "guard.json")))!; expect((await runtimeRequest(guard.endpoint, { type: "ping" })).protocolVersion).toBe(0);
    const currentControl = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!;
    const admission = await RuntimeTransport.connect(currentControl.endpoint);
    try {
      const { token } = await admission.request({ type: "beginMutation" });
      await runtimeMutationContext.run(String(token), () => aClient!.disposeSessionConfirmed("fixture-a:agent"));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", `${oldHost.instanceId}.json`)))?.retired).not.toBe(true);
      await admission.request({ type: "endMutation", token });
    } finally { admission.close(); }
    await vi.waitFor(async () => expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", `${oldHost.instanceId}.json`)))?.retired).toBe(true), { timeout: 10000 });
    await vi.waitFor(async () => {
      const observed = await daemonStatus(paths); expect(observed.state, observed.reason ?? "retirement discovery").toBe("ready");
      status = observed.runtime!; expect(status.hosts).toHaveLength(1);
    }, { timeout: 5000 });
    expect(status.hosts![0]!.instanceId).toBe(operation.hostId);
    bClient.write("after-old-retirement\r"); await vi.waitFor(() => expect(screenB()).toContain("NEW_REPLY after-old-retirement"));
    process.stdout.write(`packaged-rollover-evidence ${JSON.stringify({ versions: [packages.a.version, packages.b.version], oldControl: controlA.pid, currentControl: (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))?.pid, oldHost, newHost: status.hosts![0], agent: identity, newAgent: newIdentity, installationARemoved: true, oldAgentRecalled: true, oldHostRetiredOnlyAfterClose: true, remainingHostFiles: (await readdir(path.join(paths.runtimeDir, "hosts"))).length })}\n`);
  } finally {
    aClient?.disposeAll(); bClient?.disposeAll(); await stopFixtureRuntimes(paths, cache);
    if (previous === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
