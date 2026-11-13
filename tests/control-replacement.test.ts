import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createCraigState } from "./test-helpers.js";
import { createDaemonPtyRuntime } from "../src/ui/pty/daemon.js";
import { materializeRuntimeDependencies, pinRuntimeArtifact } from "../src/shell/runtime/artifacts.js";
import { readPrivateRecord, writePrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { daemonStatus, runtimeRequest } from "../src/shell/runtime/discovery.js";
import { replaceControlUnderLock, recoverReplacementUnderLock, compareRuntimeReleases } from "../src/shell/runtime/replacement.js";
import { acquireRuntimeLock } from "../src/shell/runtime/ownership.js";
import { RuntimeTransport } from "../src/shell/runtime/wire.js";
import { stopFixtureRuntimes } from "./runtime-fixtures.js";
const execute = promisify(execFile);
let packages: string;
const binaries: Record<string, string> = {};
beforeAll(async () => {
  packages = await mkdtemp(path.join(tmpdir(), "craig-replacement-packages-")).then((value) => realpath(value));
  for (const [name, version, banner] of [["a", "0.21.0", ""], ["b", "0.22.0", ""], ["equal", "0.21.0", ""], ["bad", "0.22.0", "if(process.argv[2]==='__craig-runtime-role'&&process.argv[3]==='control'){process.stderr.write('fixture startup failure');process.exit(1)}"]]) {
    const directory = path.join(packages, name!); await mkdir(directory);
    const outfile = path.join(directory, "cli.js"); binaries[name!] = outfile;
    await build({ entryPoints: [path.resolve("src/cli.ts")], outfile, bundle: true, minify: true, platform: "node", format: "esm", target: "node22", external: ["@xterm/headless", "node-pty", "picocolors", "terminal-kit"], define: { __CRAIG_VERSION__: JSON.stringify(version), __CRAIG_BUILD_ID__: JSON.stringify(`fixture-${name}`), __CRAIG_HOST_REVISION__: JSON.stringify("fixture-host-v1") }, alias: { yaml: path.resolve("node_modules/yaml/browser/index.js") }, banner: { js: banner! } });
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    await materializeRuntimeDependencies(path.resolve("package.json"), directory);
  }
}, 45000);
afterAll(async () => { await rm(packages, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craig-control-upgrade-")).then((value) => realpath(value));
  const paths = await createCraigState(root, []); const cache = path.join(root, "cache");
  const previousCache = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = cache;
  const env = { ...process.env, CRAIG_RUNTIME_CACHE: cache, CRAIG_WORKSPACE_ROOT: root };
  await execute(process.execPath, [binaries.a!, "__craig-runtime-bootstrap", root], { cwd: root, env });
  const control = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!;
  const guard = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "guard.json")))!;
  const hostFile = path.join(paths.runtimeDir, "hosts", (await readdir(path.join(paths.runtimeDir, "hosts")))[0]!);
  const host = (await readPrivateRecord<RuntimeRecord>(hostFile))!;
  const messages: Array<string | null> = [];
  const client = await createDaemonPtyRuntime({ paths, workspaceRoot: root, viewClient: { clientId: "upgrade-view", proof: "upgrade-proof" }, onLifecycle: (message) => messages.push(message), resolveSessionSpec: () => ({ cwd: root, command: [process.execPath, "-e", `const fs=require('node:fs');const nonce=require('node:crypto').randomUUID();let memory='';let turns=0;let busy=false;setInterval(()=>{if(busy){turns++;if(turns%10===0)console.log('TURN_PROGRESS '+turns)}},10);const id=()=>{const tty=fs.fstatSync(0);return {pid:process.pid,cwd:process.cwd(),nonce,dev:tty.dev,ino:tty.ino}};console.log('IDENTITY '+JSON.stringify(id()));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(line.startsWith('remember ')){memory=line.slice(9);console.log('REMEMBERED')};if(line==='begin-turn'){busy=true;console.log('TURN_STARTED')};if(line==='recall'){console.log('CURRENT '+JSON.stringify(id()));console.log('MEMORY '+memory);console.log('TURN_COUNT '+turns)};if(line==='exit-on-marker'){console.log('SCHEDULED');setInterval(()=>{if(fs.existsSync('finish-agent')){for(let i=0;i<80;i++)console.log('retained-'+i);console.log('FINAL '+memory+' '+nonce);process.exit(0)}},20)};if(line==='count')console.log('INPUT_COUNT')});`] }) });
  await client.ensureSession("fixture", "fixture:agent", { columns: 300, rows: 30 }); client.setViewedTab("fixture:agent");
  const screen = () => client.getViewState("fixture:agent").rows.map((row) => row.segments.map((part) => part.text).join("")).join("\n");
  await vi.waitFor(() => expect(screen()).toContain("IDENTITY")); const identity = JSON.parse(screen().match(/IDENTITY (\{[^\n]+\})/)![1]!);
  client.write("remember live-turn-state\r"); await vi.waitFor(() => expect(screen()).toContain("REMEMBERED"));
  client.write("begin-turn\r"); await vi.waitFor(() => expect(screen()).toContain("TURN_PROGRESS"));
  const beforeTurnCount = Number([...screen().matchAll(/TURN_PROGRESS (\d+)/g)].at(-1)![1]);
  const replace = async (artifact: string, explicit = true, checkpoint?: NonNullable<Parameters<typeof replaceControlUnderLock>[2]>["checkpoint"]) => {
    const release = await acquireRuntimeLock(paths, "lifecycle");
    try { return await replaceControlUnderLock(paths, explicit, { artifact, ...(checkpoint ? { checkpoint } : {}) }); } finally { await release(); }
  };
  return { root, paths, env, cache, control, guard, host, hostFile, client, screen, identity, beforeTurnCount, messages, replace, artifact: (name: string) => pinRuntimeArtifact(paths, binaries[name]), async close() {
    client.disposeAll(); await stopFixtureRuntimes(paths, cache);
    if (previousCache === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previousCache;
    await rm(root, { recursive: true, force: true });
  } };
}

test("two newer-release invocations serialize; an existing client reconnects with the same live agent and old clients never downgrade", async () => {
  const f = await fixture();
  try {
    const readOnly = await execute(process.execPath, [binaries.b!, "--workspace-root", f.root, "daemon", "status", "--json"], { cwd: f.root, env: f.env });
    expect(JSON.parse(readOnly.stdout).data.runtime.buildId).toBe("fixture-a");
    await Promise.all([1, 2].map(() => execute(process.execPath, [binaries.b!, "__craig-runtime-bootstrap", f.root], { cwd: f.root, env: f.env })));
    await vi.waitFor(() => expect(f.client.connectionMessage ?? "").not.toContain("Reconnecting"));
    await vi.waitFor(async () => expect((await daemonStatus(f.paths)).runtime?.buildId).toBe("fixture-b"));
    await vi.waitFor(() => expect(f.messages.some((message) => message?.includes("Reconnecting"))).toBe(true));
    f.client.write("recall\r"); await vi.waitFor(() => expect(f.screen()).toContain("MEMORY live-turn-state"));
    expect(JSON.parse(f.screen().match(/CURRENT (\{[^\n]+\})/)![1]!)).toEqual(f.identity);
    const afterTurnCount = Number(f.screen().match(/TURN_COUNT (\d+)/)![1]);
    expect(afterTurnCount).toBeGreaterThan(f.beforeTurnCount);
    expect((await readPrivateRecord<RuntimeRecord>(f.hostFile))?.pid).toBe(f.host.pid);
    const next = (await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "control.json")))!;
    expect(next.pid).not.toBe(f.control.pid);
    expect(JSON.parse(await readFile(path.join(f.paths.runtimeDir, "orchestration-supervisor.lock", "owner.json"), "utf8")).pid).toBe(next.pid);
    await execute(process.execPath, [binaries.a!, "__craig-runtime-bootstrap", f.root], { cwd: f.root, env: f.env });
    expect((await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "control.json")))?.pid).toBe(next.pid);
    expect((await f.replace(await f.artifact("a"))).state).toBe("unchanged");
    expect((await runtimeRequest(f.guard.endpoint, { type: "ping" })).protocolVersion).toBe(0);
    process.stdout.write(`control-upgrade-evidence ${JSON.stringify({ oldControl: f.control.pid, newControl: next.pid, host: f.host.pid, ...f.identity, oldBuild: "fixture-a", newBuild: "fixture-b", beforeTurnCount: f.beforeTurnCount, afterTurnCount, memory: true })}\n`);
  } finally { await f.close(); }
}, 45000);

