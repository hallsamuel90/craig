import { createServer, type Server } from "node:net";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runCli } from "../src/commands/run.js";
import { configService } from "../src/domain/config/index.js";
import { ensureTaskCapabilities, revokeCapability } from "../src/domain/orchestration/index.js";
import * as capabilities from "../src/domain/orchestration/delegation/capabilities.js";
import { withTaskLock } from "../src/domain/task/adapters/task-lock.js";
import { getPtyDaemonEndpoint } from "../src/shell/pty-daemon-protocol.js";
import { createCraigState, createRepoRoot, writeTaskRecord } from "./test-helpers.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { protocol?: number; state?: string; fault?: "close" | "malformed" | "stall" } = {}) {
  const root = await createRepoRoot("craig-refresh-preflight-");
  roots.push(root);
  const paths = await createCraigState(root, ["task_1"]);
  const task = await writeTaskRecord(root, { id: "task_1", status: "running" });
  await configService.save(paths, { previews: { agentOrchestration: true } });
  const environment = await ensureTaskCapabilities(paths, task);
  const token = environment.CRAIG_AGENT_CAPABILITY!;
  const id = token.split(".")[0]!;
  const file = path.join(paths.orchestrationDir, "capabilities", `${id}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...record, expiresAt: "2020-01-01T00:00:00.000Z" }));
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        requests.push(request.type);
        if (options.fault === "close") { socket.destroy(); return; }
        if (options.fault === "stall") return;
        if (options.fault === "malformed") { socket.write("not-json\n"); return; }
        const response = JSON.stringify({
          id: request.id, ok: true,
          ...(request.type === "ping" ? { protocolVersion: options.protocol ?? 10 } : {
            activities: [{ taskId: task.id, tabId: task.ptyTabs[0]!.id, sessionState: options.state ?? "running" }],
          }),
        }) + "\n";
        // Ignore unsolicited events and handle replies split across packets.
        socket.write(JSON.stringify({ type: "activityRemoved", tabId: "other:agent" }) + "\n");
        const midpoint = Math.floor(response.length / 2);
        socket.write(response.slice(0, midpoint));
        setImmediate(() => { if (!socket.destroyed) socket.write(response.slice(midpoint)); });
        newline = buffer.indexOf("\n");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(getPtyDaemonEndpoint(paths).socketPath, resolve);
  });
  const run = async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli({
      argv: ["--json", "task", "children", task.id],
      cwd: root,
      env: { CRAIG_WORKSPACE_ROOT: root, CRAIG_TASK_ID: task.id, CRAIG_AGENT_TAB_ID: task.ptyTabs[0]!.id, ...environment },
      isInputTty: false, isOutputTty: false,
      writeStdout: (value) => { stdout.push(value); },
      writeStderr: (value) => { stderr.push(value); },
      runInteractive: async () => { throw new Error("Unexpected interactive launch."); },
    });
    return { stdout, stderr, exitCode };
  };
  return { paths, token, id, file, record, requests, run };
}

describe("agent capability refresh before CLI authorization", () => {
  test.each([6, 7, 8, 9, 10])("recovers an expired live-session token with protocol %i without restarting or retrying commands", async (protocol) => {
    const fixture = await setup({ protocol });
    const result = await fixture.run();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({ ok: true });
    const refreshed = JSON.parse(await readFile(fixture.file, "utf8"));
    expect(refreshed).toEqual({ ...fixture.record, expiresAt: refreshed.expiresAt });
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.now());
    expect(fixture.requests).toEqual(["ping", "setActivityEnabled", "getActivitySnapshots"]);
  });

  test.each(["exited", "failed", "unknown"])("keeps an expired %s session denied", async (state) => {
    const fixture = await setup({ state });
    const before = await readFile(fixture.file, "utf8");
    expect((await fixture.run()).exitCode).toBe(4);
    expect(await readFile(fixture.file, "utf8")).toBe(before);
  });

  test("keeps revoked tokens denied even with a live daemon", async () => {
    const fixture = await setup();
    await revokeCapability(fixture.paths, fixture.id, { type: "human", source: "cli", processId: 1 });
    expect((await fixture.run()).exitCode).toBe(4);
    expect(fixture.requests).toEqual([]);
  });

  test.each(["close", "malformed", "stall"] as const)("fails closed with a %s daemon", async (fault) => {
    const fixture = await setup({ fault });
    const before = await readFile(fixture.file, "utf8");
    const result = await fixture.run();
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr[0]!)).toMatchObject({ error: { code: "CAPABILITY_DENIED", details: { reason: "expired" } } });
    expect(await readFile(fixture.file, "utf8")).toBe(before);
  });

  test("rejects an incompatible daemon without refreshing", async () => {
    const fixture = await setup({ protocol: 1 });
    expect((await fixture.run()).exitCode).toBe(4);
    expect(fixture.requests).toEqual(["ping"]);
  });

  test("does not contact a daemon for a healthy token", async () => {
    const fixture = await setup({ fault: "stall" });
    await writeFile(fixture.file, JSON.stringify(fixture.record));
    expect((await fixture.run()).exitCode).toBe(0);
    expect(fixture.requests).toEqual([]);
  });

  test("a stalled daemon cannot block a still-valid command", async () => {
    const fixture = await setup({ fault: "stall" });
    const expiring = { ...fixture.record, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await writeFile(fixture.file, JSON.stringify(expiring));
    expect((await fixture.run()).exitCode).toBe(0);
    expect(JSON.parse(await readFile(fixture.file, "utf8"))).toEqual(expiring);
  });

  test("a refresh storage failure cannot fail a still-valid command", async () => {
    const fixture = await setup();
    const expiring = { ...fixture.record, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await writeFile(fixture.file, JSON.stringify(expiring));
    const refresh = vi.spyOn(capabilities, "refreshAgentCapability").mockRejectedValueOnce(new Error("Storage unavailable"));
    expect((await fixture.run()).exitCode).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(fixture.file, "utf8"))).toEqual(expiring);
  });

  test("an occupied task lock cannot hold a valid command behind a long task mutation", async () => {
    const fixture = await setup();
    const expiring = { ...fixture.record, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await writeFile(fixture.file, JSON.stringify(expiring));
    await withTaskLock(fixture.paths, "task_1", async () => {
      expect((await fixture.run()).exitCode).toBe(0);
    });
    expect(JSON.parse(await readFile(fixture.file, "utf8"))).toEqual(expiring);
  });
});
