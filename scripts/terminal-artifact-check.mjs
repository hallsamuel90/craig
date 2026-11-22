import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, open as openFile, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const text = (view) => view.rows.map((row) => row.segments.map((part) => part.text).join("")).join("\n");
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(checkReady, label, timeout = 15000) {
  const started = Date.now();
  do { const result = await checkReady(); if (result) return result; await delay(20); } while (Date.now() - started < timeout);
  throw new Error(`Timed out: ${label}`);
}

// Built-ins only: the binary thread can use exactly this driver against its
// executable without importing Craig source or the checkout's native addon.
export async function verifyTerminalArtifact({ executable, profile = "quick" }) {
  let target = resolve(executable);
  check(["quick", "soak"].includes(profile), "Profile must be quick or soak");
  const temporary = await mkdtemp(join(tmpdir(), "craig-artifact-check-"));
  const root = await realpath(temporary);
  const env = { ...process.env, CI: "1", TERM: "xterm-256color", SHELL: "/bin/sh" };
  for (const name of Object.keys(env)) if (name.startsWith("CRAIG_")) delete env[name];
  const guard = join(root, "offline.mjs");
  await writeFile(guard, "globalThis.fetch = async () => { throw new Error('Artifact-check fetch is disabled'); };\n");
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(guard).href}`.trim();
  const run = (file, args) => exec(file, args, { cwd: root, env, timeout: 15000, maxBuffer: 1024 * 1024 });
  let bootstrapAttempted = false;
  let bootstrappedPid;
  let relocated = false;
  let daemon;
  let rpc;
  let exited;
  let daemonExit;
  let diagnostics = "";
  let lastView = "";
  const cases = [];
  const latencies = [];
  try {
    // Move native artifacts away from the checkout/build tree so accidental
    // relative Wasm/native sidecars cannot make the verification pass.
    const handle = await openFile(target, "r");
    const magic = Buffer.alloc(4);
    try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
    if (["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic.toString("hex"))) {
      await mkdir(join(root, "artifact"));
      const copied = join(root, "artifact", "craig");
      await copyFile(target, copied);
      await chmod(copied, 0o755);
      target = copied;
      relocated = true;
    }
    await run("git", ["init", "-q"]);
    await run("git", ["config", "user.name", "Craig Artifact Check"]);
    await run("git", ["config", "user.email", "artifact@example.invalid"]);
    await mkdir(join(root, "empty-hooks"));
    await run("git", ["config", "core.hooksPath", join(root, "empty-hooks")]);
    await run("git", ["config", "commit.gpgsign", "false"]);
    await writeFile(join(root, "README.md"), "# Isolated terminal artifact fixture\n");
    await run("git", ["add", "README.md"]);
    await run("git", ["commit", "-qm", "fixture"]);
    await run(target, ["repo", "add", "."]);
    const peer = join(root, "peer.mjs");
    await writeFile(peer, await readFile(new URL("./fixtures/terminal-peer.mjs", import.meta.url)));
    const configure = (ghosttyTerminal) => writeFile(join(root, ".craig/config.json"), JSON.stringify({ previews: { ghosttyTerminal } }));
    await configure(false);
    daemon = spawn(target, ["__craig-daemon", root], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    exited = new Promise((resolveExit) => {
      daemon.once("error", (error) => { daemonExit = { error: error.message }; resolveExit(daemonExit); });
      daemon.once("exit", (code, signal) => { daemonExit = { code, signal }; resolveExit(daemonExit); });
    });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-8000); });
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const endpoint = join(tmpdir(), `craig-${hash}.sock`);
    rpc = await until(async () => {
      if (daemonExit) throw new Error(`Artifact daemon exited: ${JSON.stringify(daemonExit)}\n${diagnostics}`);
      return connectRpc(endpoint).catch(() => null);
    }, "daemon startup");
    const ping = await rpc.request({ type: "ping" });
    check(ping.ghosttyTerminal === true, "Artifact lacks the Ghostty preview; integrate the preview changes before running this gate");
    const view = async (tabId) => {
      const current = (await rpc.request({ type: "getViewState", tabId })).view;
      lastView = text(current).slice(-6000);
      return current;
    };
    const send = (command) => rpc.request({ type: "write", input: `${JSON.stringify(command)}\n` });
    const waitText = (tabId, marker) => until(async () => { const frame = await view(tabId); return text(frame).includes(marker) && frame; }, marker);
    const open = (tabId, size = { columns: 80, rows: 24 }) => rpc.request({ type: "ensureSession", taskId: "artifact_task", tabId, size, spec: { cwd: root, command: [process.execPath, peer] } });

    for (const backend of ["xterm", "ghostty"]) {
      const enabled = backend === "ghostty";
      await configure(enabled);
      const tabId = `artifact_task:${backend}`;
      await open(tabId);
      await waitText(tabId, "PEER_READY:");
      const expected = Buffer.from(enabled ? "\x1b[3;7R" : "\x1b[1;1R").toString("hex");
      // The stable xterm adapter's existing query scanner is chunk-based.
      // Native parser fragmentation is an additional Ghostty-only assertion.
      await send({ type: "query", fragmented: enabled });
      await waitText(tabId, `QUERY:${expected}`);
      await send({ type: "unicode", id: backend });
      await waitText(tabId, `${backend}:UNICODE_DONE`);
      check(text(await view(tabId)).includes("fragmented 界 e\u0301 👩‍💻 done"), `${backend}: fragmented Unicode was lost`);
      const paste = "\x1b[200~line 1\nline 2 界\x1b[201~";
      await send({ type: "capture", id: "paste", length: Buffer.byteLength(paste) });
      await waitText(tabId, "paste:READY");
      await rpc.request({ type: "write", input: paste });
      await waitText(tabId, `paste:CAPTURE:${Buffer.from(paste).toString("hex")}`);
      const arrow = enabled ? "\x1bOA" : "\x1b[A";
      await send({ type: "capture", id: "arrow", length: 3, modes: "\x1b[?1h" });
      await waitText(tabId, "arrow:READY");
      await rpc.request({ type: "writeKey", key: "UP" });
      await waitText(tabId, `arrow:CAPTURE:${Buffer.from(arrow).toString("hex")}`);

      const cycles = profile === "soak" ? 40 : 4;
      const completions = [];
      const caseLatencies = [];
      for (let cycle = 0; cycle < cycles; cycle++) {
        const id = `${backend}-${cycle}`;
        await send({ type: "burst", id, batches: profile === "soak" ? 256 : 128 });
        await waitText(tabId, `${id}:BEGIN`);
        await rpc.request({ type: "resize", size: { columns: cycle % 2 ? 100 : 80, rows: cycle % 2 ? 30 : 24 } });
        const burstStarted = performance.now();
        await send({ type: "go" });
        for (let sample = 0; sample < 4; sample++) {
          const started = performance.now();
          await rpc.request({ type: "ping" });
          const elapsed = performance.now() - started;
          latencies.push(elapsed);
          caseLatencies.push(elapsed);
        }
        const frame = await until(async () => {
          const current = await view(tabId);
          return text(current).includes(`${id}:BURST_DONE`) && current.rows.some((row) => row.segments.some((part) => part.href === "https://example.com/preview")) && current;
        }, `${id}:complete styled/link frame`);
        completions.push(performance.now() - burstStarted);
        check(frame.rows.length === (cycle % 2 ? 30 : 24), `${backend}: resize height was not applied`);
        check(frame.status === "running", `${backend}: session failed under output load`);
        check(frame.rows.some((row) => row.segments.some((part) => part.href === "https://example.com/preview")), `${backend}: hyperlink lost under load`);
        check(frame.rows.some((row) => row.segments.some((part) => part.text.includes("BURST_DONE") && part.style?.fg === "0dbc79")), `${backend}: styles lost under load`);
      }
      await send({ type: "identity", id: backend });
      const identity = text(await waitText(tabId, `${backend}:PID:`)).match(new RegExp(`${backend}:PID:(\\d+)`))?.[1];
      check(identity, `${backend}: missing child identity`);
      await configure(!enabled);
      rpc.close();
      rpc = await connectRpc(endpoint);
      await open(tabId);
      await send({ type: "identity", id: "reconnected" });
      await waitText(tabId, `reconnected:PID:${identity}`);
      await send({ type: "query", fragmented: enabled });
      await waitText(tabId, `QUERY:${expected}`);
      await rpc.request({ type: "disposeSession", tabId });
      check((await view(tabId)).status === "idle", `${backend}: disposed session remains live`);
      await until(() => {
        try { process.kill(Number(identity), 0); return false; }
        catch (error) { if (error.code === "ESRCH") return true; throw error; }
      }, `${backend}: child process exits on disposal`, 5000);
      const p95 = (samples) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
      cases.push({ backend, burstCycles: cycles, outputLines: cycles * (profile === "soak" ? 256 : 128) * 128,
        pingP95Ms: p95(caseLatencies), burstToStyledSnapshotP95Ms: p95(completions),
        checks: ["query owner", "UTF-8 fragments", "paste", "application cursor", "output flood", "resize", "styled/link rows", "toggle and reconnect preserve PID", "disposal kills child"] });
    }
    await rpc.request({ type: "shutdown" });
    await until(() => daemonExit, "daemon shutdown", 5000);
    check(daemonExit.code === 0, `Daemon shutdown failed: ${JSON.stringify(daemonExit)}`);
    rpc.close();
    // Exercise ordinary CLI self-bootstrap too. Direct __craig-daemon startup
    // alone would miss executable argv/entrypoint regressions in a binary.
    await configure(true);
    const bin = join(root, "bin");
    await mkdir(bin);
    const stub = join(bin, "codex");
    await writeFile(stub, `#!${process.execPath}\n${await readFile(peer, "utf8")}`);
    await chmod(stub, 0o755);
    env.PATH = `${bin}:${env.PATH ?? ""}`;
    const repos = JSON.parse((await run(target, ["--json", "repo", "list"])).stdout);
    const repoId = repos.data?.repos?.[0]?.id;
    check(typeof repoId === "string", "Missing isolated repository ID");
    bootstrapAttempted = true;
    const created = JSON.parse((await run(target, ["--json", "task", "new", "--repo", repoId, "--runner", "codex", "Artifact bootstrap check"])).stdout).data;
    check(typeof created?.agentTabId === "string", "Task creation did not return its agent tab");
    bootstrappedPid = Number(await readFile(join(root, ".craig/runtime/pty-daemon.pid"), "utf8"));
    check(Number.isInteger(bootstrappedPid) && bootstrappedPid > 0, "Missing self-bootstrapped daemon PID");
    rpc = await until(() => connectRpc(endpoint).catch(() => null), "CLI self-bootstrapped daemon");
    await rpc.request({ type: "ensureSession", taskId: created.taskId, tabId: created.agentTabId, size: { columns: 160, rows: 24 }, spec: { cwd: created.worktreePath, command: [] } });
    await waitText(created.agentTabId, "PEER_READY:");
    await send({ type: "identity", id: "bootstrap" });
    const bootFrame = text(await waitText(created.agentTabId, "bootstrap:CWD_HASH:"));
    check(bootFrame.includes(`bootstrap:CWD_HASH:${createHash("sha256").update(await realpath(created.worktreePath)).digest("hex")}`), "Self-bootstrapped agent started outside its task worktree");
    const agentPid = Number(bootFrame.match(/bootstrap:PID:(\d+)/)?.[1]);
    check(Number.isInteger(agentPid) && agentPid > 0, "Missing bootstrapped agent PID");
    await send({ type: "query", fragmented: true });
    await waitText(created.agentTabId, `QUERY:${Buffer.from("\x1b[3;7R").toString("hex")}`);
    await rpc.request({ type: "shutdown" });
    await until(() => !isAlive(bootstrappedPid), "self-bootstrapped daemon shutdown", 5000);
    await until(() => !isAlive(agentPid), "self-bootstrapped agent cleanup", 5000);
    const sorted = [...latencies].sort((a, b) => a - b);
    return { artifact: basename(target), profile, platform: `${process.platform}-${process.arch}`, driverNode: process.version, relocated, cliSelfBootstrap: true, cases,
      daemonPingMs: { p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: Math.max(...latencies) },
      isolation: "fresh unrelated workspace; fetch preload for Node-compatible targets; use an external network sandbox for native binary offline proof" };
  } catch (error) {
    throw new Error(`${error.message}\nLast rendered view:\n${lastView}\nArtifact daemon diagnostics:\n${diagnostics}`, { cause: error });
  } finally {
    if (rpc && (!daemonExit || bootstrapAttempted)) await rpc.request({ type: "shutdown" }).catch(() => undefined);
    rpc?.close();
    if (daemon && !daemonExit) {
      await Promise.race([exited, delay(3000)]);
      if (!daemonExit) { daemon.kill("SIGKILL"); await exited; }
    }
    if (bootstrapAttempted) {
      // Also cover a failed task-new command which started a daemon before
      // returning an error. Only this isolated workspace's PID is considered.
      const pid = bootstrappedPid ?? Number(await readFile(join(root, ".craig/runtime/pty-daemon.pid"), "utf8").catch(() => ""));
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        process.kill(pid, "SIGTERM");
        await until(() => !isAlive(pid), "failed bootstrap cleanup", 5000).catch(() => { if (isAlive(pid)) process.kill(pid, "SIGKILL"); });
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function connectRpc(endpoint) {
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection(endpoint);
    const pending = new Map();
    let id = 0;
    let buffer = "";
    let closed = false;
    const rejectAll = (error) => { for (const work of pending.values()) { clearTimeout(work.timer); work.reject(error); } pending.clear(); };
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Daemon connection timed out")); }, 1000);
    socket.setEncoding("utf8");
    socket.on("error", (error) => { clearTimeout(timer); reject(error); rejectAll(error); });
    socket.on("close", () => { closed = true; clearTimeout(timer); rejectAll(new Error("Daemon connection closed")); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const work = pending.get(message.id);
        if (!work) continue;
        clearTimeout(work.timer); pending.delete(message.id);
        if (message.ok) work.resolve(message);
        else work.reject(new Error(message.error));
      }
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolveConnection({
        request(body) {
          if (closed) return Promise.reject(new Error("Daemon connection is closed"));
          return new Promise((resolveReply, rejectReply) => {
            const requestId = ++id;
            const timeout = setTimeout(() => { pending.delete(requestId); rejectReply(new Error(`Daemon ${body.type} timed out`)); }, 10000);
            pending.set(requestId, { resolve: resolveReply, reject: rejectReply, timer: timeout });
            socket.write(`${JSON.stringify({ ...body, id: requestId })}\n`);
          });
        },
        close() { closed = true; socket.destroy(); },
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const executable = args[args.indexOf("--executable") + 1];
  if (!args.includes("--executable") || !executable) throw new Error("Usage: node scripts/terminal-artifact-check.mjs --executable /absolute/craig [--profile quick|soak] [--report report.json]");
  const profile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : "quick";
  const report = await verifyTerminalArtifact({ executable, profile });
  if (args.includes("--report")) {
    const file = resolve(args[args.indexOf("--report") + 1]);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