test.each([false, true])("handoff retains an exited final view with every foreground socket dropped; rollback: %s", async (rollback) => {
  const f = await fixture();
  try {
    const artifact = await f.artifact(rollback ? "bad" : "b");
    f.client.write("exit-on-marker\r"); await vi.waitFor(() => expect(f.screen()).toContain("SCHEDULED"));
    const result = await f.replace(artifact, true, async (stage) => {
      if (stage === "released") {
        await writeFile(path.join(f.root, "finish-agent"), "exit");
        await vi.waitFor(() => expect(() => process.kill(f.identity.pid, 0)).toThrow());
        expect((await runtimeRequest(f.guard.endpoint, { type: "ping" })).protocolVersion).toBe(0);
        return;
      }
      if (stage !== "prepared") return;
      await vi.waitFor(() => expect(f.client.connectionMessage).toContain("updating"));
      f.client.write("count\r"); // The closed gate rejects this key visibly.
      await vi.waitFor(() => expect(f.messages.some((message) => message?.includes("not sent"))).toBe(true));
      f.client.disposeAll();
      // Independently schedule exit on the retained host before readiness.
      const transport = await RuntimeTransport.connect(f.host.endpoint);
      try {
        const inv = await transport.request({ type: "hello", credential: f.host.credential, instanceId: f.host.instanceId, workspaceId: f.host.workspaceId });
        expect(inv.handoffHoldCount).toBeGreaterThan(0);
      } finally { transport.close(); }
    });
    expect(result.state).toBe(rollback ? "rolled_back" : "restarted");
    expect((await runtimeRequest(f.guard.endpoint, { type: "ping" })).protocolVersion).toBe(0);
    const observer = await createDaemonPtyRuntime({ paths: f.paths, workspaceRoot: f.root, viewClient: { clientId: "upgrade-view", proof: "upgrade-proof" } });
    try {
      await observer.hydrateSessions(["fixture:agent"]); await observer.ensureSession("fixture", "fixture:agent", { columns: 300, rows: 30 });
      const screen = () => observer.getViewState("fixture:agent").rows.map((row) => row.segments.map((part) => part.text).join("")).join("\n");
      expect(observer.getViewState("fixture:agent").status).toBe("exited");
      expect(screen()).toContain(`FINAL live-turn-state ${f.identity.nonce}`);
      observer.scrollViewport(-10000); await vi.waitFor(() => expect(screen()).toContain("IDENTITY"));
      expect(JSON.parse(screen().match(/IDENTITY (\{[^\n]+\})/)![1]!)).toEqual(f.identity);
    } finally { observer.disposeAll(); }
    expect((await readPrivateRecord<RuntimeRecord>(f.hostFile))?.pid).toBe(f.host.pid);
  } finally { await f.close(); }
}, 45000);

