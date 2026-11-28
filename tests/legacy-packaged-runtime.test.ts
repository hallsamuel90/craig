import { extractRuntimeSnapshot } from "./runtime-snapshots.js";
import { createPlan, approvePlan, runFury } from "../src/shell/fury-runtime.js";
import { listFuryRuns } from "../src/domain/orchestration/index.js";
import { writeTaskRecord } from "./test-helpers.js";
import { appendTaskId } from "../src/domain/task/adapters/task-store.js";
import { stopFixtureRuntimes } from "./runtime-fixtures.js";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { promisify } from "node:util";
import { spawn as spawnPty } from "node-pty";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, test, expect, vi } from "vitest";
import { materializeRuntimeDependencies, pinRuntimeArtifact } from "../src/shell/runtime/artifacts.js";
import { createCraigState, createGitRepo, writeRepoRecord } from "./test-helpers.js";
import { readPrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { createDaemonPtyRuntime, requestDaemonShutdown } from "../src/ui/pty/daemon.js";
import { RuntimeTransport } from "../src/shell/runtime/wire.js";
import { getPtyDaemonEndpoint } from "../src/shell/pty-daemon-protocol.js";
import { runtimeRequest } from "../src/shell/runtime/discovery.js";
import { migrateEmptyLegacy } from "../src/shell/runtime/legacy-transition.js";
import { bootstrapSplitRuntime } from "../src/shell/runtime/bootstrap.js";
import { configService } from "../src/domain/config/index.js";
const execute = promisify(execFile);
const sourceRoot = process.cwd();
let packageRoot: string; let oldBinary: string;
beforeAll(async () => {
  packageRoot = await mkdtemp(path.join(tmpdir(), "craig-pre-rfc-package-")).then((value) => realpath(value));
  const source = path.join(packageRoot, "source"); await mkdir(source);
  await extractRuntimeSnapshot("pre-rfc-package", source);
  await symlink(path.join(sourceRoot, "node_modules"), path.join(source, "node_modules"));
  await execute(process.execPath, [path.join(source, "scripts/build-npm.mjs")], { cwd: source });
  await execute("npm", ["pack", "--ignore-scripts", "--pack-destination", packageRoot], { cwd: path.join(source, "packages/cli") });
  const tarball = (await readdir(packageRoot)).find((name) => name.endsWith(".tgz"))!;
  const installation = path.join(packageRoot, "installed"); await mkdir(installation);
  await execute("tar", ["-xf", path.join(packageRoot, tarball), "-C", installation]);
  oldBinary = path.join(installation, "package", "dist/cli.js");
  await materializeRuntimeDependencies(path.join(source, "packages/cli/dist/cli.js"), path.join(installation, "package"));
}, 45000);
afterAll(async () => { await rm(packageRoot, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craig-legacy-package-fixture-")).then((value) => realpath(value));
  const paths = await createCraigState(root, []);
  const repo = path.join(root, "repo"); await mkdir(repo); await createGitRepo(repo);
  await writeFile(path.join(repo, "README.md"), "fixture\n"); await execute("git", ["add", "README.md"], { cwd: repo }); await execute("git", ["commit", "-m", "fixture"], { cwd: repo });
  const now = new Date().toISOString();
  await writeRepoRecord(root, { id: "repo_a", name: "fixture", rootPath: repo, defaultBranch: "main", createdAt: now, updatedAt: now }, { id: "workspace_repo_a", primaryRepoId: "repo_a", branch: "main", status: "active", linkedRepoIds: [], archivedAt: null, createdAt: now, updatedAt: now });
  const stub = path.join(root, "codex"); await writeFile(stub, "#!/usr/bin/env node\nconsole.log('PRE_RFC_AGENT '+process.pid);require('node:readline').createInterface({input:process.stdin}).on('line',()=>{});"); await chmod(stub, 0o755);
  await configService.save(paths, { runners: { codex: { path: stub } } });
  const previousCache = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = path.join(root, "cache");
  return { root, paths, stub, env: { ...process.env, CI: "", CRAIG_WORKSPACE_ROOT: root, CRAIG_RUNTIME_CACHE: path.join(root, "cache"), TERM: "xterm-256color" }, async close() {
    await requestDaemonShutdown(paths).catch(() => undefined);
    await stopFixtureRuntimes(paths, path.join(root, "cache"));
    if (previousCache === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previousCache;
    await rm(root, { recursive: true, force: true });
  } };
}
async function invokeOldTui(binary: string, root: string, env: Record<string, string | undefined>): Promise<string> {
  const child = spawnPty(process.execPath, [binary, "--workspace-root", root], { cwd: root, cols: 120, rows: 36, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
  let output = ""; child.onData((chunk) => { output += chunk; });
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => { child.kill(); reject(new Error(`Old TUI did not reject guard: ${output}`)); }, 5000); child.onExit(() => { clearTimeout(timeout); resolve(); }); });
  return output;
}

test("actual pre-RFC npm binary cannot spawn through the guard while control is ready or dead", async () => {
  const f = await fixture();
  const client = await createDaemonPtyRuntime({ paths: f.paths, workspaceRoot: f.root, resolveSessionSpec: () => ({ cwd: f.root, command: [f.stub] }) });
  try {
    await client.ensureSession("fixture", "fixture:agent", { columns: 120, rows: 24 });
    const control = (await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "control.json")))!;
    const guard = (await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "guard.json")))!;
    expect(await invokeOldTui(oldBinary, f.root, f.env)).toContain("will not replace a live workspace daemon");
    process.kill(control.pid, "SIGKILL");
    expect(await invokeOldTui(oldBinary, f.root, f.env)).toContain("will not replace a live workspace daemon");
    await expect(execute(process.execPath, [oldBinary, "--workspace-root", f.root, "task", "new", "--repo", "repo_a", "legacy delegated launch fixture", "--json"], { cwd: f.root, env: f.env })).rejects.toMatchObject({ code: 1 });
    await execute(process.execPath, [oldBinary, "__craig-daemon-shutdown", f.root], { cwd: f.root, env: f.env });
    const prune = await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "pruneStale", keepTabIds: [] }); expect(prune.ok).toBe(false);
    const ping = await runtimeRequest(guard.endpoint, { type: "ping" }); expect(ping.protocolVersion).toBe(0);
    const hostName = (await readdir(path.join(f.paths.runtimeDir, "hosts")))[0]!;
    const host = (await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "hosts", hostName)))!;
    const transport = await RuntimeTransport.connect(host.endpoint);
    try { const inventory = await transport.request({ type: "hello", credential: host.credential, workspaceId: host.workspaceId, instanceId: host.instanceId }); expect((inventory.sessions as unknown[])).toHaveLength(1); }
    finally { transport.close(); }
    expect((await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "guard.json")))?.pid).toBe(guard.pid);
  } finally { client.disposeAll(); await f.close(); }
}, 45000);

