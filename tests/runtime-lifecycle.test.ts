import { createHash } from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { describe, expect, test, vi } from "vitest";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { getPtyDaemonEndpoint } from "../src/shell/pty-daemon-protocol.js";
import { daemonStatus, runtimeRequest } from "../src/shell/runtime/discovery.js";
import { runtimeIdentity } from "../src/shell/runtime/identity.js";
import { LEGACY_PROFILES, resolveRuntimeCompatibility } from "../src/shell/runtime/compatibility.js";
import { acquireRuntimeLock, cleanupDeadEndpoint } from "../src/shell/runtime/ownership.js";
import { ensureDaemonAgentSession, wakeOrchestrationSupervisor } from "../src/shell/pty-daemon-orchestration.js";
import { requestOpenFile } from "../src/shell/ui-navigation.js";
import { tryConnectPtyDaemonActivity } from "../src/shell/pty-daemon-activity.js";
import { createDaemonPtyRuntime, requestDaemonShutdown, servePtyDaemon } from "../src/ui/pty/daemon.js";
import { runCli } from "../src/commands/run.js";
import { createPlan } from "../src/shell/fury-runtime.js";
import { createChildTaskAndSession } from "../src/shell/delegation.js";
import { createCraigState } from "./test-helpers.js";
import * as oldTui from "./fixtures/lifecycle/pre-rfc-tui.js";
import * as oldDelegated from "./fixtures/lifecycle/pre-rfc-delegated.js";
import type { RuntimeHello } from "../src/domain/runtime/types.js";