test("equal-release builds require explicit restart; unsupported durable or host records block before draining", async () => {
  const f = await fixture();
  try {
    expect((await f.replace(await f.artifact("equal"), false)).state).toBe("unchanged");
    const operations = path.join(f.paths.craigDir, "operations", "task-create"); await mkdir(operations, { recursive: true });
    const invalid = path.join(operations, "future.json"); await writeFile(invalid, JSON.stringify({ schemaVersion: 999 }), { mode: 0o600 });
    await expect(f.replace(await f.artifact("b"))).rejects.toThrow();
    await execute(process.execPath, [binaries.b!, "__craig-runtime-bootstrap", f.root], { cwd: f.root, env: f.env });
    expect((await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "control.json")))?.pid).toBe(f.control.pid);
    f.client.write("recall\r"); await vi.waitFor(() => expect(f.screen()).toContain("MEMORY live-turn-state"));
    await rm(invalid);
    await writePrivateRecord(f.hostFile, { ...f.host, schemaVersion: 999 });
    await expect(f.replace(await f.artifact("b"))).rejects.toThrow(); await writePrivateRecord(f.hostFile, f.host);
    const endpoint = path.join(path.dirname(f.host.endpoint), "future-host.sock");
    const unknownHost = createServer((socket) => { socket.on("error", () => undefined); socket.on("data", (data) => { const frame = JSON.parse(String(data)); socket.write(JSON.stringify({ id: frame.id, ok: true, instanceId: f.host.instanceId, hostProtocol: 999 }) + "\n"); }); });
    await new Promise<void>((resolve) => unknownHost.listen(endpoint, resolve));
    try {
      await writePrivateRecord(f.hostFile, { ...f.host, endpoint });
      await expect(f.replace(await f.artifact("b"))).rejects.toThrow("Unsupported live host protocol");
    } finally { await writePrivateRecord(f.hostFile, f.host); await new Promise<void>((resolve) => unknownHost.close(() => resolve())); }
    expect((await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "control.json")))?.pid).toBe(f.control.pid);
    const restarted = await execute(process.execPath, [binaries.equal!, "--workspace-root", f.root, "daemon", "restart", "--json"], { cwd: f.root, env: f.env });
    expect(JSON.parse(restarted.stdout).data).toMatchObject({ kind: "daemonRestart", state: "restarted", buildId: "fixture-equal" });
  } finally { await f.close(); }
}, 45000);

