import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { createCraigState } from "./test-helpers.js";
import { stopFixtureRuntimes } from "./runtime-fixtures.js";
import { materializeRuntimeDependencies, pinRuntimeArtifact } from "../src/shell/runtime/artifacts.js";
import { collectRuntimeArtifacts, releaseRuntimeArtifactReservation } from "../src/shell/runtime/artifact-retention.js";
import { ensureRuntimeRunning } from "../src/shell/runtime/start.js";
import { launchRuntimeRole, awaitRuntimeRole } from "../src/shell/runtime/bootstrap.js";
import { newRuntimeRecord, readPrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { RuntimeTransport } from "../src/shell/runtime/wire.js";
const execute = promisify(execFile);

test("shared cache retains guards, live hosts, rollback and preparation pins across workspaces, and removes only proven unused managed artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "craig-cache-retention-")).then((value) => realpath(value));
  const cache = path.join(root, "cache"); const previous = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = cache;
  const roots = [path.join(root, "workspace-a"), path.join(root, "workspace-b")];
  const paths = await Promise.all(roots.map(async (workspace) => { await mkdir(workspace); return createCraigState(workspace, []); }));
  try {
    await ensureRuntimeRunning(paths[0]!); await ensureRuntimeRunning(paths[1]!);
    const guard = (await readPrivateRecord<RuntimeRecord>(path.join(paths[0]!.runtimeDir, "guard.json")))!;
    expect((await collectRuntimeArtifacts(paths[1]!)).retained).toContain(path.basename(guard.artifact));
    const installation = path.join(root, "unused-installation"); await mkdir(installation);
    await execute(process.execPath, [path.resolve("scripts/build-npm.mjs")]);
    await cp(path.resolve("packages/cli/dist/cli.js"), path.join(installation, "cli.js"));
    await writeFile(path.join(installation, "package.json"), '{"type":"module"}');
    await materializeRuntimeDependencies(path.resolve("package.json"), installation);
    const bundle = path.join(installation, "cli.js"); await writeFile(bundle, (await readFile(bundle, "utf8")) + "\n// Additional GC fixture artifact.\n");
    const extra = await pinRuntimeArtifact(paths[0]!, bundle);
    expect((await collectRuntimeArtifacts(paths[1]!)).retained).toContain(path.basename(extra)); // Live preparation pin.
    const record = await newRuntimeRecord(paths[0]!, "host", extra);
    const file = path.join(paths[0]!.runtimeDir, "hosts", `${record.instanceId}.json`);
    // Either side may win the cache lock: before launch the preparation pin
    // retains it; after launch the published role record retains it.
    const [child, collection] = await Promise.all([launchRuntimeRole(paths[0]!, record, file), collectRuntimeArtifacts(paths[1]!)]);
    expect(collection.removed).not.toContain(path.basename(extra));
    const ready = await awaitRuntimeRole(file, child);
    expect((await collectRuntimeArtifacts(paths[1]!)).retained).toContain(path.basename(extra));
    const transport = await RuntimeTransport.connect(ready.endpoint);
    try {
      const auth = { credential: ready.credential, workspaceId: ready.workspaceId, instanceId: ready.instanceId, controllerId: "cache-fixture" };
      await transport.request({ type: "registerController", ...auth, controllerPid: process.pid });
      await transport.request({ type: "releaseHold", ...auth, holdId: "recovery:cache-fixture" });
      await transport.request({ type: "shutdownIfUnused", ...auth });
    } finally { transport.close(); }
    await vi.waitFor(() => expect(child.exitCode).not.toBeNull(), { timeout: 5000 });
    expect((await readPrivateRecord<RuntimeRecord>(file))?.retired).toBe(true);
    expect((await collectRuntimeArtifacts(paths[1]!)).removed).toContain(path.basename(extra));
    expect((await collectRuntimeArtifacts(paths[1]!)).retained).toContain(path.basename(guard.artifact));
    // Entries without a managed-publication ledger may predate this RFC.
    const legacyUnknown = await pinRuntimeArtifact(paths[0]!, bundle);
    await releaseRuntimeArtifactReservation(paths[0]!, legacyUnknown);
    await rm(path.join(cache, "managed", `${path.basename(legacyUnknown)}.json`));
    expect((await collectRuntimeArtifacts(paths[1]!)).retained).toContain(path.basename(legacyUnknown));
    // Unknown workspace state is retained even after the preparation pin ends.
    await writeFile(bundle, (await readFile(bundle, "utf8")) + "\n// Unknown workspace GC fixture.\n");
    const unknownRoot = path.join(root, "unknown-workspace"); await mkdir(unknownRoot);
    const unknownPaths = await createCraigState(unknownRoot, []);
    const unknown = await pinRuntimeArtifact(unknownPaths, bundle); await releaseRuntimeArtifactReservation(unknownPaths, unknown);
    await rm(unknownRoot, { recursive: true });
    expect((await collectRuntimeArtifacts(paths[1]!)).retained).toContain(path.basename(unknown));
  } finally {
    for (const workspace of paths) await stopFixtureRuntimes(workspace, cache);
    if (previous === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
