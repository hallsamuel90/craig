import { stopFixtureRuntimes } from "./runtime-fixtures.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, expect, vi } from "vitest";
import { materializeRuntimeDependencies, verifyRuntimeArtifact } from "../src/shell/runtime/artifacts.js";
import { createCraigState } from "./test-helpers.js";
import { createDaemonPtyRuntime, requestDaemonShutdown } from "../src/ui/pty/daemon.js";
import { readPrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
const execute = promisify(execFile);

test("a pinned runtime retains its complete dependency closure after the original packaged installation is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "craig-packaged-host-")).then((value) => realpath(value));
  const paths = await createCraigState(root, []);
  const installation = path.join(root, "installation-a"); const cache = path.join(root, "cache");
  const artifactBundle = path.resolve("packages/cli/dist/cli.js");
  await execute(process.execPath, [path.resolve("scripts/build-npm.mjs")]);
  await mkdir(installation);
  await cp(artifactBundle, path.join(installation, "cli.js"));
  await cp(path.resolve("packages/cli/package.json"), path.join(installation, "package.json"));
  await materializeRuntimeDependencies(artifactBundle, installation);
  const env = { ...process.env, CRAIG_RUNTIME_CACHE: cache, CRAIG_WORKSPACE_ROOT: root };
  let first: Awaited<ReturnType<typeof createDaemonPtyRuntime>> | undefined;
  let second: typeof first;
  const viewClient = { clientId: "packaged-view", proof: "packaged-proof" };
  const command = [process.execPath, "-e", `let memory='';const nonce=require('node:crypto').randomUUID(); console.log('IDENTITY '+JSON.stringify({pid:process.pid,cwd:process.cwd(),nonce}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{ if(line.startsWith('remember ')){memory=line.slice(9);console.log('remembered')};if(line==='recall')console.log('MEMORY '+memory+' '+nonce) });`];
  const connect = () => createDaemonPtyRuntime({ paths, workspaceRoot: root, viewClient, resolveSessionSpec: () => ({ cwd: root, command }) });
  const text = (client: NonNullable<typeof first>) => client.getViewState("fixture:agent").rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("\n");
  try {
    await execute(process.execPath, [path.join(installation, "cli.js"), "__craig-runtime-bootstrap", root], { cwd: root, env });
    const control = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json"));
    expect(control?.artifact.startsWith(cache)).toBe(true);
    const manifest = await verifyRuntimeArtifact(control!.artifact);
    expect(Object.keys(manifest.files)).toContain("node_modules/node-pty/build/Release/pty.node");
    expect(Object.keys(manifest.files).some((name) => name.startsWith("node_modules/terminal-kit/"))).toBe(true);
    first = await connect(); await first.ensureSession("fixture", "fixture:agent", { columns: 300, rows: 30 }); first.setViewedTab("fixture:agent");
    await vi.waitFor(() => expect(text(first!)).toMatch(/IDENTITY (\{[^\n]+\})/));
    const identity = JSON.parse(text(first).match(/IDENTITY (\{[^\n]+\})/)![1]!);
    first.write("remember source-installation-is-gone\r"); await vi.waitFor(() => expect(text(first!)).toContain("remembered"));
    await rm(installation, { recursive: true });
    await verifyRuntimeArtifact(control!.artifact);
    first.disposeAll(); first = undefined;
    second = await connect(); await second.ensureSession("fixture", "fixture:agent", { columns: 300, rows: 30 }); second.setViewedTab("fixture:agent");
    second.write("recall\r"); await vi.waitFor(() => expect(text(second!)).toContain(`MEMORY source-installation-is-gone ${identity.nonce}`));
    process.kill(identity.pid, 0);
    // A fresh session exercises native node-pty helper paths after removal.
    const helper = await createDaemonPtyRuntime({ paths, workspaceRoot: root, resolveSessionSpec: () => ({ cwd: root, command: [process.execPath, "-e", "console.log('POST_REMOVAL_SPAWN'); setInterval(()=>{},1000)"] }) });
    try { await helper.ensureSession("fixture-2", "fixture-2:agent", { columns: 120, rows: 24 }); helper.setViewedTab("fixture-2:agent"); await vi.waitFor(() => expect(helper.getViewState("fixture-2:agent").rows.flatMap((row) => row.segments.map((part) => part.text)).join("")).toContain("POST_REMOVAL_SPAWN")); }
    finally { helper.disposeAll(); }
  } finally {
    first?.disposeAll(); second?.disposeAll();
    try { await requestDaemonShutdown(paths); }
    catch { /* The fixture owns the records below, including any startup failure. */ }
    await stopFixtureRuntimes(paths, cache);
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