test("five-second drain timeout reopens admission and never cancels admitted work", async () => {
  const f = await fixture();
  const transport = await RuntimeTransport.connect(f.control.endpoint);
  try {
    const { token } = await transport.request({ type: "beginMutation" });
    const started = Date.now();
    await expect(f.replace(await f.artifact("b"))).rejects.toThrow("drain timed out");
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    expect((await daemonStatus(f.paths)).state).toBe("ready");
    await transport.request({ type: "endMutation", token });
    f.client.write("recall\r"); await vi.waitFor(() => expect(f.screen()).toContain("MEMORY live-turn-state"));
    expect((await readPrivateRecord<RuntimeRecord>(path.join(f.paths.runtimeDir, "control.json")))?.pid).toBe(f.control.pid);
  } finally { transport.close(); await f.close(); }
}, 45000);

test("an interrupted manager after old-control exit rolls back under the lifecycle lock with holds intact", async () => {
  const f = await fixture();
  try {
    await expect(f.replace(await f.artifact("b"), true, async (stage) => { if (stage === "released") throw new Error("Fixture manager lost after release"); })).rejects.toThrow("manager lost");
    const release = await acquireRuntimeLock(f.paths, "lifecycle");
    try { await recoverReplacementUnderLock(f.paths); } finally { await release(); }
    await vi.waitFor(() => expect(f.client.connectionMessage ?? "").not.toContain("Reconnecting"));
    f.client.write("recall\r"); await vi.waitFor(() => expect(f.screen()).toContain("MEMORY live-turn-state"));
    expect((await readPrivateRecord<RuntimeRecord>(f.hostFile))?.pid).toBe(f.host.pid);
    expect((await daemonStatus(f.paths)).runtime?.buildId).toBe("fixture-a");
    expect((await runtimeRequest(f.guard.endpoint, { type: "ping" })).protocolVersion).toBe(0);
  } finally { await f.close(); }
}, 45000);

