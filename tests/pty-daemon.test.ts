import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test, vi } from "vitest";

import { createDaemonPtyRuntime, requestDaemonShutdown, servePtyDaemon } from "../src/ui/pty/daemon.js";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { ensureCraigState } from "../src/domain/workspace/workspaces/ensure.js";

const DAEMON_TEST_TIMEOUT_MS = 15000;

describe("PTY daemon", () => {
  test("reconnect returns an existing live tab session without spawning again", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const fakePty = createFakePty();
    const spawn = vi.fn(() => fakePty);
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const first = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await first.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
      fakePty.emitData("still-live\r\n");
      await vi.waitFor(() => expect(first.getViewState("task_1:terminal").rows[0]?.segments[0]?.text).toContain("still-live"));
      first.disposeAll();

      const second = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      const view = await second.ensureSession("task_1", "task_1:terminal", { columns: 90, rows: 30 });

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(fakePty.kill).not.toHaveBeenCalled();
      expect(view.rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("\n")).toContain("still-live");
      second.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("disposing one daemon tab kills only that tab session", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const firstPty = createFakePty();
    const secondPty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(firstPty)
      .mockReturnValueOnce(secondPty);
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });

      client.disposeSession("task_1:terminal");
      await vi.waitFor(() => expect(firstPty.kill).toHaveBeenCalledTimes(1));

      client.writeKey("x");

      expect(secondPty.kill).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(secondPty.writes).toEqual(["x"]));
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("hydrate reconnects multiple live sessions without changing the attached input tab", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const terminalPty = createFakePty();
    const agentPty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(terminalPty)
      .mockReturnValueOnce(agentPty);
    let daemon: Promise<void> | null = null;
    const spawnDaemon = () => {
      daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });
    };

    try {
      const first = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        spawnDaemon,
      });
      await first.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
      await first.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      terminalPty.emitData("terminal-live\r\n");
      agentPty.emitData("agent-live\r\n");
      await vi.waitFor(() => expect(viewText(first.getViewState("task_1:terminal"))).toContain("terminal-live"));
      await vi.waitFor(() => expect(viewText(first.getViewState("task_1:agent"))).toContain("agent-live"));
      first.disposeAll();

      const second = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        spawnDaemon,
      });
      await second.hydrateSessions(["task_1:terminal", "task_1:agent"]);
      await second.ensureSession("task_1", "task_1:terminal", { columns: 90, rows: 30 });
      second.writeKey("z");

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(viewText(second.getViewState("task_1:terminal"))).toContain("terminal-live");
      expect(viewText(second.getViewState("task_1:agent"))).toContain("agent-live");
      await vi.waitFor(() => expect(terminalPty.writes).toEqual(["z"]));
      expect(agentPty.writes).toEqual([]);
      second.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      if (daemon) {
        await daemon;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("streams coalesced updates only for the subscribed terminal view", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const agentPty = createFakePty();
    const terminalPty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(agentPty)
      .mockReturnValueOnce(terminalPty);
    const onUpdate = vi.fn();
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        onUpdate,
        viewUpdateMode: "incremental",
      });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
      onUpdate.mockClear();

      agentPty.emitData("background-output\r\n");
      terminalPty.emitData("first\r\n");
      terminalPty.emitData("second\r\n");
      terminalPty.emitData("third\r\n");

      await vi.waitFor(() => expect(viewText(client.getViewState("task_1:terminal"))).toContain("third"));
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith("task_1:terminal");
      expect(viewText(client.getViewState("task_1:agent"))).not.toContain("background-output");

      client.setViewedTab("task_1:agent");
      await vi.waitFor(() => expect(viewText(client.getViewState("task_1:agent"))).toContain("background-output"));
      expect(onUpdate).toHaveBeenLastCalledWith("task_1:agent");
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("snapshot mode keeps legacy full-view updates for background sessions", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const agentPty = createFakePty();
    const terminalPty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(agentPty)
      .mockReturnValueOnce(terminalPty);
    const onUpdate = vi.fn();
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        onUpdate,
      });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
      onUpdate.mockClear();

      agentPty.emitData("legacy-background-output\r\n");

      await vi.waitFor(() => expect(viewText(client.getViewState("task_1:agent"))).toContain("legacy-background-output"));
      expect(onUpdate).toHaveBeenCalledWith("task_1:agent");
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("pruneStale kills sessions not in the keep list and leaves kept sessions running", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const agentPty = createFakePty();
    const terminalPty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(agentPty)
      .mockReturnValueOnce(terminalPty);
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });

      await client.pruneStale(["task_1:agent"]);

      await vi.waitFor(() => expect(terminalPty.kill).toHaveBeenCalledTimes(1));
      expect(agentPty.kill).not.toHaveBeenCalled();
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("pruneStale from a new client cleans up ghost sessions from a previous crashed run", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const stalePty = createFakePty();
    const activePty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(stalePty)
      .mockReturnValueOnce(activePty);
    let daemon: Promise<void> | null = null;
    const spawnDaemon = () => {
      daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });
    };

    try {
      const first = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        spawnDaemon,
      });
      await first.ensureSession("task_old", "task_old:agent", { columns: 80, rows: 24 });
      first.disposeAll();

      const second = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        spawnDaemon,
      });
      await second.ensureSession("task_new", "task_new:agent", { columns: 80, rows: 24 });
      await second.pruneStale(["task_new:agent"]);

      await vi.waitFor(() => expect(stalePty.kill).toHaveBeenCalledTimes(1));
      expect(activePty.kill).not.toHaveBeenCalled();
      second.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      if (daemon) {
        await daemon;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("pruneStale with an empty keep list disposes all open sessions", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const pty1 = createFakePty();
    const pty2 = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(pty1)
      .mockReturnValueOnce(pty2);
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      await client.ensureSession("task_2", "task_2:agent", { columns: 80, rows: 24 });

      await client.pruneStale([]);

      await vi.waitFor(() => expect(pty1.kill).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(pty2.kill).toHaveBeenCalledTimes(1));
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("stale daemon endpoint files are replaced by a new daemon", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    await writeFile(join(paths.runtimeDir, "pty-daemon.pid"), "999999", "utf8");
    let daemon: Promise<void> | null = null;

    const client = await createDaemonPtyRuntime({
      paths,
      workspaceRoot: root,
      resolveSessionSpec: () => ({ cwd: root, command: [] }),
      spawnDaemon: () => {
        daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn: vi.fn(() => createFakePty()) });
      },
    });

    try {
      await client.ready();
    } finally {
      client.disposeAll();
      await requestDaemonShutdown(paths);
      if (daemon) {
        await daemon;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("incompatible live daemon is shut down and replaced", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const endpoint = getDaemonEndpointForTest(root);
    await writeFile(endpoint.pidPath, "999999", "utf8");
    const legacyServer = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        const request = JSON.parse(buffer.slice(0, newlineIndex)) as { id: number; type: string };
        socket.write(`${JSON.stringify({ id: request.id, ok: true })}\n`);
        if (request.type === "shutdown") {
          socket.end();
          legacyServer.close();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      legacyServer.once("error", reject);
      legacyServer.listen(endpoint.socketPath, resolve);
    });
    let daemon: Promise<void> | null = null;

    const client = await createDaemonPtyRuntime({
      paths,
      workspaceRoot: root,
      resolveSessionSpec: () => ({ cwd: root, command: [] }),
      spawnDaemon: () => {
        daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn: vi.fn(() => createFakePty()) });
      },
    });

    try {
      await client.ready();
    } finally {
      client.disposeAll();
      await requestDaemonShutdown(paths);
      if (daemon) {
        await daemon;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "craig-pty-daemon-"));
  await ensureCraigState(root);
  await mkdir(getCraigPaths(root).runtimeDir, { recursive: true });
  return root;
}