test("a competing actual legacy daemon blocks split startup and active/exited legacy views block migration", async () => {
  const f = await fixture();
  const old = spawnProcess(process.execPath, [oldBinary, "__craig-daemon", f.root], { cwd: f.root, env: f.env, stdio: "ignore" });
  let client: Awaited<ReturnType<typeof createDaemonPtyRuntime>> | undefined;
  try {
    await vi.waitFor(async () => expect((await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "ping" })).protocolVersion).toBe(10), { timeout: 10000 });
    await expect(bootstrapSplitRuntime(f.paths)).rejects.toThrow("legacy owner won startup");
    client = await createDaemonPtyRuntime({ paths: f.paths, workspaceRoot: f.root, resolveSessionSpec: () => ({ cwd: f.root, command: [process.execPath, "-e", "console.log('LEGACY_FINAL');process.exit(0)"] }) });
    await client.ensureSession("legacy", "legacy:agent", { columns: 120, rows: 24 });
    await expect(migrateEmptyLegacy(f.paths, true)).rejects.toThrow("inventory is live");
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.write("exit\r");
    await vi.waitFor(async () => expect((await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "getViewState", tabId: "legacy:agent" }) as unknown as { view: { status: string } }).view.status).toBe("exited"));
    await expect(migrateEmptyLegacy(f.paths, true)).rejects.toThrow("inventory is live");
    expect(old.exitCode).toBeNull();
  } finally {
    client?.disposeAll();
    if (old.exitCode === null) old.kill("SIGTERM");
    await new Promise<void>((resolve) => old.exitCode !== null || old.signalCode !== null ? resolve() : old.once("exit", () => resolve()));
    await f.close();
  }
}, 45000);