test("input is visibly paused through the control gap and never queued for replay", async () => {
  const f = await fixture();
  try {
    await f.replace(await f.artifact("b"), true, async (stage) => {
      if (stage !== "released") return;
      await vi.waitFor(() => expect(f.client.connectionMessage).toContain("Reconnecting"));
      f.client.write("count\r");
      expect(f.client.connectionMessage).toContain("this key was not sent");
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await vi.waitFor(() => expect(f.client.connectionMessage ?? "").not.toContain("reconnecting"));
    f.client.write("recall\r"); await vi.waitFor(() => expect(f.screen()).toContain("MEMORY live-turn-state"));
    expect(f.screen()).not.toContain("INPUT_COUNT");
    expect(JSON.parse(f.screen().match(/CURRENT (\{[^\n]+\})/)![1]!)).toEqual(f.identity);
  } finally { await f.close(); }
}, 45000);

test("release ordering prevents prerelease downgrades and ignores build metadata", () => {
  expect(compareRuntimeReleases("1.0.0-beta.2", "1.0.0")).toBe(-1);
  expect(compareRuntimeReleases("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
  expect(compareRuntimeReleases("1.0.0+checkout-b", "1.0.0+checkout-a")).toBe(0);
  expect(compareRuntimeReleases("development", "1.0.0")).toBeNull();
});

test("control authentication and transaction ownership prevent a competing prepare or abort from reopening admission", async () => {
  const f = await fixture();
  const admission = await RuntimeTransport.connect(f.control.endpoint);
  const lifecycle = await RuntimeTransport.connect(f.control.endpoint);
  const competitor = await RuntimeTransport.connect(f.control.endpoint);
  const auth = { credential: f.control.credential, instanceId: f.control.instanceId, workspaceId: f.control.workspaceId };
  try {
    await expect(competitor.request({ type: "prepareReplacement", ...auth, credential: "wrong", transactionId: "competitor" })).rejects.toThrow("authentication");
    const { token } = await admission.request({ type: "beginMutation" });
    const pending = lifecycle.request({ type: "prepareReplacement", ...auth, transactionId: "owner" }, 6500);
    await vi.waitFor(async () => expect((await daemonStatus(f.paths)).state).toBe("draining"));
    await expect(competitor.request({ type: "prepareReplacement", ...auth, transactionId: "competitor" })).rejects.toThrow("owns the drain");
    await expect(competitor.request({ type: "abortReplacement", ...auth, transactionId: "competitor" })).rejects.toThrow("owns the drain");
    expect((await daemonStatus(f.paths)).state).toBe("draining");
    await admission.request({ type: "endMutation", token }); await pending;
    await lifecycle.request({ type: "abortReplacement", ...auth, transactionId: "owner" });
    expect((await daemonStatus(f.paths)).state).toBe("ready");
  } finally { admission.close(); lifecycle.close(); competitor.close(); await f.close(); }
}, 45000);

test("an admitted close can confirm disposal while draining, and an unknown admission token is rejected", async () => {
  const f = await fixture();
  const admitted = await RuntimeTransport.connect(f.control.endpoint);
  const lifecycle = await RuntimeTransport.connect(f.control.endpoint);
  try {
    const { token } = await admitted.request({ type: "beginMutation" });
    const draining = lifecycle.request({ type: "prepareReplacement", credential: f.control.credential, instanceId: f.control.instanceId, workspaceId: f.control.workspaceId, transactionId: "admitted-close" }, 6500);
    await vi.waitFor(async () => expect((await daemonStatus(f.paths)).state).toBe("draining"));
    await expect(admitted.request({ type: "disposeSession", tabId: "fixture:agent", admissionToken: "invalid" })).rejects.toThrow("another control");
    const { runtimeMutationContext } = await import("../src/shell/runtime/mutation-context.js");
    await runtimeMutationContext.run(String(token), () => f.client.disposeSessionConfirmed("fixture:agent"));
    expect(f.client.getViewState("fixture:agent").status).toBe("idle");
    await admitted.request({ type: "endMutation", token }); await draining;
    await lifecycle.request({ type: "abortReplacement", credential: f.control.credential, instanceId: f.control.instanceId, workspaceId: f.control.workspaceId, transactionId: "admitted-close" });
  } finally { admitted.close(); lifecycle.close(); await f.close(); }
}, 45000);
