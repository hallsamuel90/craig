import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test, vi } from "vitest";

import { createDaemonPtyRuntime, requestDaemonShutdown, servePtyDaemon } from "../src/ui/pty/daemon.js";
import { tryConnectPtyDaemonActivity } from "../src/shell/pty-daemon-activity.js";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { ensureCraigState } from "../src/domain/workspace/workspaces/ensure.js";
import { configService } from "../src/domain/config/index.js";
import { taskService } from "../src/domain/task/index.js";
import { appendTaskId } from "../src/domain/task/adapters/task-store.js";
import { promptCommandService, readAllEvents } from "../src/domain/orchestration/index.js";
import { watchWorkspaceEvents } from "../src/shell/events.js";
import { disposeDaemonSessions, wakeOrchestrationSupervisor } from "../src/shell/pty-daemon-orchestration.js";
import { requestOpenFile } from "../src/shell/ui-navigation.js";
import { runCommand } from "../src/shared/exec.js";
import { createCraigState, createGitRepo, createStubCommands, writeTaskRecord } from "./test-helpers.js";

const DAEMON_TEST_TIMEOUT_MS = 15000;

describe("PTY daemon", () => {
  test("synchronizes pull requests through the production adapter without a connected TUI or orchestration preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-pr-sync-daemon-"));
    const paths = await createCraigState(root, ["task_1"]);
    await createGitRepo(root);
    await writeFile(join(root, "index.ts"), "export const value = 1;\n", "utf8");
    await runCommand("git", ["add", "index.ts"], { cwd: root });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: root });
    await runCommand("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: root });

    const stubDir = await createStubCommands(root);
    const ghBinDir = join(root, "gh-bin");
    await mkdir(ghBinDir, { recursive: true });
    await symlink(join(stubDir, "gh"), join(ghBinDir, "gh"));
    const previousPath = process.env.PATH;
    const previousGraphqlFile = process.env.CRAIG_TEST_GH_GRAPHQL_FILE;
    process.env.PATH = `${ghBinDir}:${previousPath ?? ""}`;
    const graphqlFile = join(root, "gh-graphql.json");
    await writeFile(graphqlFile, JSON.stringify({
      data: {
        repository: {
          item0: {
            nodes: [{
              number: 41,
              url: "https://github.com/example/repo/pull/41",
              baseRefName: "main",
              headRefName: "craig/task_1",
              headRefOid: "remote-head",
              state: "OPEN",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: { contexts: { nodes: [] } },
            }],
          },
        },
      },
    }), "utf8");
    process.env.CRAIG_TEST_GH_GRAPHQL_FILE = graphqlFile;
    await writeTaskRecord(root, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath: root,
    });
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: {
        heartbeatIntervalMs: 10,
      },
    });

    try {
      await vi.waitFor(async () => {
        expect((await taskService.getTask(paths, "task_1")).prs[0]?.number).toBe(41);
      });
      expect((await taskService.getTask(paths, "task_1")).status).toBe("pr_open");
      expect(configService.previews.isEnabled(await configService.load(paths), "agentOrchestration")).toBe(false);
      await vi.waitFor(async () => {
        expect((await readAllEvents(paths)).some((event) => event.type === "task.created")).toBe(true);
      });
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      restoreEnv("PATH", previousPath);
      restoreEnv("CRAIG_TEST_GH_GRAPHQL_FILE", previousGraphqlFile);
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("accelerates daemon-owned pull request synchronization after a semantic task event", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-pr-event-wake-"));
    const paths = await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1", status: "checked" });
    const syncTasks = vi.fn(async (_paths, tasks) => tasks);
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: {
        heartbeatIntervalMs: 10,
        minimumIntervalMs: 1_000,
        dependencies: {
          listTasks: async () => [await taskService.getTask(paths, "task_1")],
          syncTasks,
        },
      },
    });

    try {
      await vi.waitFor(() => expect(syncTasks).toHaveBeenCalledOnce());
      await vi.waitFor(async () => {
        expect((await readAllEvents(paths)).some((event) => event.type === "task.created")).toBe(true);
      });
      const task = await taskService.getTask(paths, "task_1");
      await writeTaskRecord(root, {
        ...task,
        lastCommit: {
          sha: "0123456789abcdef0123456789abcdef01234567",
          message: "semantic change",
          committedAt: "2026-08-06T12:00:00.000Z",
        },
      });
      await vi.waitFor(() => expect(syncTasks).toHaveBeenCalledTimes(2), { timeout: 2_500 });
      const events = await readAllEvents(paths);
      expect(events).toContainEqual(expect.objectContaining({
        type: "task.updated",
        taskId: "task_1",
        data: expect.objectContaining({ changedFields: expect.arrayContaining(["lastCommitSha"]) }),
      }));
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("notifies connected TUIs after daemon-owned PR state changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-pr-sync-event-"));
    const paths = await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1", status: "checked" });
    const onTasksChanged = vi.fn();
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: {
        heartbeatIntervalMs: 100,
        dependencies: {
          listTasks: async () => [(await taskService.getTask(paths, "task_1"))],
          syncTasks: async () => {
            const current = await taskService.getTask(paths, "task_1");
            const updated = await writeTaskRecord(root, { ...current, status: "pr_open" });
            return [updated];
          },
        },
      },
    });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        onTasksChanged,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await vi.waitFor(() => expect(onTasksChanged).toHaveBeenCalledWith(["task_1"]));
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("notifies connected TUIs when another process creates a task", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-task-create-event-"));
    const paths = await createCraigState(root, ["task_parent"]);
    await writeTaskRecord(root, { id: "task_parent", title: "planning parent" });
    const onTasksChanged = vi.fn();
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: {
        heartbeatIntervalMs: 100,
        dependencies: {
          listTasks: async () => (await taskService.listTasks(paths)).tasks,
          syncTasks: async (_paths, tasks) => tasks,
        },
      },
    });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        onTasksChanged,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await vi.waitFor(async () => {
        expect((await readAllEvents(paths))).toContainEqual(expect.objectContaining({
          type: "task.created",
          taskId: "task_parent",
        }));
      });
      onTasksChanged.mockClear();

      await writeTaskRecord(root, {
        id: "task_child",
        title: "agent-created child",
        parentTaskId: "task_parent",
        rootTaskId: "task_parent",
        delegationDepth: 1,
      });
      // Let the task-directory notification reconcile before the authoritative
      // workspace index changes. The index notification must trigger a second
      // reconciliation so this write ordering cannot strand the new task.
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      await appendTaskId(paths, "task_child");

      await vi.waitFor(() => expect(onTasksChanged).toHaveBeenCalledWith(["task_child"]), { timeout: 2_500 });
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("delivers file-open navigation only to subscribed TUI clients", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const onOpenFile = vi.fn();
    const daemon = servePtyDaemon(paths, { pullRequestSync: false });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        onOpenFile,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      const filePath = join(root, "notes.md");

      await expect(requestOpenFile(paths, filePath)).resolves.toBe(true);
      await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(filePath));
      client.disposeAll();
      await expect(requestOpenFile(paths, filePath)).resolves.toBe(false);
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("submits four concurrent durable initial prompts before promoting their tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-concurrent-agent-startup-"));
    const taskIds = ["task_1", "task_2", "task_3", "task_4"];
    const paths = await createCraigState(root, taskIds);
    await configService.save(paths, { previews: { agentOrchestration: true } });
    await Promise.all(taskIds.map((id) => writeTaskRecord(root, { id, status: "draft", runner: "cursor" })));
    const ptys = taskIds.map(() => createFakePty());
    const spawn = vi.fn(() => ptys.shift()!);
    const daemon = servePtyDaemon(paths, {
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn,
    });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: ["/bin/sh"] }),
      });
      await Promise.all(taskIds.map((taskId) =>
        client.ensureSession(taskId, `${taskId}:agent`, { columns: 80, rows: 24 })));
      const commands = await Promise.all(taskIds.map(async (taskId) =>
        (await promptCommandService.create(paths, {
          taskId,
          agentTabId: `${taskId}:agent`,
          prompt: { source: "inline", text: `initial prompt for ${taskId}` },
          delivery: "when-ready",
          timeoutMs: 10_000,
          idempotencyKey: `task-start:${taskId}`,
          actor: { type: "system", component: "orchestration-supervisor" },
        })).command));
      expect(await Promise.all(taskIds.map(() => wakeOrchestrationSupervisor(paths))))
        .toEqual(taskIds.map(() => true));
      expect((await Promise.all(taskIds.map((id) => taskService.getTask(paths, id))))
        .every((task) => task.status === "draft")).toBe(true);

      await vi.waitFor(async () => {
        const settled = await Promise.all(commands.map((command) => promptCommandService.show(paths, command.id)));
        expect(settled.map((result) => result.command.state)).toEqual(taskIds.map(() => "delivered"));
      }, { timeout: 8_000 });
      await vi.waitFor(async () => {
        expect((await Promise.all(taskIds.map((id) => taskService.getTask(paths, id))))
          .every((task) => task.status === "running")).toBe(true);
      });
      expect(spawn).toHaveBeenCalledTimes(4);
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("resumes pull request synchronization after a daemon restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-pr-sync-restart-"));
    const paths = await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1", status: "merged" });
    const startSyncDaemon = (nextStatus: "pr_open" | "checked") => servePtyDaemon(paths, {
      pullRequestSync: {
        heartbeatIntervalMs: 10,
        dependencies: {
          listTasks: async () => [(await taskService.getTask(paths, "task_1"))],
          syncTasks: async () => {
            const current = await taskService.getTask(paths, "task_1");
            return [await writeTaskRecord(root, { ...current, status: nextStatus })];
          },
        },
      },
    });
    let daemon = startSyncDaemon("pr_open");

    try {
      await vi.waitFor(async () => {
        expect((await taskService.getTask(paths, "task_1")).status).toBe("pr_open");
      });
      await requestDaemonShutdown(paths);
      await daemon;

      const current = await taskService.getTask(paths, "task_1");
      await writeTaskRecord(root, { ...current, status: "merged" });
      daemon = startSyncDaemon("checked");
      await vi.waitFor(async () => {
        expect((await taskService.getTask(paths, "task_1")).status).toBe("checked");
      });
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

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
        activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });

      await expect(disposeDaemonSessions(paths, ["task_1:terminal"])).resolves.toBe(true);
      await vi.waitFor(() => expect(firstPty.kill).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => {
        const records = (await readFile(paths.logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        expect(records).toEqual(expect.arrayContaining([
          expect.objectContaining({ level: "info", component: "pty", event: "spawned", tabId: "task_1:terminal" }),
          expect.objectContaining({ level: "info", component: "pty", event: "disposed", tabId: "task_1:terminal" }),
        ]));
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
      expect(client.getActivitySnapshots().some((snapshot) => snapshot.tabId === "task_1:terminal")).toBe(false);

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
      first.setViewedTab("task_1:terminal");
      terminalPty.emitData("terminal-live\r\n");
      await vi.waitFor(() => expect(viewText(first.getViewState("task_1:terminal"))).toContain("terminal-live"));
      first.setViewedTab("task_1:agent");
      agentPty.emitData("agent-live\r\n");
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

  test("streams activity for background sessions and restores activity snapshots on reconnect", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const agentPty = createFakePty();
    const spawn = vi.fn(() => agentPty);
    const onActivity = vi.fn();
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const first = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        onActivity,
      });
      await first.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      first.setViewedTab(null);
      agentPty.emitData("background-agent-output\r\n");

      await vi.waitFor(() => expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({
        taskId: "task_1",
        tabId: "task_1:agent",
        sessionState: "running",
      })));
      const lastActivityAt = first.getActivitySnapshots()[0]?.lastActivityAt;
      expect(lastActivityAt).toEqual(expect.any(Number));
      first.disposeAll();

      const second = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      expect(second.getActivitySnapshots()).toEqual([
        expect.objectContaining({
          taskId: "task_1",
          tabId: "task_1:agent",
          sessionState: "running",
          lastActivityAt,
        }),
      ]);

      agentPty.emitExit(7);
      await vi.waitFor(() => expect(second.getActivitySnapshots()[0]).toEqual(expect.objectContaining({
        sessionState: "exited",
        exitCode: 7,
      })));
      second.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("marks a running activity snapshot failed when the daemon connection is lost", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const agentPty = createFakePty();
    const daemon = servePtyDaemon(paths, {
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => agentPty),
    });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      await vi.waitFor(() => expect(client.getActivitySnapshots()).toEqual([
        expect.objectContaining({ tabId: "task_1:agent", sessionState: "running" }),
      ]));
      await requestDaemonShutdown(paths);
      await vi.waitFor(() => expect(client.getActivitySnapshots()).toEqual([
        expect.objectContaining({
          tabId: "task_1:agent",
          sessionState: "failed",
          error: "Craig PTY daemon connection closed.",
        }),
      ]));
      client.disposeAll();
    } finally {
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("exposes activity through the shell-owned read-only daemon client", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const agentPty = createFakePty();
    const onDaemonClose = vi.fn();
    const daemon = servePtyDaemon(paths, {
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => agentPty),
    });

    try {
      const runtime = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      const activity = await tryConnectPtyDaemonActivity({ paths, onDaemonClose });
      expect(activity).not.toBeNull();
      await vi.waitFor(() => expect(activity?.getSnapshots()).toEqual([
        expect.objectContaining({ tabId: "task_1:agent", sessionState: "running" }),
      ]));

      await requestDaemonShutdown(paths);
      await vi.waitFor(() => expect(onDaemonClose).toHaveBeenCalledTimes(1));
      expect(activity?.getSnapshots()).toEqual([
        expect.objectContaining({
          tabId: "task_1:agent",
          sessionState: "failed",
          error: "Craig PTY daemon connection closed.",
        }),
      ]);
      activity?.close();
      runtime.disposeAll();
    } finally {
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("keeps an event watch connected through agent transitions, daemon loss, and reconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-event-watch-daemon-"));
    const paths = await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1" });
    await configService.save(paths, { previews: { agentOrchestration: true } });
    const agentPty = createFakePty();
    const daemon = servePtyDaemon(paths, {
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => agentPty),
    });
    const controller = new AbortController();
    const states: string[] = [];
    let restartedDaemon: Promise<void> | null = null;

    try {
      const runtime = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      const watching = watchWorkspaceEvents(
        paths,
        { taskId: "task_1", typeGlob: "agent.state.changed" },
        {
          signal: controller.signal,
          pollIntervalMs: 25,
          onEvent: (event) => states.push((event.data as { state: string }).state),
        },
      );

      await vi.waitFor(() => expect(states).toContain("working"));
      await requestDaemonShutdown(paths);
      await vi.waitFor(() => expect(states).toContain("error"));
      await daemon;

      const restartedPty = createFakePty();
      restartedDaemon = servePtyDaemon(paths, {
        shell: "/bin/zsh",
        env: { TERM: "xterm-256color" },
        spawn: vi.fn(() => restartedPty),
      });
      const restartedRuntime = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await restartedRuntime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      await vi.waitFor(() => expect(states.filter((state) => state === "working")).toHaveLength(2));
      controller.abort();
      await watching;
      restartedRuntime.disposeAll();
      runtime.disposeAll();
    } finally {
      controller.abort();
      await requestDaemonShutdown(paths);
      await daemon;
      if (restartedDaemon) await restartedDaemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("restores failed spawn activity after reconnecting to the daemon", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const spawn = vi.fn(() => {
      throw new Error("agent executable missing");
    });
    const daemon = servePtyDaemon(paths, { shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

    try {
      const first = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await expect(first.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 }))
        .rejects.toThrow("agent executable missing");
      await vi.waitFor(() => expect(first.getActivitySnapshots()).toEqual([
        expect.objectContaining({ tabId: "task_1:agent", sessionState: "failed" }),
      ]));
      first.disposeAll();

      const second = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      expect(second.getActivitySnapshots()).toEqual([
        expect.objectContaining({ tabId: "task_1:agent", sessionState: "failed" }),
      ]);
      await second.pruneStale([]);
      await vi.waitFor(() => expect(second.getActivitySnapshots()).toEqual([]));
      second.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("does not stream activity until a client enables the activity subscription", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const agentPty = createFakePty();
    const onActivity = vi.fn();
    const daemon = servePtyDaemon(paths, {
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => agentPty),
    });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        onActivity,
      });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      agentPty.emitData("activity-disabled\r\n");
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
      expect(client.getActivitySnapshots()).toEqual([]);
      expect(onActivity).not.toHaveBeenCalled();

      client.setActivityEnabled(true);
      await vi.waitFor(() => expect(client.getActivitySnapshots()).toEqual([
        expect.objectContaining({ tabId: "task_1:agent", sessionState: "running" }),
      ]));

      client.setActivityEnabled(false);
      expect(client.getActivitySnapshots()).toEqual([]);
      onActivity.mockClear();
      agentPty.emitData("activity-disabled-again\r\n");
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
      expect(client.getActivitySnapshots()).toEqual([]);
      expect(onActivity).not.toHaveBeenCalled();
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
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
      });
      await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });

      client.resize({ columns: 78, rows: 22 });
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ tabId: "task_1:terminal", kind: "full" }));
      onUpdate.mockClear();
      client.scrollViewport(-1);
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ tabId: "task_1:terminal", kind: "full" }));
      onUpdate.mockClear();

      agentPty.emitData("background-output\r\n");
      terminalPty.emitData("first\r\n");
      terminalPty.emitData("second\r\n");
      terminalPty.emitData("third\r\n");

      await vi.waitFor(() => expect(viewText(client.getViewState("task_1:terminal"))).toContain("third"));
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
        tabId: "task_1:terminal",
        kind: "rows",
        rowIndices: expect.any(Array),
      }));
      expect(onUpdate.mock.calls[0]?.[0].rowIndices.length).toBeGreaterThan(0);
      expect(viewText(client.getViewState("task_1:agent"))).not.toContain("background-output");

      client.setViewedTab("task_1:agent");
      await vi.waitFor(() => expect(viewText(client.getViewState("task_1:agent"))).toContain("background-output"));
      expect(onUpdate).toHaveBeenLastCalledWith({ tabId: "task_1:agent", kind: "full" });

      onUpdate.mockClear();
      agentPty.emitExit(7);
      await vi.waitFor(() => expect(client.getViewState("task_1:agent").status).toBe("exited"));
      expect(onUpdate).toHaveBeenCalledWith({ tabId: "task_1:agent", kind: "full" });
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

  test("incompatible live daemon fails closed without shutdown or replacement", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const endpoint = getDaemonEndpointForTest(root);
    await writeFile(endpoint.pidPath, "999999", "utf8");
    let shutdownRequested = false;
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
        shutdownRequested ||= request.type === "shutdown";
      });
    });
    await new Promise<void>((resolve, reject) => {
      legacyServer.once("error", reject);
      legacyServer.listen(endpoint.socketPath, resolve);
    });
    const spawnDaemon = vi.fn();
    try {
      await expect(createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        spawnDaemon,
      })).rejects.toThrow(/will not replace a live workspace daemon/);
      expect(spawnDaemon).not.toHaveBeenCalled();
      expect(shutdownRequested).toBe(false);
      expect(JSON.parse((await readFile(paths.logFile, "utf8")).trim())).toMatchObject({
        level: "warn",
        component: "daemon",
        event: "upgrade.blocked",
      });
    } finally {
      await new Promise<void>((resolve) => legacyServer.close(() => resolve()));
      await rm(endpoint.socketPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test.each([6, 7, 8])("keeps protocol %i daemon running and preserves newer activity events", async (protocolVersion) => {
    const root = await createWorkspace();
    const endpoint = getDaemonEndpointForTest(root);
    let shutdownRequested = false;
    const legacyServer = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const request = JSON.parse(buffer.slice(0, newlineIndex)) as { id: number; type: string };
          buffer = buffer.slice(newlineIndex + 1);
          shutdownRequested ||= request.type === "shutdown";
          const response = {
            id: request.id,
            ok: true,
            ...(request.type === "ping" ? { protocolVersion } : {}),
            ...(request.type === "getActivitySnapshots"
              ? {
                  activities: [{
                    taskId: "task_1",
                    tabId: "task_1:agent",
                    sessionState: "running",
                    lastActivityAt: 1,
                    exitCode: null,
                    error: null,
                  }],
                }
              : {}),
          };
          const messages = [JSON.stringify(response)];
          if (request.type === "getActivitySnapshots") {
            messages.push(JSON.stringify({
              type: "activity",
              snapshot: {
                taskId: "task_1",
                tabId: "task_1:agent",
                sessionState: "exited",
                lastActivityAt: 2,
                exitCode: 0,
                error: null,
              },
            }));
          }
          socket.write(`${messages.join("\n")}\n`);
          newlineIndex = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      legacyServer.once("error", reject);
      legacyServer.listen(endpoint.socketPath, resolve);
    });
    const spawnDaemon = vi.fn();
    let client: Awaited<ReturnType<typeof createDaemonPtyRuntime>> | null = null;

    try {
      client = await createDaemonPtyRuntime({
        paths: getCraigPaths(root),
        workspaceRoot: root,
        activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
        spawnDaemon,
      });

      expect(client.getActivitySnapshots()).toEqual([
        expect.objectContaining({ tabId: "task_1:agent", sessionState: "exited", lastActivityAt: 2 }),
      ]);
      expect(spawnDaemon).not.toHaveBeenCalled();
      expect(shutdownRequested).toBe(false);
    } finally {
      client?.disposeAll();
      await new Promise<void>((resolve) => legacyServer.close(() => resolve()));
      await rm(endpoint.socketPath, { force: true });
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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