function viewText(view: { rows: Array<{ segments: Array<{ text: string }> }> }): string {
  return view.rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("\n");
}

function getDaemonEndpointForTest(workspaceRoot: string): { socketPath: string; pidPath: string } {
  const workspaceHash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const paths = getCraigPaths(workspaceRoot);
  return {
    socketPath: join(tmpdir(), `craig-${workspaceHash}.sock`),
    pidPath: join(paths.runtimeDir, "pty-daemon.pid"),
  };
}

function createFakePty() {
  /* eslint-disable no-unused-vars */
  const dataListeners: Array<(...args: [string]) => void> = [];
  const exitListeners: Array<(...args: [{ exitCode: number }]) => void> = [];
  /* eslint-enable no-unused-vars */

  return {
    pid: 123,
    cols: 80,
    rows: 24,
    process: "zsh",
    handleFlowControl: false,
    writes: [] as Array<string | Buffer>,
    /* eslint-disable no-unused-vars */
    onData(listener: (...args: [string]) => void) {
      dataListeners.push(listener);
      return { dispose: vi.fn() };
    },
    onExit(listener: (...args: [{ exitCode: number }]) => void) {
      exitListeners.push(listener);
      return { dispose: vi.fn() };
    },
    /* eslint-enable no-unused-vars */
    on: vi.fn(),
    resize(columns: number, rows: number) {
      this.cols = columns;
      this.rows = rows;
    },
    clear: vi.fn(),
    write(input: string | Buffer) {
      this.writes.push(input);
    },
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData(chunk: string) {
      for (const listener of dataListeners) {
        listener(chunk);
      }
    },
    emitExit(exitCode: number) {
      for (const listener of exitListeners) {
        listener({ exitCode });
      }
    },
  };
}