test("an empty pre-RFC owner needs explicit closed-client acknowledgement before guarded transition", async () => {
  const f = await fixture();
  const old = spawnProcess(process.execPath, [oldBinary, "__craig-daemon", f.root], { cwd: f.root, env: f.env, stdio: "ignore" });
  try {
    await vi.waitFor(async () => expect((await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "ping" })).sessionCount).toBe(0), { timeout: 10000 });
    await expect(migrateEmptyLegacy(f.paths)).rejects.toThrow("explicitly acknowledge");
    expect(old.exitCode).toBeNull();
    await migrateEmptyLegacy(f.paths, true);
    expect((await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "ping" })).protocolVersion).toBe(0);
    expect((await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "control.json")))?.ready).toBe(true);
  } finally { if (old.exitCode === null && old.signalCode === null) old.kill("SIGTERM"); await f.close(); }
}, 45000);

test("background Fury work blocks legacy migration even with zero sessions", async () => {
  const f = await fixture();
  let old: ReturnType<typeof spawnProcess> | undefined;
  try {
    const task = await writeTaskRecord(f.root, { id: "task_1", repoId: "repo_a", workspaceId: "workspace_repo_a", repoRoot: path.join(f.root, "repo"), worktreePath: path.join(f.root, "repo") });
    await appendTaskId(f.paths, task.id);
    await configService.save(f.paths, { previews: { agentOrchestration: true }, runners: { codex: { path: f.stub } } });
    const file = path.join(f.paths.craigDir, "fury", "fixture.yaml"); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "version: 1\nname: fixture-pending\nlimits: { max_concurrency: 1, max_tasks: 1, timeout: 10m }\nsteps:\n  review:\n    human_review: { title: Fixture, summary: Pending isolated review }\n");
    const actor = { type: "human" as const, source: "cli" as const, processId: process.pid };
    const plan = await createPlan(f.paths, file, {}, task.id, actor); await approvePlan(f.paths, plan.plan.id, actor);
    await runFury(f.paths, plan.plan.id, actor).catch(() => undefined); // Durable intent exists before any daemon.
    expect(await listFuryRuns(f.paths)).toHaveLength(1);
    old = spawnProcess(process.execPath, [oldBinary, "__craig-daemon", f.root], { cwd: f.root, env: f.env, stdio: "ignore" });
    await vi.waitFor(async () => expect((await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "ping" })).sessionCount).toBe(0), { timeout: 10000 });
    await expect(migrateEmptyLegacy(f.paths, true)).rejects.toThrow("Background legacy orchestration");
    expect(old.exitCode).toBeNull();
  } finally { if (old && old.exitCode === null && old.signalCode === null) old.kill("SIGTERM"); if (old) await new Promise<void>((resolve) => old!.exitCode !== null || old!.signalCode !== null ? resolve() : old!.once("exit", () => resolve())); await f.close(); }
}, 45000);


test("the lifecycle-aware empty bridge transitions without unconditional shutdown acknowledgement", async () => {
  const f = await fixture();
  let bridge: ReturnType<typeof spawnProcess> | undefined;
  try {
    const artifact = await pinRuntimeArtifact(f.paths);
    bridge = spawnProcess(process.execPath, [path.join(artifact, "cli.js"), "__craig-daemon", f.root], { cwd: f.root, env: f.env, stdio: "ignore" });
    await vi.waitFor(async () => expect((await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "ping" })).capabilities).toContain("drainEmpty"), { timeout: 10000 });
    await vi.waitFor(async () => expect(Number((await readFile(getPtyDaemonEndpoint(f.paths).pidPath, "utf8")).trim())).toBe(bridge!.pid));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await migrateEmptyLegacy(f.paths);
    expect((await runtimeRequest(getPtyDaemonEndpoint(f.paths).socketPath, { type: "ping" })).protocolVersion).toBe(0);
  } finally { if (bridge?.exitCode === null && bridge.signalCode === null) bridge.kill("SIGTERM"); await f.close(); }
}, 45000);
