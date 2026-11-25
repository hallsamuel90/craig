import { tryConnectPtyDaemonActivity, type PtyDaemonActivityClient } from "../src/shell/pty-daemon-activity.js";
import { stopFixtureRuntimes } from "./runtime-fixtures.js";
import { mkdtemp, readFile, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, expect, vi } from "vitest";
import { createCraigState } from "./test-helpers.js";
import { createDaemonPtyRuntime, requestDaemonShutdown } from "../src/ui/pty/daemon.js";
import { readPrivateRecord, writePrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { ensureRuntimeRunning } from "../src/shell/runtime/start.js";
import { daemonStatus } from "../src/shell/runtime/discovery.js";
import { getPtyDaemonEndpoint } from "../src/shell/pty-daemon-protocol.js";
import { runtimeRequest } from "../src/shell/runtime/discovery.js";

describe("split runtime", () => {
  test.each([false, true])("host, agent, memory and retained view survive only-control termination (agent exits: %s)", async (exitDuringLoss) => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-split-runtime-")).then((value) => realpath(value));
    const paths = await createCraigState(root, []);
    const previousCache = process.env.CRAIG_RUNTIME_CACHE;
    process.env.CRAIG_RUNTIME_CACHE = path.join(root, "runtime-cache");
    let first: Awaited<ReturnType<typeof createDaemonPtyRuntime>> | undefined;
    let second: typeof first;
    let activity: PtyDaemonActivityClient | null = null;
    const activityStates: string[] = [];
    const activityClosed = vi.fn();
    const proof = { clientId: "fixture-view", proof: "fixture-view-proof" };
    const command = [process.execPath, "-e", `const rl=require('node:readline').createInterface({input:process.stdin}); const nonce=require('node:crypto').randomUUID(); let memory=''; const identity=()=>{const tty=require('node:fs').fstatSync(0);return {pid:process.pid,cwd:process.cwd(),nonce,ptyDevice:tty.dev,ptyInode:tty.ino}};console.log('IDENTITY '+JSON.stringify(identity())); rl.on('line',line=>{ if(line.startsWith('remember ')){memory=line.slice(9);console.log('remembered')}; if(line==='recall'){console.log('MEMORY '+memory+' '+nonce);console.log('CURRENT '+JSON.stringify(identity()))}; if(line==='finish-later'){console.log('finish-scheduled');setTimeout(()=>{for(let i=0;i<80;i++)console.log('retained-line-'+i);console.log('FINAL '+memory+' '+nonce);process.exit(0)},500)}; });`];
    const connect = () => createDaemonPtyRuntime({ paths, workspaceRoot: root, viewClient: proof, resolveSessionSpec: () => ({ cwd: root, command }) });
    const text = (client: NonNullable<typeof first>) => client.getViewState("fixture:agent").rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("\n");
    try {
      first = await connect();
      await first.ensureSession("fixture", "fixture:agent", { columns: 300, rows: 30 }); first.setViewedTab("fixture:agent");
      await vi.waitFor(() => expect(text(first!)).toMatch(/IDENTITY (\{[^\n]+\})/), { timeout: 5000 });
      const before = JSON.parse(text(first).match(/IDENTITY (\{[^\n]+\})/)![1]!);
      first.write("remember in-memory-state\r"); await vi.waitFor(() => expect(text(first!)).toContain("remembered"));
      const hostName = (await readdir(path.join(paths.runtimeDir, "hosts")))[0]!;
      const beforeHost = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", hostName));
      const beforeLease = JSON.parse(await readFile(path.join(paths.runtimeDir, "view-clients", `${proof.clientId}.json`), "utf8")).leases["fixture:agent"];
      expect(beforeLease.viewToken).toBeTruthy();
      if (exitDuringLoss) { first.write("finish-later\r"); await vi.waitFor(() => expect(text(first!)).toContain("finish-scheduled")); }
      activity = await tryConnectPtyDaemonActivity({ paths, onActivity: (snapshot) => activityStates.push(snapshot.sessionState), onDaemonClose: activityClosed });
      expect(activity).not.toBeNull();
      const oldControl = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json"));
      const hosts = await readFile(path.join(paths.runtimeDir, "control.json"), "utf8"); expect(hosts).toContain('"role":"control"');
      expect((await runtimeRequest(getPtyDaemonEndpoint(paths).socketPath, { type: "ping" })).protocolVersion).toBe(0);
      if (!oldControl || oldControl.pid === process.pid || !oldControl.endpoint.includes("control-")) throw new Error("Fixture control ownership not proven.");
      process.kill(oldControl.pid, "SIGKILL"); first.disposeAll(); first = undefined;
      await vi.waitFor(async () => expect((await daemonStatus(paths)).state).toBe("unavailable"));
      await vi.waitFor(() => expect(activityClosed).toHaveBeenCalled());
      expect(activityStates).not.toContain("failed");
      if (exitDuringLoss) await new Promise((resolve) => setTimeout(resolve, 700));
      else {
        await rm(path.join(paths.runtimeDir, "hosts", hostName));
        await expect(ensureRuntimeRunning(paths)).rejects.toThrow("Host discovery is missing");
        process.kill(before.pid, 0);
        await writePrivateRecord(path.join(paths.runtimeDir, "hosts", hostName), beforeHost);
        for (const route of await readdir(path.join(paths.runtimeDir, "sessions"))) await rm(path.join(paths.runtimeDir, "sessions", route));
      }
      await ensureRuntimeRunning(paths);
      second = await connect(); await second.ensureSession("fixture", "fixture:agent", { columns: 300, rows: 30 }); second.setViewedTab("fixture:agent");
      if (exitDuringLoss) {
        expect(second.getViewState("fixture:agent").status).toBe("exited");
        expect(text(second)).toContain(`FINAL in-memory-state ${before.nonce}`);
        second.scrollViewport(-10000); await vi.waitFor(() => expect(text(second!)).toContain("IDENTITY"));
        expect(JSON.parse(text(second).match(/IDENTITY (\{[^\n]+\})/)![1]!)).toEqual(before);
        second.scrollViewport(10000); await vi.waitFor(() => expect(text(second!)).toContain(`FINAL in-memory-state ${before.nonce}`));
      } else {
        second.write("recall\r"); await vi.waitFor(() => expect(text(second!)).toContain(`MEMORY in-memory-state ${before.nonce}`));
        process.kill(before.pid, 0);
        expect(JSON.parse(text(second).match(/CURRENT (\{[^\n]+\})/)![1]!)).toEqual(before);
        expect(JSON.parse(text(second).match(/IDENTITY (\{[^\n]+\})/)![1]!)).toEqual(before);
      }
      expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", hostName)))?.pid).toBe(beforeHost?.pid);
      expect(JSON.parse(await readFile(path.join(paths.runtimeDir, "view-clients", `${proof.clientId}.json`), "utf8")).leases["fixture:agent"]).toEqual(beforeLease);
      process.stdout.write(`split-continuity-evidence ${JSON.stringify({ oldControlPid: oldControl.pid, newControlPid: (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))?.pid, hostPid: beforeHost?.pid, agentPid: before.pid, cwd: before.cwd, nonce: before.nonce, ptyDevice: before.ptyDevice, ptyInode: before.ptyInode, viewId: beforeLease.viewId, agentExitedDuringControlLoss: exitDuringLoss, memoryOrFinalOutputRetained: true, scrollbackRetained: true })}\n`);
    } catch (error) {
      for (const role of ["guard", "host", "control"]) process.stdout.write(`${role}: ${await readFile(path.join(paths.runtimeDir, `${role}.log`), "utf8").catch(() => "missing")}\n`);
      throw error;
    } finally {
      first?.disposeAll(); second?.disposeAll(); activity?.close();
      try { await requestDaemonShutdown(paths); }
      catch (error) { process.stdout.write(`Fixture shutdown: ${String(error)}\n`); }
      finally {
        await stopFixtureRuntimes(paths, path.join(root, "runtime-cache"));
        if (previousCache === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previousCache; await rm(root, { recursive: true, force: true }); }
    }
  }, 45000);
  test("concurrent clients share one host, retain separate views, and repair only a failed guard", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-split-multi-")).then((value) => realpath(value));
    const paths = await createCraigState(root, []);
    const previousCache = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = path.join(root, "cache");
    const options = { paths, workspaceRoot: root, resolveSessionSpec: () => ({ cwd: root, command: [process.execPath, "-e", "let value='';require('node:readline').createInterface({input:process.stdin}).on('line',line=>{value=line;console.log('VALUE:'+value)});console.log('MULTI_READY')"] }) };
    let clients: Awaited<ReturnType<typeof createDaemonPtyRuntime>>[] = [];
    try {
      clients = await Promise.all([createDaemonPtyRuntime({ ...options, viewClient: { clientId: "client-a", proof: "a" } }), createDaemonPtyRuntime({ ...options, viewClient: { clientId: "client-b", proof: "b" } })]);
      const [first, second] = clients;
      await first!.ensureSession("fixture-a", "fixture-a:agent", { columns: 120, rows: 24 }); first!.setViewedTab("fixture-a:agent");
      await second!.ensureSession("fixture-b", "fixture-b:agent", { columns: 120, rows: 24 }); second!.setViewedTab("fixture-b:agent");
      first!.write("client-a-target\r"); second!.write("client-b-target\r");
      const text = (client: NonNullable<typeof first>, tabId: string) => client.getViewState(tabId).rows.flatMap((row) => row.segments.map((segment) => segment.text)).join("\n");
      await vi.waitFor(() => expect(text(first!, "fixture-a:agent")).toContain("VALUE:client-a-target"));
      await vi.waitFor(() => expect(text(second!, "fixture-b:agent")).toContain("VALUE:client-b-target"));
      expect(text(first!, "fixture-a:agent")).not.toContain("VALUE:client-b-target");
      const control = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!;
      const guard = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "guard.json")))!;
      const hostFiles = await readdir(path.join(paths.runtimeDir, "hosts")); expect(hostFiles).toHaveLength(1);
      const hostBefore = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", hostFiles[0]!));
      process.kill(guard.pid, "SIGKILL");
      await vi.waitFor(() => { try { process.kill(guard.pid, 0); throw new Error("Guard is still exiting"); } catch (error) { expect((error as { code?: string }).code).toBe("ESRCH"); } });
      await ensureRuntimeRunning(paths);
      expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))?.pid).toBe(control.pid);
      expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", hostFiles[0]!)))?.pid).toBe(hostBefore?.pid);
      expect((await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "guard.json")))?.pid).not.toBe(guard.pid);
      first!.write("after-guard-repair\r"); await vi.waitFor(() => expect(text(first!, "fixture-a:agent")).toContain("VALUE:after-guard-repair"));
      first!.disposeSession("fixture-a:agent");
      second!.write("second-still-live\r"); await vi.waitFor(() => expect(text(second!, "fixture-b:agent")).toContain("VALUE:second-still-live"));
    } finally {
      for (const client of clients) client.disposeAll();
      await requestDaemonShutdown(paths).catch(() => undefined);
      await stopFixtureRuntimes(paths, path.join(root, "cache"));
      if (previousCache === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previousCache;
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);

});
