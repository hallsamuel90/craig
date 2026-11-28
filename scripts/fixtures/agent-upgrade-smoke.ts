/** Opt-in, operator-driven supported-agent smoke. Never part of pnpm test. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPackagedUpgradeFixtures } from "../../tests/runtime-packages.js";
import { createCraigState, createGitRepo, writeTaskRecord } from "../../tests/test-helpers.js";
import { stopFixtureRuntimes } from "../../tests/runtime-fixtures.js";
import { createDaemonPtyRuntime } from "../../src/ui/pty/daemon.js";
import { ensureTaskCapabilities } from "../../src/domain/orchestration/index.js";
import { daemonStatus } from "../../src/shell/runtime/discovery.js";
import { readPrivateRecord, type RuntimeRecord } from "../../src/shell/runtime/records.js";
import { RuntimeTransport } from "../../src/shell/runtime/wire.js";
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "craig-real-agent-upgrade-")).then((value) => realpath(value));
const cache = path.join(root, "cache"); process.env.CRAIG_RUNTIME_CACHE = cache;
const paths = await createCraigState(root, ["task_manual"]);
try {
await createGitRepo(root);
await writeFile(path.join(root, "README.md"), "Isolated supported-agent continuity fixture.\n");
await execute("git", ["add", "README.md"], { cwd: root }); await execute("git", ["commit", "-m", "fixture"], { cwd: root });
const task = await writeTaskRecord(root, { id: "task_manual", status: "running", worktreePath: root, repoRoot: root });
const capability = await ensureTaskCapabilities(paths, task);
const runner = (await execute("which", ["codex"])).stdout.trim();
const version = (await execute(runner, ["--version"])).stdout.trim();
const packages = await buildPackagedUpgradeFixtures(path.join(root, "packages"));
const env = { ...process.env, CRAIG_RUNTIME_CACHE: cache, CRAIG_WORKSPACE_ROOT: root };
await execute(process.execPath, [packages.a.binary, "__craig-runtime-bootstrap", root], { cwd: root, env });
const nonce = randomUUID();
const client = await createDaemonPtyRuntime({ paths, workspaceRoot: root, viewClient: { clientId: "manual-codex", proof: randomUUID() }, resolveSessionSpec: () => ({ cwd: root,
  command: [runner, "--no-daemon", "--no-alt-screen", "--sandbox", "read-only", "--ask-for-approval", "never", `This is an isolated runtime continuity smoke test. Do not use tools, modify files, or launch agents. Remember conversation nonce ${nonce}. Reply exactly FIRST_OK without repeating the nonce.`], env: capability }) });
const tab = task.ptyTabs[0]!.id;
let done = false; let lastCommand = "";
let before: Awaited<ReturnType<typeof processFacts>> | undefined;
let after: typeof before;
let updateWhileWorking = false;
let updated = false;
const screen = () => client.getViewState(tab).rows.map((row) => row.segments.map((part) => part.text).join("")).join("\n");
async function processFacts() {
  const runtime = (await daemonStatus(paths)).runtime!;
  const hosts = runtime.hosts!;
  const files = await import("node:fs/promises").then((fs) => fs.readdir(path.join(paths.runtimeDir, "hosts")));
  const sessions: Array<{ pid: number; hostId: string }> = [];
  for (const file of files) {
    const host = (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", file)))!;
    if (host.retired) continue;
    const transport = await RuntimeTransport.connect(host.endpoint);
    try {
      const response = await transport.request({ type: "hello", credential: host.credential, instanceId: host.instanceId, workspaceId: host.workspaceId });
      sessions.push(...(response.sessions as Array<{ pid: number }>).map((session) => ({ ...session, hostId: host.instanceId })));
    } finally { transport.close(); }
  }
  const pid = sessions[0]!.pid;
  const all = (await execute("ps", ["-axo", "pid=,ppid=,lstart=,command="])).stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), start: match[3]!, command: match[4]! }] : [];
  });
  const tree = all.filter((entry) => entry.pid === pid);
  for (let index = 0; index < tree.length; index++) for (const entry of all.filter((entry) => entry.parent === tree[index]!.pid)) if (!tree.some((known) => known.pid === entry.pid)) tree.push(entry);
  const processes = await Promise.all(tree.map(async (entry) => ({ pid: entry.pid, parent: entry.parent, start: entry.start, executable: entry.command.split(" ")[0], cwd: (await execute("lsof", ["-a", "-p", String(entry.pid), "-d", "cwd", "-Fn"])).stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1), tty: (await execute("lsof", ["-a", "-p", String(entry.pid), "-d", "0", "-FDin"])).stdout.split("\n").filter((line) => /^[Din]/.test(line)) })));
  return { craigVersion: runtime.craigVersion, buildId: runtime.buildId, wrapperPid: pid, hosts, processes, control: (await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json")))!.pid };
}
await client.ensureSession(task.id, tab, { columns: 180, rows: 50 }); client.setViewedTab(tab);
process.stdout.write(JSON.stringify({ root, version, nonce, commands: path.join(root, "operator-command.json"), screen: path.join(root, "screen.txt") }) + "\n");
try {
  while (!done) {
    await writeFile(path.join(root, "screen.txt"), screen(), { mode: 0o600 });
    const command = await readFile(path.join(root, "operator-command.json"), "utf8").then((value) => JSON.parse(value) as { id: string; action: string; text?: string }).catch(() => null);
    if (command && command.id !== lastCommand) {
      lastCommand = command.id;
      if (command.action === "input") client.write(command.text ?? "");
      else if (command.action === "key") client.writeKey(command.text ?? "ENTER");
      else if (command.action === "update") {
        updateWhileWorking = /esc to interrupt|Working|Thinking/i.test(screen());
        before = await processFacts();
        await rm(packages.a.installation, { recursive: true });
        await execute(process.execPath, [packages.b.binary, "__craig-runtime-bootstrap", root], { cwd: root, env });
        after = await processFacts(); updated = true;
        await writeFile(path.join(root, "process-evidence.json"), JSON.stringify({ version, nonce, updateWhileWorking, before, after }, null, 2), { mode: 0o600 });
        process.stdout.write("UPDATE_FINISHED\n");
      } else if (command.action === "finish") {
        if (!updated || !updateWhileWorking || !before || !after || before.control === after.control || JSON.stringify(before.processes) !== JSON.stringify(after.processes) || before.wrapperPid !== after.wrapperPid || !new RegExp(`^\\s*• RECOVERED ${nonce}\\s*$`, "m").test(screen())) throw new Error("Required supported-agent continuity evidence is incomplete.");
        const evidence = { version, packageVersions: [packages.a.version, packages.b.version], nonce, updateWhileWorking, before, after, originalInstallationRemoved: true, supportedAgentRecalledNonce: true };
        await writeFile(path.join(root, "verified-evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
        process.stdout.write(`SUPPORTED_AGENT_VERIFIED ${JSON.stringify(evidence)}\n`); done = true;
      } else if (command.action === "abort") throw new Error("Operator aborted smoke; evidence remains unverified.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  await client.disposeSessionConfirmed(tab).catch(() => undefined); client.disposeAll();
  await stopFixtureRuntimes(paths, cache);
  // Keep only private evidence and terminal snapshots for the operator to review.
  await rm(path.join(root, "packages"), { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
}

} catch (error) {
  await stopFixtureRuntimes(paths, cache);
  throw error;
}