async function fixture(hello: RuntimeHello, respond = true) {
  const root = await mkdtemp(path.join(tmpdir(), "craig-lifecycle-"));
  const paths = getCraigPaths(root);
  await mkdir(paths.runtimeDir, { recursive: true });
  const endpoint = getPtyDaemonEndpoint(paths);
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        requests.push(request.type);
        if (respond) socket.write(`${JSON.stringify({ id: request.id, ok: true, ...(request.type === "ping" ? hello : {}), activities: [], deliveredCount: 1 })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint.socketPath, resolve));
  return { root, paths, endpoint, requests, server, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

describe("runtime lifecycle", () => {
  test.each([6, 7, 8, 9, 10])("profile %i is shared by terminal, activity, navigation and delegated clients", async (protocolVersion) => {
    const f = await fixture({ protocolVersion });
    try {
      const client = await createDaemonPtyRuntime({ paths: f.paths, workspaceRoot: f.root });
      expect(client.upgradePendingMessage).toContain("Existing sessions are preserved");
      client.disposeAll();
      const activity = await tryConnectPtyDaemonActivity({ paths: f.paths });
      expect(activity).not.toBeNull(); activity?.close();
      expect(await requestOpenFile(f.paths, "/tmp/example")).toBe(protocolVersion === 10);
      await ensureDaemonAgentSession(f.paths, { taskId: "task", tabId: "agent", cwd: f.root, command: ["unused"] });
      expect(await wakeOrchestrationSupervisor(f.paths)).toBe(protocolVersion >= 7);
      expect(f.requests).toContain("ensureSession");
      expect(f.requests.includes("openFile")).toBe(protocolVersion === 10);
      expect(f.requests).not.toContain("shutdown");
    } finally { await f.close(); }
  });

  test("explicit missing capabilities override legacy defaults before writes", async () => {
    const f = await fixture({ protocolVersion: 10, capabilities: [] });
    try {
      await expect(createDaemonPtyRuntime({ paths: f.paths, workspaceRoot: f.root })).rejects.toThrow("Missing capabilities");
      expect(await tryConnectPtyDaemonActivity({ paths: f.paths })).toBeNull();
      expect(await requestOpenFile(f.paths, "x")).toBe(false);
      await expect(ensureDaemonAgentSession(f.paths, { taskId: "t", tabId: "a", cwd: f.root, command: [] })).rejects.toThrow("Missing capabilities");
      await expect(createPlan(f.paths, "missing.yaml", {}, "missing", { type: "human", source: "cli", processId: process.pid })).rejects.toThrow("Missing capabilities");
      await expect(createChildTaskAndSession(f.paths, { parentTaskId: "missing", prompt: "must not provision" })).rejects.toThrow("Missing capabilities");
      expect(f.requests.every((request) => request === "ping")).toBe(true);
    } finally { await f.close(); }
  });

  test("release ordering never authorizes replacement; equal-release builds report conflict", () => {
    for (const [localVersion, remoteVersion] of [["1.0.0", "2.0.0"], ["2.0.0", "1.0.0"], ["development", "development"]]) {
      const result = resolveRuntimeCompatibility({ protocolVersion: 10, craigVersion: remoteVersion!, buildId: "remote" }, ["terminal"], { craigVersion: localVersion!, buildId: "local" });
      expect(result).toMatchObject({ compatible: true, upgradePending: true });
      if (localVersion === remoteVersion) expect(result.reason).toContain("build conflict");
    }
    expect(runtimeIdentity().buildId).toMatch(/^[a-f0-9]{64}$/);
    for (const protocolVersion of [0, 5, 11, 100]) expect(resolveRuntimeCompatibility({ protocolVersion }).compatible).toBe(false);
    expect(Object.keys(LEGACY_PROFILES)).toHaveLength(5);
  });

  test("status is versioned, read-only and starts nothing even with agent context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-status-"));
    const paths = getCraigPaths(root);
    try {
      const output: string[] = [];
      expect(await runCli({ argv: ["daemon", "status", "--json", "--workspace-root", root], cwd: root,
        env: { CRAIG_TASK_ID: "does-not-exist", CRAIG_AGENT_TAB_ID: "agent", CRAIG_AGENT_CAPABILITY: "invalid" },
        isInputTty: false, isOutputTty: false, writeStdout: (text) => output.push(text), writeStderr: (text) => output.push(text), runInteractive: async () => { throw new Error("unexpected TUI"); },
      })).toBe(0);
      expect(JSON.parse(output.join("")).data.state).toBe("absent");
      expect(await lstat(paths.runtimeDir).catch(() => null)).toBeNull();
      expect(await daemonStatus(paths)).toMatchObject({ schemaVersion: 1, state: "absent", runtime: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a zero-session ping never requests automatic shutdown", async () => {
    const f = await fixture({ protocolVersion: 0, sessionCount: 0 });
    const spawnDaemon = vi.fn();
    try {
      await expect(createDaemonPtyRuntime({ paths: f.paths, workspaceRoot: f.root, spawnDaemon })).rejects.toThrow("will not replace");
      expect(spawnDaemon).not.toHaveBeenCalled();
      expect(f.requests.every((request) => request === "ping")).toBe(true);
    } finally { await f.close(); }
  });

  test("unresponsive listeners with no PID record remain owned; direct startup cannot unlink them", async () => {
    const f = await fixture({}, false);
    const inode = (await lstat(f.endpoint.socketPath)).ino;
    try {
      expect(await daemonStatus(f.paths)).toMatchObject({ state: "unavailable" });
      await expect(servePtyDaemon(f.paths, { pullRequestSync: false })).rejects.toThrow("listener preserved");
      expect((await lstat(f.endpoint.socketPath)).ino).toBe(inode);
      await expect(ensureDaemonAgentSession(f.paths, { taskId: "t", tabId: "a", cwd: f.root, command: [] })).rejects.toThrow("unresponsive");
    } finally { await f.close(); }
  });

  test("cleanup refuses live PID, symlinks and ambiguous locks; old leases cannot remove replacement ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-owner-"));
    const paths = getCraigPaths(root); await mkdir(paths.runtimeDir, { recursive: true });
    const endpoint = getPtyDaemonEndpoint(paths);
    try {
      await writeFile(endpoint.pidPath, String(process.pid));
      await expect(cleanupDeadEndpoint(paths)).rejects.toThrow("live or ambiguous");
      expect(await readFile(endpoint.pidPath, "utf8")).toBe(String(process.pid));
      const release = await acquireRuntimeLock(paths, "test");
      const ownerPath = path.join(paths.runtimeDir, "test.lock", "owner.json");
      const replacement = JSON.stringify({ pid: process.pid, token: "replacement" });
      await writeFile(ownerPath, replacement); await release();
      expect(await readFile(ownerPath, "utf8")).toBe(replacement);
      await mkdir(path.join(paths.runtimeDir, "dead.lock"));
      await writeFile(path.join(paths.runtimeDir, "dead.lock", "owner.json"), JSON.stringify({ pid: 999999, token: "fixture-dead-owner" }));
      const releaseDead = await acquireRuntimeLock(paths, "dead");
      expect(JSON.parse(await readFile(path.join(paths.runtimeDir, "dead.lock", "owner.json"), "utf8")).pid).toBe(process.pid);
      await releaseDead();
      const target = path.join(root, "private-record");
      await writeFile(target, "preserve-me");
      await rm(endpoint.pidPath);
      await symlink(target, endpoint.pidPath);
      await expect(cleanupDeadEndpoint(paths)).rejects.toThrow("Unsafe runtime endpoint");
      expect(await readFile(target, "utf8")).toBe("preserve-me");
      await mkdir(path.join(paths.runtimeDir, "ambiguous.lock"));
      await expect(acquireRuntimeLock(paths, "ambiguous")).rejects.toThrow("ambiguous");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("actual pre-RFC TUI and delegated startup reject successful protocol-0 ping without spawning", async () => {
    const f = await fixture({ protocolVersion: 0, sessionCount: 0 });
    // The frozen delegated launcher resolves this fixture-only path itself.
    const second: Server = createServer((socket) => {
      socket.on("data", (chunk) => { const request = JSON.parse(String(chunk)); socket.end(`${JSON.stringify({ id: request.id, ok: true, protocolVersion: 0, sessionCount: 0 })}\n`); });
    });
    await new Promise<void>((resolve) => second.listen(path.join(f.paths.runtimeDir, "fixture.sock"), resolve));
    try {
      const spawn = vi.fn();
      await expect(oldTui.ensureDaemonRunning(f.endpoint, f.paths, spawn)).rejects.toThrow("will not replace");
      await expect(oldDelegated.ensureDaemonRunning(f.paths)).rejects.toThrow("incompatible");
      expect(spawn).not.toHaveBeenCalled();
      expect(oldTui.spawnCount()).toBe(0); expect(oldDelegated.spawnCount()).toBe(0);
      expect(f.requests).not.toContain("shutdown");
    } finally { await new Promise<void>((resolve) => second.close(() => resolve())); await f.close(); }
  });

  test("bridge rejects drain with retained sessions and admits atomic empty shutdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-drain-"));
    const paths = await createCraigState(root, []);
    const daemon = servePtyDaemon(paths);
    const endpoint = getPtyDaemonEndpoint(paths);
    try {
      await vi.waitFor(async () => expect((await daemonStatus(paths)).state).toBe("ready"));
      const client = await createDaemonPtyRuntime({ paths, workspaceRoot: root, resolveSessionSpec: () => ({ cwd: root, command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }) });
      await client.ensureSession("fixture", "fixture:agent", { columns: 80, rows: 24 });
      expect(await runtimeRequest(endpoint.socketPath, { type: "drainIfEmpty" })).toMatchObject({ ok: false });
      expect((await daemonStatus(paths)).state).toBe("ready");
      client.disposeSession("fixture:agent");
      await vi.waitFor(async () => expect((await daemonStatus(paths)).runtime?.sessionCount).toBe(0));
      client.disposeAll();
      expect(await runtimeRequest(endpoint.socketPath, { type: "drainIfEmpty" })).toMatchObject({ ok: true });
      await daemon;
      expect((await daemonStatus(paths)).state).toBe("absent");
    } finally { await requestDaemonShutdown(paths); await daemon; await rm(root, { recursive: true, force: true }); }
  });

  test("drain closes admission before inventory awaits, excluding a racing zero-inventory launch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-drain-race-"));
    const paths = await createCraigState(root, []);
    const spawn = vi.fn(() => { throw new Error("A draining runtime must not spawn."); });
    const daemon = servePtyDaemon(paths, { pullRequestSync: false, spawn });
    const endpoint = getPtyDaemonEndpoint(paths);
    const responses: Array<{ id: number; ok: boolean; error?: string }> = [];
    let socket: Socket | undefined;
    try {
      const client = await createDaemonPtyRuntime({ paths, workspaceRoot: root });
      client.disposeAll();
      socket = createConnection(endpoint.socketPath);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          responses.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        }
      });
      await new Promise<void>((resolve) => socket!.once("connect", resolve));
      socket.write(`${JSON.stringify({ id: 1, type: "drainIfEmpty" })}\n${JSON.stringify({ id: 2, type: "ensureSession", taskId: "fixture", tabId: "fixture:agent", size: { columns: 80, rows: 24 }, spec: { cwd: root, command: [] } })}\n`);
      await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({ id: 2, ok: false, error: expect.stringContaining("draining") })));
      expect(spawn).not.toHaveBeenCalled();
      await daemon;
    } finally { socket?.destroy(); await requestDaemonShutdown(paths); await daemon; await rm(root, { recursive: true, force: true }); }
  });

  test("real pre-RFC daemon preserves the agent PID, cwd, nonce, memory, final output and scrollback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-live-legacy-"));
    const paths = await createCraigState(root, []);
    const require = createRequire(import.meta.url);
    const original = await readFile(path.resolve("tests/fixtures/lifecycle/pre-rfc-daemon.ts.txt"), "utf8");
    expect(createHash("sha256").update(original).digest("hex")).toBe("06709776f5a0c6b6269f16c97232ada45c8fa2521b4159f971d4f903d5843869");
    const bundle = path.join(root, "legacy.mjs");
    await mkdir(path.join(root, "node_modules"));
    await symlink(path.dirname(require.resolve("node-pty/package.json")), path.join(root, "node_modules", "node-pty"));
    await build({ stdin: { contents: `${original}\nimport { getCraigPaths } from "../../state/craig-paths.js";\nawait servePtyDaemon(getCraigPaths(process.argv[2]!), { pullRequestSync: false });`, resolveDir: path.resolve("src/ui/pty"), loader: "ts" },
      outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
      banner: { js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url);' },
      plugins: [{ name: "fixture-dependencies", setup(builder) { builder.onResolve({ filter: /^(node-pty|@xterm\/headless|picocolors|terminal-kit)$/ }, (args) => ({ path: require.resolve(args.path), external: true })); } }],
    });
    const agent = path.join(root, "agent.cjs");
    await writeFile(agent, `const rl = require('node:readline').createInterface({ input: process.stdin });
const nonce = require('node:crypto').randomUUID(); let memory = '';
function identity() { const tty = require('node:fs').fstatSync(0); return {pid:process.pid,cwd:process.cwd(),nonce,ptyDevice:tty.rdev,ptyInode:tty.ino}; }
console.log('IDENTITY ' + JSON.stringify(identity()));
rl.on('line', line => { if(line.startsWith('remember ')) { memory = line.slice(9); console.log('remembered'); }
if(line === 'recall') { console.log('MEMORY ' + memory + ' ' + nonce); console.log('CURRENT ' + JSON.stringify(identity())); }
if(line === 'finish') { for(let i=0;i<80;i++) console.log('scroll-line-' + i); console.log('FINAL ' + memory + ' ' + nonce); process.exit(0); } });`);
    const child = spawn(process.execPath, [bundle, root], { cwd: root, env: { ...process.env, CRAIG_WORKSPACE_ROOT: root }, stdio: "pipe" });
    let logs = ""; child.stderr.on("data", (chunk) => { logs += String(chunk); });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const connect = () => createDaemonPtyRuntime({ paths, workspaceRoot: root, resolveSessionSpec: () => ({ cwd: root, command: [process.execPath, agent] }) });
    let first: Awaited<ReturnType<typeof connect>> | undefined;
    let second: Awaited<ReturnType<typeof connect>> | undefined;
    const text = (client: NonNullable<typeof first>) => client.getViewState("task:agent").rows.map((row) => row.segments.map((s) => s.text).join("")).join("\n");
    try {
      await vi.waitFor(async () => expect((await daemonStatus(paths)).state, logs).toBe("ready"), { timeout: 5000 });
      first = await connect();
      await first.ensureSession("task", "task:agent", { columns: 400, rows: 30 }); first.setViewedTab("task:agent");
      await vi.waitFor(() => expect(text(first!)).toMatch(/IDENTITY \{[^\n]+\}/));
      const identity = JSON.parse(text(first).match(/IDENTITY (\{[^\n]+\})/)![1]!);
      expect(identity.cwd).toBe(await realpath(root));
      first.write("remember state-only-in-agent-memory\r");
      await vi.waitFor(() => expect(text(first!)).toContain("remembered"));
      first.disposeAll(); first = undefined;
      second = await connect();
      await second.ensureSession("task", "task:agent", { columns: 400, rows: 30 }); second.setViewedTab("task:agent");
      await second.pruneStale([]);
      expect((await daemonStatus(paths)).upgradePending).toBe(true);
      const blocked = await runtimeRequest(getPtyDaemonEndpoint(paths).socketPath, { type: "drainIfEmpty" });
      expect(blocked.ok).toBe(false); // The actual old daemon knows no drain operation.
      second.write("recall\r");
      await vi.waitFor(() => expect(text(second!)).toContain(`MEMORY state-only-in-agent-memory ${identity.nonce}`));
      await vi.waitFor(() => expect(text(second!)).toMatch(/CURRENT \{[^\n]+\}/));
      const after = JSON.parse(text(second).match(/CURRENT (\{[^\n]+\})/)![1]!);
      expect(after).toEqual(identity); process.kill(identity.pid, 0);
      second.write("finish\r");
      await vi.waitFor(() => expect(text(second!)).toContain(`FINAL state-only-in-agent-memory ${identity.nonce}`));
      second.disposeAll(); second = await connect();
      await second.hydrateSessions(["task:agent"]);
      expect(text(second)).toContain(`FINAL state-only-in-agent-memory ${identity.nonce}`);
      await second.ensureSession("task", "task:agent", { columns: 400, rows: 30 });
      second.scrollViewport(-10000);
      await vi.waitFor(() => expect(text(second!)).toContain("IDENTITY"));
      expect(text(second)).toContain("remembered");
      second.scrollViewport(10000);
      await vi.waitFor(() => expect(text(second!)).toContain(`FINAL state-only-in-agent-memory ${identity.nonce}`));
      process.stdout.write(`legacy-continuity-evidence ${JSON.stringify({ before: identity, after, memoryRetained: true, finalOutputRetained: true, scrollbackRetained: true })}\n`);
    } finally {
      first?.disposeAll(); second?.disposeAll();
      await requestDaemonShutdown(paths);
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
