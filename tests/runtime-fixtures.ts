import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../src/state/craig-paths.js";
import { readPrivateRecord, type RuntimeRecord } from "../src/shell/runtime/records.js";
import { getPtyDaemonEndpoint } from "../src/shell/pty-daemon-protocol.js";
const execute = promisify(execFile);

/** Never signal by a cached PID alone, even in a disposable test workspace. */
export async function stopFixtureRuntimes(paths: CraigPaths, artifactRoot: string): Promise<void> {
  if (!paths.workspaceRoot.includes("craig-") || paths.workspaceRoot === process.cwd()) throw new Error("Not a disposable runtime fixture.");
  const files = [path.join(paths.runtimeDir, "control.json"), path.join(paths.runtimeDir, "guard.json"), ...(await readdir(path.join(paths.runtimeDir, "hosts")).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => path.join(paths.runtimeDir, "hosts", name))];
  const records = (await Promise.all(files.map((file) => readPrivateRecord<RuntimeRecord>(file)))).filter((record): record is RuntimeRecord => record !== null);
  const command = async (pid: number) => execute("ps", ["-p", String(pid), "-o", "command="]).then((result) => result.stdout.trim()).catch(() => "");
  for (const record of records) {
    if (record.pid <= 1 || record.pid === process.pid || !record.artifact.startsWith(`${artifactRoot}/`)) throw new Error("Fixture process ownership is ambiguous; preserving it.");
    const before = await command(record.pid);
    if (!before) continue;
    const state = await execute("ps", ["-p", String(record.pid), "-o", "stat="]).then((result) => result.stdout.trim()).catch(() => "");
    if (!state || state.startsWith("Z")) continue; // Exited children awaiting OS reaping are not live owners.
    if (!before.includes(record.artifact) || !before.includes("__craig-runtime-role") || !before.includes(paths.workspaceRoot)) throw new Error(`Fixture ${record.role} PID ${record.pid} identity changed (${state}); refusing to signal it.`);
    try { process.kill(record.pid, "SIGTERM"); } catch { /* Already exited. */ }
    const deadline = Date.now() + 3000;
    while (await command(record.pid)) {
      const state = await execute("ps", ["-p", String(record.pid), "-o", "stat="]).then((result) => result.stdout.trim()).catch(() => "");
      if (!state || state.startsWith("Z")) break;
      if (Date.now() >= deadline) {
        const current = await command(record.pid);
        if (current && current !== before) throw new Error("Fixture PID was reused; preserving the new owner.");
        if (current) try { process.kill(record.pid, "SIGKILL"); } catch { /* Already exited. */ }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const record of records) {
    if (record.role === "guard") continue;
    const directory = path.dirname(record.endpoint);
    if (path.basename(directory).startsWith("craig-runtime-") && (await lstat(directory).catch(() => null))?.uid === process.getuid?.()) await rm(directory, { recursive: true, force: true });
  }
  const legacy = getPtyDaemonEndpoint(paths).socketPath;
  if ((await lstat(legacy).catch(() => null))?.uid === process.getuid?.()) await rm(legacy, { force: true });
}
