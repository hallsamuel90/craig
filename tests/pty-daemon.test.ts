import { EventEmitter } from "node:events";
import type { WatchListener } from "node:fs";
import { createRequire } from "node:module";
import { getPtyDaemonEndpoint } from "../src/shell/pty-daemon-protocol.js";
import { createServer, createConnection, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test, vi } from "vitest";

import { DaemonPtyRuntimeClient, createDaemonPtyRuntime, requestDaemonShutdown, servePtyDaemon } from "../src/ui/pty/daemon.js";
import { tryConnectPtyDaemonActivity } from "../src/shell/pty-daemon-activity.js";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { ensureCraigState } from "../src/domain/workspace/workspaces/ensure.js";
import { configService } from "../src/domain/config/index.js";
import { taskService } from "../src/domain/task/index.js";
import { appendTaskId } from "../src/domain/task/adapters/task-store.js";
import { authorizeCapability, ensureTaskCapabilities, mutateFuryRun, readFuryRun, promptCommandService, readAllEvents } from "../src/domain/orchestration/index.js";
import { approvePlan, createPlan, runFury } from "../src/shell/fury-runtime.js";
import { reconcileEvents } from "../src/shell/event-reconciliation.js";
import { watchWorkspaceEvents } from "../src/shell/events.js";
import { disposeDaemonSessions, wakeOrchestrationSupervisor } from "../src/shell/pty-daemon-orchestration.js";
import { requestOpenFile } from "../src/shell/ui-navigation.js";
import { refreshLiveAgentCapability } from "../src/shell/refresh-agent-capability.js";
import * as capabilities from "../src/domain/orchestration/delegation/capabilities.js";
import { runCommand } from "../src/shared/exec.js";
import { createCraigState, createGitRepo, createStubCommands, writeRepoRecord, writeTaskRecord } from "./test-helpers.js";

const DAEMON_TEST_TIMEOUT_MS = 15000;

