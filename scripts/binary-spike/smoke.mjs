// Test the relocated executable with no working node/npm/bun commands on PATH.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(path.join(tmpdir(), "craig-binary-smoke-")));
const project = path.join(root, "project");
const home = path.join(root, "home");
const bin = path.join(root, "bin");
const binary = path.join(root, "craig");
const version = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../packages/cli/package.json"), "utf8")).version;
await Promise.all([mkdir(project), mkdir(home), mkdir(bin)]);
const candidate = process.argv[2] ?? path.resolve(import.meta.dirname, "../../.craig/binary-spike/craig");
console.log(`Testing ${candidate}`);
await copyFile(path.resolve(candidate), binary);
await chmod(binary, 0o755);
const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/sh", TERM: "xterm-256color", CI: "" };
for (const key of ["CRAIG_AGENT_CAPABILITY", "CRAIG_AGENT_TAB_ID", "CRAIG_TASK_ID", "CRAIG_WORKSPACE_ROOT", "NODE_PATH", "NODE_OPTIONS"]) delete env[key];
for (const name of ["node", "npm", "bun"]) {
  const file = path.join(bin, name);
  await writeFile(file, `#!/bin/sh\necho unexpected-${name} >> '${root}/runtime-used'\nexit 99\n`);
  await chmod(file, 0o755);
}
const stub = path.join(bin, "codex");
await writeFile(stub, `#!/bin/sh
task_dir=$(basename "$PWD")
echo "$PWD" > "$HOME/agent-$task_dir.cwd"
echo "binary_agent_cwd:$PWD"
echo "binary_agent_ready"
while IFS= read -r line; do
  case "$line" in
    probe*) echo "binary_input_ok:$line"; echo "binary_size:$(stty size)" ;;
  esac
done
`);
await chmod(stub, 0o755);
const command = (file, args, cwd = project) => exec(file, args, { cwd, env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
const cli = (args) => command(binary, args);
const json = async (args) => {
  const result = JSON.parse((await cli(["--json", ...args])).stdout);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let output = "";
async function waitFor(marker) {
  const deadline = Date.now() + 15000;
  while (!output.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`Missing ${marker}:\n${stripVTControlCharacters(output).slice(-12000)}`);
    await delay(25);
  }
}
async function openShell(state) {
  await writeFile(path.join(project, ".craig/runtime/ui-state.json"), JSON.stringify({
    version: 1, inputMode: "control", focusedRegion: "center", activeTab: "agent",
    selectedActionId: "commit", selectedWorkspaceId: null, updatedAt: new Date().toISOString(), ...state,
  }));
  output = "";
  child = spawn(binary, [], { cwd: project, env, cols: 120, rows: 36 });
  child.onData((data) => { output = (output + data).slice(-250000); });
  await waitFor("> Start");
  assert.ok(output.includes(`v${version}`));
  child.write("\r");
}
async function closeShell() {
  if (!child) return;
  const exited = new Promise((resolve) => child.onExit(resolve));
  child.kill();
  await Promise.race([exited, delay(2000)]);
  child = undefined;
}
async function shutdown() {
  await cli(["__craig-daemon-shutdown", project]);
  const pid = path.join(project, ".craig/runtime/pty-daemon.pid");
  const deadline = Date.now() + 5000;
  while (true) {
    try { await readFile(pid); } catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (Date.now() > deadline) throw new Error("Daemon did not shut down");
    await delay(50);
  }
}
try {
  for (const result of await Promise.all([cli(["--help"]), cli(["--help"]), cli(["--help"])])) {
    assert.match(result.stdout, /Craig commands/);
  }
  await command("/usr/bin/git", ["init", "-b", "main"]);
  await command("/usr/bin/git", ["config", "user.email", "binary@example.invalid"]);
  await command("/usr/bin/git", ["config", "user.name", "Binary Smoke"]);
  await writeFile(path.join(project, "README.md"), "# Binary smoke\n");
  await command("/usr/bin/git", ["add", "README.md"]);
  await command("/usr/bin/git", ["commit", "-m", "fixture"]);
  await json(["repo", "add", "."]);
  await writeFile(path.join(project, ".craig/config.json"), JSON.stringify({
    runners: { codex: { path: stub } }, checks: { commands: ["printf binary_check_ok"] },
  }));
  const repos = await json(["repo", "list"]);
  const repoId = repos.repos[0].id;
  const created = await json(["task", "new", "--repo", repoId, "Binary smoke"]);
  const taskId = created.taskId;
  const tasks = await json(["task", "list"]);
  assert.equal(tasks.tasks.length, 1);
  const state = { selectedRepoId: repoId, selectedTaskId: taskId, selectedPtyTabId: `${taskId}:agent` };
  await mkdir(path.join(project, ".craig/runtime"), { recursive: true });
  await openShell(state);
  await waitFor("+ new tab");
  child.write("\r");
  await waitFor("binary_agent_ready");
  assert.equal((await readFile(path.join(home, `agent-${taskId}.cwd`), "utf8")).trim(), tasks.tasks[0].worktreePath);
  child.write("probe-before-resize\r");
  await waitFor("binary_input_ok:probe-before-resize");
  await waitFor("binary_size:");
  const beforeSize = output.match(/binary_size:\s*(\d+)\s+(\d+)/);
  assert.ok(beforeSize);
  child.resize(132, 42);
  await delay(300);
  output = "";
  child.write("probe-one\r");
  await waitFor("binary_input_ok:probe-one");
  await waitFor("binary_size:");
  const afterSize = output.match(/binary_size:\s*(\d+)\s+(\d+)/);
  assert.ok(afterSize);
  assert.ok(Number(afterSize[1]) > Number(beforeSize[1]));
  assert.ok(Number(afterSize[2]) > Number(beforeSize[2]));
  console.log("PASS relocated TUI, daemon self-spawn, agent cwd, input and resize");
  await closeShell();
  await openShell(state);
  await waitFor("+ new tab");
  child.write("\r");
  output = "";
  child.write("probe-reattach\r");
  await waitFor("binary_input_ok:probe-reattach");
  console.log("PASS daemon survives detach and reattach");
  await closeShell();
  await shutdown();
  // With the daemon gone, opening the same task must bootstrap a new daemon.
  await openShell(state);
  await waitFor("+ new tab");
  child.write("\r");
  await waitFor("binary_agent_ready");
  console.log("PASS daemon recovery after shutdown");
  await closeShell();
  await shutdown();
  await openShell({ selectedRepoId: repoId, selectedTaskId: null, selectedPtyTabId: null });
  await waitFor("+ New Task");
  child.write("n");
  await waitFor("NEW TASK");
  output = "";
  child.write("Binary TUI create\r");
  await waitFor("binary_agent_ready");
  const after = await json(["task", "list"]);
  assert.equal(after.tasks.length, 2);
  const newTask = after.tasks.find((task) => task.id !== taskId);
  assert.ok(newTask);
  assert.equal((await readFile(path.join(home, `agent-${newTask.id}.cwd`), "utf8")).trim(), newTask.worktreePath);
  console.log("PASS TUI create goes directly into new agent worktree");
  await closeShell();
  await writeFile(path.join(tasks.tasks[0].worktreePath, "README.md"), "# Binary change\n");
  const diff = await json(["task", "diff", taskId]);
  assert.match(JSON.stringify(diff), /Binary change/);
  const check = await json(["task", "check", taskId]);
  assert.equal(check.status, "passed");
  await shutdown();
  // Exercise gh integration without accessing or mutating a real repository.
  await command("/usr/bin/git", ["remote", "add", "origin", "https://github.com/binary-spike/fixture.git"]);
  const pr = {
    number: 42, url: "https://github.com/binary-spike/fixture/pull/42",
    baseRefName: "main", headRefName: tasks.tasks[0].branch, state: "OPEN", isDraft: false,
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "Binary smoke PR",
    statusCheckRollup: [{ __typename: "CheckRun", name: "build", conclusion: "SUCCESS", status: "COMPLETED" }],
  };
  await writeFile(path.join(home, "pr.json"), JSON.stringify(pr));
  const gh = path.join(bin, "gh");
  await writeFile(gh, '#!/bin/sh\ncase "$1 $2" in\n  "auth status") exit 0 ;;\n  "pr view") cat "$HOME/pr.json" ;;\n  *) echo "Unexpected gh call: $*" >&2; exit 98 ;;\nesac\n');
  await chmod(gh, 0o755);
  const discovered = await json(["task", "pr", "discover", taskId]);
  assert.match(JSON.stringify(discovered), /fixture\/pull\/42/);
  await json(["task", "pr", "refresh", taskId]);
  await json(["task", "pr", "show", taskId]);
  console.log("PASS PR discovery/refresh/show with a shell gh fixture");
  await assert.rejects(readFile(path.join(root, "runtime-used")), { code: "ENOENT" });
  console.log("PASS diff/check; no external Node, npm, or Bun used");
} catch (error) {
  const records = (await readdir(home)).filter((name) => name.startsWith("agent-") && name.endsWith(".cwd"));
  console.error("Agent cwd records before cleanup:", await Promise.all(records.map(async (name) => ({
    name, cwd: (await readFile(path.join(home, name), "utf8")).trim(),
  }))));
  throw error;
} finally {
  await closeShell();
  await shutdown().catch((error) => { console.error(error); process.exitCode = 1; });
  await rm(root, { recursive: true, force: true });
}
