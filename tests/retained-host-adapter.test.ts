import { extractRuntimeSnapshot } from "./runtime-snapshots.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { createCraigState } from "./test-helpers.js";
import { stopFixtureRuntimes } from "./runtime-fixtures.js";
import { pinRuntimeArtifact } from "../src/shell/runtime/artifacts.js";
import { newRuntimeRecord, readPrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { launchRuntimeRole, awaitRuntimeRole } from "../src/shell/runtime/bootstrap.js";
import { ensureRuntimeRunning } from "../src/shell/runtime/start.js";
import { restartDaemon } from "../src/shell/runtime/replacement.js";
import { RuntimeTransport } from "../src/shell/runtime/wire.js";
import { createDaemonPtyRuntime } from "../src/ui/pty/daemon.js";
const execute = promisify(execFile);

test("the frozen phase-2 protocol-1 host is adapted across replacement and retained when atomic retirement is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "craig-retained-host-adapter-")).then((value) => realpath(value));
  const workspace = path.join(root, "workspace"); await mkdir(workspace); const paths = await createCraigState(workspace, []);
  const cache = path.join(root, "cache"); const previous = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = cache;
  let client: Awaited<ReturnType<typeof createDaemonPtyRuntime>> | undefined;
  try {
    await ensureRuntimeRunning(paths);
    const source = path.join(root, "frozen-phase2"); await mkdir(source);
    await extractRuntimeSnapshot("phase2-runtime", source); await symlink(path.resolve("node_modules"), path.join(source, "node_modules"));
    await execute("pnpm", ["build:npm"], { cwd: source });
    const artifact = await pinRuntimeArtifact(paths, path.join(source, "packages/cli/dist/cli.js"));
    const old = await newRuntimeRecord(paths, "host", artifact); const file = path.join(paths.runtimeDir, "hosts", `${old.instanceId}.json`);
    const child = await launchRuntimeRole(paths, old, file); const host = await awaitRuntimeRole(file, child);
    await restartDaemon(paths); // New controller discovers/adopts the old generation.
    let controller = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!;
    const transport = await RuntimeTransport.connect(host.endpoint);
    const identity = { taskId: "old-fixture", tabId: "old-fixture:agent", sessionId: "old-session", creationId: "old-create" };
    try {
      await transport.request({ type: "ensure", credential: host.credential, instanceId: host.instanceId, workspaceId: host.workspaceId, controllerId: controller.instanceId, session: identity, size: { columns: 120, rows: 24 }, spec: { cwd: workspace, command: [process.execPath, "-e", "console.log('RETAINED_OLD_HOST_FINAL')"] } });
      await vi.waitFor(async () => expect(((await transport.request({ type: "enumerate", credential: host.credential, instanceId: host.instanceId, workspaceId: host.workspaceId, controllerId: controller.instanceId })).sessions as Array<{ status: string }>)[0]?.status).toBe("exited"));
    } finally { transport.close(); }
    await restartDaemon(paths); // Uses idempotent hold fallback for missing adoptHold.
    controller = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!;
    await new Promise((resolve) => setTimeout(resolve, 1300)); // A retirement check has actually run.
    expect((await readPrivateRecord<RuntimeRecord>(file))?.retired).not.toBe(true); process.kill(host.pid, 0);
    client = await createDaemonPtyRuntime({ paths, workspaceRoot: workspace }); await client.ensureSession(identity.taskId, identity.tabId, { columns: 120, rows: 24 });
    expect(client.getViewState(identity.tabId).status).toBe("exited");
    expect(client.getViewState(identity.tabId).rows.flatMap((row) => row.segments.map((segment) => segment.text)).join("")).toContain("RETAINED_OLD_HOST_FINAL");
  } finally {
    client?.disposeAll(); await stopFixtureRuntimes(paths, cache);
    if (previous === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