describe("PTY daemon", () => {
  test.each([false, true])("Ghostty preview preserves an older daemon and handles an existing session: %s", async (existing) => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    await configService.save(paths, { previews: { ghosttyTerminal: true } });
    const endpoint = getDaemonEndpointForTest(root);
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    const legacy = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as { id: number; type: string };
          buffer = buffer.slice(end + 1);
          requests.push(request.type);
          socket.write(`${JSON.stringify({ id: request.id, ok: true,
            ...(request.type === "ping" ? { protocolVersion: 10, sessionCount: existing ? 1 : 0 } : {}),
            ...(["getViewState", "ensureSession"].includes(request.type) ? { view: { status: existing ? "running" : "idle", rows: [], error: null, scrolledBack: false } } : {}),
          })}\n`);
        }
      });
    });
    await new Promise<void>((resolveListen, reject) => { legacy.once("error", reject); legacy.listen(endpoint.socketPath, resolveListen); });
    const spawnDaemon = vi.fn();
    let client: Awaited<ReturnType<typeof createDaemonPtyRuntime>> | undefined;
    try {
      client = await createDaemonPtyRuntime({ paths, workspaceRoot: root, spawnDaemon });
      const result = client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      if (existing) await expect(result).resolves.toMatchObject({ status: "running" });
      else await expect(result).rejects.toThrow("Ghostty needs a newer PTY daemon");
      expect(requests).not.toContain("shutdown");
      expect(requests.filter((type) => type === "ensureSession")).toHaveLength(existing ? 1 : 0);
      expect(spawnDaemon).not.toHaveBeenCalled();
    } finally {
      client?.disposeAll();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => legacy.close(() => resolveClose()));
      await rm(endpoint.socketPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Ghostty toggle affects new sessions while existing sessions retain their backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ghostty-toggle-"));
    const paths = await createCraigState(root, ["task_1"]);
    const processes: ReturnType<typeof createFakePty>[] = [];
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: false,
      spawn: () => { const pty = createFakePty(); processes.push(pty); return pty; },
    });
    try {
      const client = await createDaemonPtyRuntime({ paths, workspaceRoot: root });
      try {
        await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
        processes[0]!.emitData("\x1b[3;7H\x1b[6n");
        await vi.waitFor(() => expect(processes[0]!.writes).toEqual(["\x1b[1;1R"]));
        await configService.save(paths, { previews: { ghosttyTerminal: true } });
        await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
        processes[1]!.emitData("\x1b[3;7H\x1b[");
        processes[1]!.emitData("6n");
        await vi.waitFor(() => expect(processes[1]!.writes).toEqual(["\x1b[3;7R"]));
        client.writeKey("UP");
        await vi.waitFor(() => expect(processes[1]!.writes).toContain("\x1b[A"));
        processes[1]!.emitData("\x1b[?1h");
        await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
        client.writeKey("UP");
        await vi.waitFor(() => expect(processes[1]!.writes).toContain("\x1bOA"));
        client.write("\x1b[200~pasted line 1\npasted line 2\x1b[201~");
        await vi.waitFor(() => expect(processes[1]!.writes).toContain("\x1b[200~pasted line 1\npasted line 2\x1b[201~"));
        // The daemon still publishes the existing row wire format.
        processes[1]!.emitData("\r\n\x1b[32mghostty-ready\x1b[0m");
        await vi.waitFor(() => expect(client.getViewState("task_1:terminal").rows.flatMap((row) => row.segments).some((segment) => segment.text.includes("ghostty-ready") && segment.style?.fg === "0dbc79")).toBe(true));
        await configService.save(paths, { previews: { ghosttyTerminal: false } });
        await client.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
        processes[1]!.emitData("\x1b[3;7H\x1b[6n");
        await vi.waitFor(() => expect(processes[1]!.writes.filter((data) => data === "\x1b[3;7R")).toHaveLength(2));
        await client.ensureSession("task_1", "task_1:terminal-2", { columns: 80, rows: 24 });
        processes[2]!.emitData("\x1b[3;7H\x1b[6n");
        await vi.waitFor(() => expect(processes[2]!.writes).toEqual(["\x1b[1;1R"]));
        expect(processes).toHaveLength(3);
      } finally { client.disposeAll(); }
    } finally {
      await requestDaemonShutdown(paths); await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("an optional startup refresh failure does not prevent spawning an agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-refresh-startup-failure-"));
    const paths = await createCraigState(root, ["task_1"]);
    const task = await writeTaskRecord(root, { id: "task_1" });
    const environment = await ensureTaskCapabilities(paths, task);
    const spawn = vi.fn(() => createFakePty());
    const refresh = vi.spyOn(capabilities, "refreshAgentCapability").mockRejectedValueOnce(new Error("Storage unavailable"));
    const daemon = servePtyDaemon(paths, { spawn, pullRequestSync: false });
    try {
      const client = await createDaemonPtyRuntime({
        paths, workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: ["/bin/sh"], env: environment }),
      });
      try {
        const view = await client.ensureSession(task.id, task.ptyTabs[0]!.id, { columns: 80, rows: 24 });
        expect(view.status).toBe("running");
        expect(spawn).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        client.disposeAll();
      }
    } finally {
      refresh.mockRestore();
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("on-demand refresh does not trust stale running activity after an unobserved process exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-refresh-stale-activity-"));
    const paths = await createCraigState(root, ["task_1"]);
    const task = await writeTaskRecord(root, { id: "task_1" });
    const environment = await ensureTaskCapabilities(paths, task);
    const token = environment.CRAIG_AGENT_CAPABILITY!;
    const file = join(paths.orchestrationDir, "capabilities", `${token.split(".")[0]}.json`);
    const agent = createFakePty();
    const daemon = servePtyDaemon(paths, { spawn: vi.fn(() => agent), pullRequestSync: false });
    try {
      const client = await createDaemonPtyRuntime({
        paths, workspaceRoot: root, activityEnabled: true,
        resolveSessionSpec: () => ({ cwd: root, command: ["/bin/sh"], env: environment }),
      });
      try {
        await client.ensureSession(task.id, task.ptyTabs[0]!.id, { columns: 80, rows: 24 });
        client.setActivityEnabled(false);
        await client.ready(); // Wait for the daemon to disable observation.
        agent.emitExit(0);
        const record = JSON.parse(await readFile(file, "utf8"));
        const expired = { ...record, expiresAt: "2020-01-01T00:00:00.000Z" };
        await writeFile(file, JSON.stringify(expired));
        await refreshLiveAgentCapability(paths, {
          taskId: task.id, agentTabId: task.ptyTabs[0]!.id, capabilityToken: token,
        });
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expired);
        await expect(authorizeCapability(paths, token, "task.children", task.id))
          .rejects.toMatchObject({ code: "CAPABILITY_DENIED", details: { reason: "expired" } });
      } finally {
        client.disposeAll();
      }
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("automatically refreshes a detached live agent's token beyond seven days without respawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-capability-refresh-"));
    const paths = await createCraigState(root, ["task_1"]);
    const task = await writeTaskRecord(root, { id: "task_1", status: "running" });
    await configService.save(paths, { previews: { agentOrchestration: true } });
    const environment = await ensureTaskCapabilities(paths, task);
    const token = environment.CRAIG_AGENT_CAPABILITY!;
    const id = token.split(".")[0]!;
    const file = join(paths.orchestrationDir, "capabilities", `${id}.json`);
    const original = JSON.parse(await readFile(file, "utf8"));
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const agentPty = createFakePty();
    const spawn = vi.fn(() => agentPty);
    const daemon = servePtyDaemon(paths, {
      shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn, pullRequestSync: false,
    });
    try {
      const client = await createDaemonPtyRuntime({
        paths, workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: ["/bin/sh"], env: environment }),
      });
      await client.ensureSession(task.id, task.ptyTabs[0]!.id, { columns: 80, rows: 24 });
      client.disposeAll(); // The daemon must refresh even without a connected TUI.

      clock += 6.5 * 24 * 60 * 60 * 1_000;
      await vi.waitFor(async () => {
        expect(Date.parse(JSON.parse(await readFile(file, "utf8")).expiresAt))
          .toBeGreaterThanOrEqual(clock + 7 * 24 * 60 * 60 * 1_000);
      });
      // Also recover after a machine sleep spans the previous expiry.
      clock += 8 * 24 * 60 * 60 * 1_000;
      await vi.waitFor(async () => {
        expect(Date.parse(JSON.parse(await readFile(file, "utf8")).expiresAt))
          .toBeGreaterThanOrEqual(clock + 7 * 24 * 60 * 60 * 1_000);
      });
      await expect(authorizeCapability(paths, token, "task.children", task.id))
        .resolves.toMatchObject({ actor: { capabilityId: id } });
      const refreshed = JSON.parse(await readFile(file, "utf8"));
      expect(refreshed).toEqual({ ...original, expiresAt: refreshed.expiresAt });
      expect(spawn).toHaveBeenCalledOnce();

      agentPty.emitExit(0);
      clock += 8 * 24 * 60 * 60 * 1_000;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(refreshed);
      await expect(authorizeCapability(paths, token, "task.children", task.id))
        .rejects.toMatchObject({ code: "CAPABILITY_DENIED", details: { reason: "expired" } });
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("delivers prompts after a newer CLI adds an unknown preview to the running daemon's config", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-daemon-future-preview-"));
    const paths = await createCraigState(root, ["task_1"]);
    await configService.save(paths, { previews: { agentOrchestration: true } });
    await writeTaskRecord(root, { id: "task_1", status: "draft", runner: "cursor" });
    const agentPty = createFakePty();
    const spawn = vi.fn(() => agentPty);
    const daemon = servePtyDaemon(paths, {
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn,
      pullRequestSync: false,
    });

    try {
      const client = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: ["/bin/sh"] }),
      });
      try {
        await client.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
        // Simulate a newer CLI writing a preview this running daemon does not know.
        await writeFile(paths.configFile, JSON.stringify({
          previews: { agentOrchestration: true, futurePreview: true },
        }), "utf8");
        const { command } = await promptCommandService.create(paths, {
          taskId: "task_1",
          agentTabId: "task_1:agent",
          prompt: { source: "inline", text: "initial prompt after upgrade" },
          delivery: "immediate",
          timeoutMs: 10_000,
          idempotencyKey: "task-start:task_1",
          actor: { type: "system", component: "orchestration-supervisor" },
        });

        expect(await wakeOrchestrationSupervisor(paths)).toBe(true);
        await vi.waitFor(async () => {
          expect((await promptCommandService.show(paths, command.id)).command.state).toBe("delivered");
          expect((await taskService.getTask(paths, "task_1")).status).toBe("running");
        });
        expect(agentPty.writes.join("")).toContain("initial prompt after upgrade");
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        client.disposeAll();
      }
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("launches a Fury child from supervisor reconciliation without waiting on its own wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-fury-supervisor-child-"));
    const paths = await createCraigState(root, ["task_root"]);
    await createGitRepo(root);
    await writeFile(join(root, "README.md"), "# Fury fixture\n");
    await runCommand("git", ["add", "README.md"], { cwd: root });
    await runCommand("git", ["commit", "-m", "fixture"], { cwd: root });
    const timestamp = new Date().toISOString();
    await writeRepoRecord(root, {
      id: "repo_a", name: "fixture", rootPath: root, defaultBranch: "main",
      createdAt: timestamp, updatedAt: timestamp,
    }, {
      id: "workspace_repo_a", primaryRepoId: "repo_a", branch: "main", status: "active",
      linkedRepoIds: [], archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    await writeTaskRecord(root, {
      id: "task_root", repoId: "repo_a", workspaceId: "workspace_repo_a", repoRoot: root, worktreePath: root,
    });
    await configService.save(paths, {
      previews: { agentOrchestration: true },
      runners: { codex: { path: "/bin/sh" } },
    });
    await mkdir(join(root, ".craig", "fury"), { recursive: true });
    const file = join(root, ".craig", "fury", "child.yaml");
    await writeFile(file, `version: 1
name: supervisor-child
limits: { max_concurrency: 1, max_tasks: 2, timeout: 1h }
steps:
  kickoff:
    task: task_root
    prompt: Start inspection.
  child:
    needs: [kickoff]
    create_child: {}
    prompt: Inspect the fixture.
  downstream:
    needs: [child]
    create_child: {}
    prompt: Verify the inspection.
`);
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: false,
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => createFakePty()),
    });
    try {
      const client = await createDaemonPtyRuntime({
        paths, workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await client.ensureSession("task_root", "task_root:agent", { columns: 80, rows: 24 });
      const actor = { type: "human" as const, source: "cli" as const, processId: process.pid };
      const { plan } = await createPlan(paths, file, {}, "task_root", actor);
      await approvePlan(paths, plan.id, actor);
      const { run } = await runFury(paths, plan.id, actor);
      await vi.waitFor(async () => {
        expect((await readFuryRun(paths, run.id)).stepRuns.kickoff?.state).toBe("running");
      });
      // Release the dependency durably; only the real daemon schedules the child.
      await mutateFuryRun(paths, run.id, (current) => ({
        ...current,
        stepRuns: { ...current.stepRuns, kickoff: { ...current.stepRuns.kickoff!, state: "succeeded" } },
      }));
      await vi.waitFor(async () => {
        const current = await readFuryRun(paths, run.id);
        expect(current.stepRuns.child?.state, current.stepRuns.child?.error ?? undefined).toBe("running");
        const taskId = current.stepRuns.child?.taskId;
        expect(taskId).toBeTruthy();
        const { commands } = await promptCommandService.list(paths, taskId!);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({ state: "delivered", attempts: 1, lastError: null });
        expect((await taskService.getTask(paths, taskId!)).status).toBe("running");
      }, { timeout: 8_000 });
      const child = (await readFuryRun(paths, run.id)).stepRuns.child!;
      const task = await taskService.getTask(paths, child.taskId!);
      const capability = await ensureTaskCapabilities(paths, task);
      const deniedBin = join(root, "worker-bin");
      await mkdir(deniedBin);
      await writeFile(join(deniedBin, "git"), "#!/bin/sh\necho worker-git-denied >&2\nexit 99\n");
      await chmod(join(deniedBin, "git"), 0o755);
      const completed = await runCommand(process.execPath, [
        "--import", createRequire(import.meta.url).resolve("tsx"), resolve("src/cli.ts"),
        "--workspace-root", root, "--json", "fury", "step", "complete", "--run", run.id, "--step", "child",
      ], {
        cwd: task.worktreePath,
        env: {
          ...process.env, PATH: `${deniedBin}:${process.env.PATH ?? ""}`,
          CRAIG_WORKSPACE_ROOT: root, CRAIG_TASK_ID: task.id, CRAIG_AGENT_TAB_ID: child.agentTabId!,
          CRAIG_AGENT_CAPABILITY: capability.CRAIG_AGENT_CAPABILITY,
        },
      });
      expect(JSON.parse(completed.stdout).data.step.state).toBe("succeeded");
      await vi.waitFor(async () => {
        const downstream = (await readFuryRun(paths, run.id)).stepRuns.downstream!;
        expect(downstream.state, downstream.error ?? undefined).toBe("running");
        expect(downstream.taskId).toBeTruthy();
        expect((await taskService.getTask(paths, downstream.taskId!)).parentTaskId).toBe("task_root");
      }, { timeout: 4_000 });
      expect((await taskService.listTasks(paths)).tasks).toHaveLength(3);
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("recovers and expires a persisted Fury review after restart with the preview disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-fury-disabled-restart-"));
    const paths = await createCraigState(root, ["task_root"]);
    await writeTaskRecord(root, { id: "task_root" });
    await configService.save(paths, { previews: { agentOrchestration: true } });
    const file = join(root, ".craig", "fury", "review.yaml");
    await mkdir(join(root, ".craig", "fury"), { recursive: true });
    await writeFile(file, `version: 1
name: review-restart
limits: { max_concurrency: 1, max_tasks: 1, timeout: 1h }
steps:
  review:
    human_review:
      title: Inspect before proceeding
      summary: Keep the checkpoint durable.
`);
    let daemon = servePtyDaemon(paths, { pullRequestSync: false });
    try {
      const client = await createDaemonPtyRuntime({
        paths, workspaceRoot: root, resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      const actor = { type: "human" as const, source: "cli" as const, processId: process.pid };
      const { plan } = await createPlan(paths, file, {}, "task_root", actor);
      await approvePlan(paths, plan.id, actor);
      const { run } = await runFury(paths, plan.id, actor);
      await vi.waitFor(async () => expect((await readFuryRun(paths, run.id)).state).toBe("waiting_for_review"));
      client.disposeAll();
      await requestDaemonShutdown(paths);
      await daemon;
      await configService.save(paths, { previews: { agentOrchestration: false } });
      await mutateFuryRun(paths, run.id, (current) => ({
        ...current, stepRuns: { ...current.stepRuns, review: { ...current.stepRuns.review!, deadlineAt: new Date(0).toISOString() } },
      }));
      daemon = servePtyDaemon(paths, { pullRequestSync: false });
      await vi.waitFor(async () => {
        expect(await readFuryRun(paths, run.id)).toMatchObject({ state: "failed", cleanupPending: false });
      }, { timeout: 4_000 });
      expect((await taskService.listTasks(paths)).tasks).toHaveLength(1);
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

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
    const notifications = createFileNotifications();
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: {
        watchPath: notifications.watchPath,
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
      notifications.emit(paths.tasksDir, "task_1.json");
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
    const reconcile = vi.fn(() => reconcileEvents(paths));
    const notifications = createFileNotifications();
    const daemon = servePtyDaemon(paths, {
      pullRequestSync: {
        watchPath: notifications.watchPath,
        reconcileEvents: reconcile,
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
      // Complete the task-directory reconciliation before changing the index.
      // This ordering must not strand a task that is not indexed yet.
      const before = reconcile.mock.calls.length;
      notifications.emit(paths.tasksDir, "task_child.json");
      await vi.waitFor(() => expect(reconcile.mock.calls.length).toBeGreaterThan(before));
      await reconcile.mock.results.at(-1)!.value;
      await appendTaskId(paths, "task_child");
      notifications.emit(paths.craigDir, ".index.json.atomic-write");

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
        // This verifies polling restart, not native filesystem delivery.
        reconcileEvents: false,
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
      pullRequestSync: false,
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => agentPty),
    });
    const controller = new AbortController();
    const states: string[] = [];
    let watching: ReturnType<typeof watchWorkspaceEvents> | undefined;
    let restartedDaemon: Promise<void> | null = null;

    try {
      const runtime = await createDaemonPtyRuntime({
        paths,
        workspaceRoot: root,
        resolveSessionSpec: () => ({ cwd: root, command: [] }),
      });
      await runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
      watching = watchWorkspaceEvents(
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
      // Finish shutting down the old owner before observing the disconnected
      // state and starting its replacement.
      await daemon;
      await vi.waitFor(() => expect(states).toContain("error"));

      const restartedPty = createFakePty();
      restartedDaemon = servePtyDaemon(paths, {
        pullRequestSync: false,
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
      await watching;
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
    const daemon = servePtyDaemon(paths, { pullRequestSync: false, shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });

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
      expect(second.getActivitySnapshots()).toHaveLength(1);
      await second.disposeSession("task_1:agent");
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
    const daemon = servePtyDaemon(paths, { pullRequestSync: false,
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

  test("pruneStale preserves sessions omitted by stale foreground inventory", async () => {
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

      expect(terminalPty.kill).not.toHaveBeenCalled();
      expect(agentPty.kill).not.toHaveBeenCalled();
      client.disposeAll();
    } finally {
      await requestDaemonShutdown(paths);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  test("pruneStale from a new client preserves sessions from the previous client", async () => {
    const root = await createWorkspace();
    const paths = getCraigPaths(root);
    const stalePty = createFakePty();
    const activePty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(stalePty)
      .mockReturnValueOnce(activePty);
    let daemon: Promise<void> | null = null;
    const spawnDaemon = () => {
      daemon = servePtyDaemon(paths, { pullRequestSync: false, shell: "/bin/zsh", env: { TERM: "xterm-256color" }, spawn });
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

      expect(stalePty.kill).not.toHaveBeenCalled();
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

  test("pruneStale with an empty keep list preserves all open sessions", async () => {
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

      expect(pty1.kill).not.toHaveBeenCalled();
      expect(pty2.kill).not.toHaveBeenCalled();
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
      const diagnostics = (await readFile(paths.logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warn", component: "daemon", event: "upgrade.blocked" }));
      expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warn", component: "runtime", event: "compatibility.rejected" }));
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

function getDaemonEndpointForTest(workspaceRoot: string) {
  return getPtyDaemonEndpoint(getCraigPaths(workspaceRoot));
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

test("an event before a scroll reply cannot override the newer authoritative viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "craig-view-response-order-"));
  const paths = await createCraigState(root, []);
  const view = (text: string) => ({ status: "exited", error: null, scrolledBack: false, rows: [{ segments: [{ text }] }] });
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (data) => {
      buffer += String(data);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (request.type === "scrollViewport") socket.write(JSON.stringify({ type: "update", tabId: "fixture:agent", view: view("previous top") }) + "\n");
        socket.write(JSON.stringify({ id: request.id, ok: true, ...(request.type === "ping" ? { protocolVersion: 10 } : {}), view: view(request.type === "scrollViewport" ? "retained final output" : "previous top") }) + "\n");
      }
    });
  });
  const endpoint = getPtyDaemonEndpoint(paths);
  await new Promise<void>((resolve) => server.listen(endpoint.socketPath, resolve));
  const socket = createConnection(endpoint.socketPath);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const client = new DaemonPtyRuntimeClient(socket, { paths, workspaceRoot: root });
  try {
    await client.ready(); await client.ensureSession("fixture", "fixture:agent", { columns: 80, rows: 24 });
    client.scrollViewport(10000);
    await vi.waitFor(() => expect(client.getViewState("fixture:agent").rows[0]?.segments[0]?.text).toBe("retained final output"));
  } finally { client.disposeAll(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("a missing input acknowledgement becomes visible uncertainty and reconnect never replays the key", async () => {
  const root = await mkdtemp(join(tmpdir(), "craig-input-ack-timeout-"));
  const paths = await createCraigState(root, []);
  let writes = 0; let ensures = 0;
  const server = createServer((socket) => {
    socket.on("error", () => undefined); let buffer = "";
    socket.on("data", (data) => {
      buffer += String(data);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (request.type === "write") { writes++; continue; }
        if (request.type === "ensureSession") ensures++;
        socket.write(JSON.stringify({ id: request.id, ok: true, ...(request.type === "ping" ? { protocolVersion: 10, capabilities: ["terminal", "activity", "splitRuntime", "navigation", "pullRequestPolling"] } : {}), view: { status: "running", error: null, rows: [] } }) + "\n");
      }
    });
  });
  const endpoint = getPtyDaemonEndpoint(paths);
  await new Promise<void>((resolve) => server.listen(endpoint.socketPath, resolve));
  const socket = createConnection(endpoint.socketPath); await new Promise<void>((resolve) => socket.once("connect", resolve));
  const client = new DaemonPtyRuntimeClient(socket, { paths, workspaceRoot: root });
  try {
    await client.ready(); await client.ensureSession("fixture", "fixture:agent", { columns: 80, rows: 24 });
    client.write("one-key");
    await vi.waitFor(() => expect(client.connectionMessage).toContain("uncertain"), { timeout: 7000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(writes).toBe(1); expect(ensures).toBe(1);
    expect(client.getViewState("fixture:agent").status).toBe("running");
  } finally { client.disposeAll(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 10000);

function createFileNotifications() {
  const listeners = new Map<string, WatchListener<string>>();
  return {
    watchPath(target: string, listener: WatchListener<string>) {
      listeners.set(target, listener);
      return Object.assign(new EventEmitter(), { close: () => { listeners.delete(target); } });
    },
    emit(target: string, filename: string) {
      const listener = listeners.get(target);
      expect(listener).toBeDefined();
      listener!("rename", filename);
    },
  };
}
