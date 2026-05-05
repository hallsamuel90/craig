import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startTerminalApp, type PtyRuntimePort, type TerminalRuntime } from "../src/ui/app.js";
import type { TerminalViewState } from "../src/ui/state.js";
import { listRepos } from "../src/state/repo-store.js";
import { runCommand } from "../src/utils/exec.js";
import { readTask, writeTask } from "../src/state/task-store.js";
import { createCraigState, createGitRepo, writeRepoRecord, writeTaskRecord } from "./test-helpers.js";

/* eslint-disable no-unused-vars */
type TerminalEventListener = (...args: unknown[]) => void;
/* eslint-enable no-unused-vars */

describe("terminal app PTY attach flow", () => {
  const tempRoots: string[] = [];
  let stdinDescriptor: PropertyDescriptor | undefined;
  let stdoutDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  });

  afterEach(async () => {
    restoreProperty(process.stdin, "isTTY", stdinDescriptor);
    restoreProperty(process.stdout, "isTTY", stdoutDescriptor);
    await Promise.all(
      tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })),
    );
  });

  test.each(["ENTER", "CTRL_M", "RETURN"])(
    "%s on the focused terminal center pane attaches and forwards later keys to the PTY",
    async (enterKey) => {
      const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
      tempRoots.push(root);
      const paths = await createCraigState(root, ["task_20260430_02"]);
      const repoRoot = join(root, "repo-a");
      await mkdir(repoRoot, { recursive: true });
      await writeRepoRecord(root, {
        id: "repo_a",
        name: "repo-a",
        rootPath: repoRoot,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }, {
        id: "workspace_repo_a",
        primaryRepoId: "repo_a",
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      });
      await writeTaskRecord(root, {
        id: "task_20260430_02",
        repoId: "repo_a",
        workspaceId: "workspace_repo_a",
        worktreePath: join(root, "worktrees", "repo_a", "task_20260430_02"),
      });
      const uiStateFile = paths.uiStateFile;
      await writeFile(
        uiStateFile,
        JSON.stringify({
          version: 1,
          selectedRepoId: "repo_a",
          selectedWorkspaceId: "workspace_repo_a",
          selectedTaskId: "task_20260430_02",
          selectedPtyTabId: "task_20260430_02:terminal",
          inputMode: "control",
          focusedRegion: "center",
          activeTab: "terminal",
          selectedActionId: "commit",
          updatedAt: "2026-05-04T00:00:00.000Z",
        }),
      );
      const terminal = new FakeTerminal();
      const ptyRuntime = new FakePtyRuntime();
      const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile, workspaceRoot: root });
      await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

      terminal.emitKey(enterKey);
      expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a · codex");
      expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
      terminal.emitKey(enterKey);
      terminal.emitKey("p");
      terminal.emitKey("\u001D");
      terminal.emitKey("q");

      await expect(app).resolves.toBe(0);
      expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
        "task_20260430_02",
        "task_20260430_02:terminal",
        expect.objectContaining({ columns: expect.any(Number) }),
      );
      expect(ptyRuntime.writeKey).toHaveBeenCalledWith("p");
      expect(ptyRuntime.detach).toHaveBeenCalledTimes(1);
      expect(ptyRuntime.disposeAll).toHaveBeenCalledTimes(1);
      expect(terminal.frames.join("\n")).toContain("TERMINAL   Ctrl+] detach");
      expect(terminal.frames.join("\n")).toContain("wheel/PgUp");
    },
  );

  test("raw terminal-kit unknown ctrl+] detaches from terminal mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await createCraigState(root, ["task_20260430_02"]);
    const repoRoot = join(root, "repo-a");
    await mkdir(repoRoot, { recursive: true });
    await writeRepoRecord(root, {
      id: "repo_a",
      name: "repo-a",
      rootPath: repoRoot,
      defaultBranch: "main",
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }, {
      id: "workspace_repo_a",
      primaryRepoId: "repo_a",
      branch: "main",
      status: "active",
      linkedRepoIds: [],
      archivedAt: null,
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    });
    await writeTaskRecord(root, {
      id: "task_20260430_02",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      worktreePath: join(root, "worktrees", "repo_a", "task_20260430_02"),
    });
    const uiStateFile = paths.uiStateFile;
    await writeFile(
      uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "terminal",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("ENTER");
    terminal.emitKey("ENTER");
    terminal.emitUnknown("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.detach).toHaveBeenCalledTimes(1);
    expect(terminal.frames.join("\n")).toContain("NORMAL   + new tab");
    expect(terminal.frames.join("\n")).not.toContain("terminal ▸ terminal mode");
  });

  test("terminal-mode unknown input does not duplicate single printable keys already handled by key events", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await createCraigState(root, ["task_20260430_02"]);
    const repoRoot = join(root, "repo-a");
    await mkdir(repoRoot, { recursive: true });
    await writeRepoRecord(root, {
      id: "repo_a",
      name: "repo-a",
      rootPath: repoRoot,
      defaultBranch: "main",
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }, {
      id: "workspace_repo_a",
      primaryRepoId: "repo_a",
      branch: "main",
      status: "active",
      linkedRepoIds: [],
      archivedAt: null,
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    });
    await writeTaskRecord(root, {
      id: "task_20260430_02",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      worktreePath: join(root, "worktrees", "repo_a", "task_20260430_02"),
    });
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "terminal",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a · codex");
    terminal.emitKey("ENTER");
    terminal.emitKey("n");
    terminal.emitUnknown("n");
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.writeKey).toHaveBeenCalledWith("n");
    expect(ptyRuntime.write).not.toHaveBeenCalledWith("n");
  });

  test("mouse wheel in terminal mode scrolls the PTY viewport instead of writing to the PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a · codex");
    terminal.emitKey("ENTER");
    terminal.emitMouse("MOUSE_WHEEL_UP");
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    await vi.waitFor(() => expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(3));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(terminal.grabInput).toHaveBeenCalledWith({ mouse: "button" });
    expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(3);
    expect(ptyRuntime.write).not.toHaveBeenCalledWith(expect.stringContaining("[<64;"));
  });

  test("raw mouse wheel escape input in terminal mode scrolls instead of leaking to the PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a · codex");
    terminal.emitKey("ENTER");
    terminal.emitUnknown("\u001B[<64;20;10M");
    terminal.emitUnknown("\u001B[<65;20;10M");
    terminal.emitUnknown("\u001B[<65;20;10M");
    await vi.waitFor(() => expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(3));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(3);
    expect(ptyRuntime.write).not.toHaveBeenCalledWith("\u001B[<64;20;10M");
    expect(ptyRuntime.write).not.toHaveBeenCalledWith("\u001B[<65;20;10M");
  });

  test("rapid mouse wheel events are coalesced into one PTY scroll and one redraw", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    const frameCountBeforeScroll = terminal.frames.length;
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    await vi.waitFor(() => expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(9));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.scrollViewport).toHaveBeenCalledTimes(1);
    expect(terminal.frames.length - frameCountBeforeScroll).toBeLessThanOrEqual(3);
  });

  test("creating a task from the shell provisions it and opens the agent PTY tab immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("n");
    for (const char of "ship phase 3.1") {
      terminal.emitKey(char);
    }
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const createdTaskId = String(ptyRuntime.ensureSession.mock.calls[0]?.[0] ?? "");
    expect(createdTaskId).toMatch(/^task_/);
    expect(ptyRuntime.ensureSession.mock.calls[0]?.[1]).toBe(`${createdTaskId}:agent`);
    const task = await readTask(paths, createdTaskId);
    expect(task.prompt.value).toBe("ship phase 3.1");
    expect(task.selectedPtyTabId).toBe(`${createdTaskId}:agent`);
    expect(task.ptyTabs.map((tab) => tab.kind)).toEqual(["agent", "terminal"]);
  });

  test("enter on a selected task in the left pane drops directly into its agent tab", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("["); // focus left pane
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:agent",
      expect.objectContaining({ columns: expect.any(Number) }),
    );
  });

  test("center + creates a second terminal tab and enter attaches that concrete tab", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("+");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL 2"));
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:terminal-2",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const task = await readTask(paths, "task_20260430_02");
    expect(task.selectedPtyTabId).toBe("task_20260430_02:terminal-2");
    expect(task.ptyTabs.map((tab) => tab.title)).toContain("Terminal 2");
  });

  test("center + from a Codex tab creates Codex 2 and attaches it in the task worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:agent",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "task_20260430_02:agent",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("+");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("CODEX 2"));
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:agent-2",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const task = await readTask(paths, "task_20260430_02");
    expect(task.ptyTabs.find((tab) => tab.id === "task_20260430_02:agent-2")).toMatchObject({
      kind: "agent",
      title: "Codex 2",
      command: ["codex"],
    });
  });

  test("switching PTY tabs before creating another tab does not overwrite the new tab", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("RIGHT"); // select terminal tab and trigger async selectedPtyTabId persistence
    terminal.emitKey("+"); // immediately create another terminal tab from that selection
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL 2"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const task = await readTask(paths, "task_20260430_02");
    expect(task.ptyTabs.map((tab) => tab.id)).toContain("task_20260430_02:terminal-2");
    expect(task.selectedPtyTabId).toBe("task_20260430_02:terminal-2");
  });

  test("x closes the active concrete PTY tab and disposes its runtime session", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await readTask(paths, "task_20260430_02");
    await writeTask(paths, {
      ...task,
      selectedPtyTabId: "task_20260430_02:terminal-2",
      ptyTabs: [
        ...task.ptyTabs,
        {
          id: "task_20260430_02:terminal-2",
          kind: "terminal",
          title: "Terminal 2",
          command: [],
          createdAt: "2026-05-04T00:00:00.000Z",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
      ],
    });
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:terminal-2",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "task_20260430_02:terminal-2",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:terminal-2",
      expect.anything(),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("x");
    await vi.waitFor(() => expect(ptyRuntime.disposeSession).toHaveBeenCalledWith("task_20260430_02:terminal-2"));
    await vi.waitFor(async () => {
      const updatedTask = await readTask(paths, "task_20260430_02");
      expect(updatedTask.ptyTabs.map((tab) => tab.id)).not.toContain("task_20260430_02:terminal-2");
    });
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, "task_20260430_02");
    expect(updatedTask.ptyTabs.map((tab) => tab.id)).not.toContain("task_20260430_02:terminal-2");
    expect(updatedTask.selectedPtyTabId).toBe("task_20260430_02:terminal");
  });

  test("restart restores a concrete selected PTY tab", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await readTask(paths, "task_20260430_02");
    await writeTask(paths, {
      ...task,
      selectedPtyTabId: "task_20260430_02:terminal-2",
      ptyTabs: [
        ...task.ptyTabs,
        {
          id: "task_20260430_02:terminal-2",
          kind: "terminal",
          title: "Terminal 2",
          command: [],
          createdAt: "2026-05-04T00:00:00.000Z",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
      ],
    });
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:terminal-2",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "task_20260430_02:terminal-2",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL 2"));
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:terminal-2",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

  test("ctrl-c from an attached agent stays in the same agent PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:agent",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "agent",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:agent",
      expect.anything(),
    ));
    terminal.emitKey("CTRL_C");
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.writeKey).toHaveBeenCalledWith("CTRL_C");
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:terminal",
      expect.anything(),
    );
  });

  test("stale persisted shell orientation falls back to a usable repo task selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_deleted",
        selectedWorkspaceId: "workspace_repo_deleted",
        selectedTaskId: "task_deleted",
        selectedPtyTabId: "task_deleted:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "terminal",
        inspectorSection: "next-action",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a · codex");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("left-pane attach recreates a missing agent tab instead of attaching a terminal tab", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await readTask(paths, "task_20260430_02");
    await writeTask(paths, {
      ...task,
      selectedPtyTabId: "task_20260430_02:terminal",
      ptyTabs: task.ptyTabs.filter((tab) => tab.kind === "terminal"),
    });
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:terminal",
        inputMode: "control",
        focusedRegion: "tasks",
        activeTab: "task_20260430_02:terminal",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:agent",
      expect.anything(),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, "task_20260430_02");
    expect(updatedTask.ptyTabs.find((tab) => tab.id === "task_20260430_02:agent")).toMatchObject({
      kind: "agent",
      title: "Codex",
      command: ["codex"],
    });
    expect(updatedTask.selectedPtyTabId).toBe("task_20260430_02:agent");
  });

  test("the attach enter key is not forwarded into a freshly opened task PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("["); // focus left pane
    terminal.emitKey("ENTER"); // attach selected task
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.writeKey).not.toHaveBeenCalledWith("ENTER");
  });

  test("creating a task from the left pane new-task row boots into the new agent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("["); // focus left pane
    terminal.emitKey("DOWN"); // + New Task
    terminal.emitKey("ENTER");
    for (const char of "fix busted task launch") {
      terminal.emitKey(char);
    }
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const createdTaskId = String(ptyRuntime.ensureSession.mock.calls[0]?.[0] ?? "");
    expect(createdTaskId).toMatch(/^task_/);
    expect(ptyRuntime.ensureSession.mock.calls[0]?.[1]).toBe(`${createdTaskId}:agent`);
    const task = await readTask(paths, createdTaskId);
    expect(task.prompt.value).toBe("fix busted task launch");
  });

  test("the left panel can open the new workspace browser and register a repo with arrow keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const nestedRoot = join(root, "projects");
    const repoBRoot = join(nestedRoot, "repo-b");
    await mkdir(repoBRoot, { recursive: true });
    await createGitRepo(repoBRoot);
    await writeFile(join(repoBRoot, "README.md"), "# repo-b\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: repoBRoot });
    await runCommand("git", ["commit", "-m", "init"], { cwd: repoBRoot });

    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("["); // focus left pane
    terminal.emitKey("DOWN"); // + New Task
    terminal.emitKey("DOWN"); // + New Workspace
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(terminal.frames.at(-1) ?? "").toContain("Browse for a workspace to register."));
    terminal.emitKey("DOWN"); // .craig
    terminal.emitKey("DOWN"); // projects
    terminal.emitKey("RIGHT");
    await vi.waitFor(() => expect(terminal.frames.at(-1) ?? "").toContain("repo-b [git repo]"));
    terminal.emitKey("ENTER");
    await vi.waitFor(async () => {
      const repos = await listRepos(paths);
      expect(repos.map((repo) => repo.name)).toContain("repo-b");
    });
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const repos = await listRepos(paths);
    expect(repos.map((repo) => repo.name)).toContain("repo-b");
    expect(terminal.frames.join("\n")).toContain("Registered workspace: repo-b");
  });
});

class FakeTerminal implements TerminalRuntime {
  width = 120;
  height = 36;
  frames: string[] = [];
  private keyListener: TerminalEventListener | null = null;
  private unknownListener: TerminalEventListener | null = null;
  private mouseListener: TerminalEventListener | null = null;

  moveTo = vi.fn();
  eraseDisplayBelow = vi.fn();
  grabInput = vi.fn();
  hideCursor = vi.fn();
  fullscreen = vi.fn();

  noFormat(input: string): void {
    this.frames.push(input);
  }

  on(event: "key" | "unknown" | "mouse", listener: TerminalEventListener): void {
    if (event === "key") {
      this.keyListener = listener;
    }
    if (event === "unknown") {
      this.unknownListener = listener;
    }
    if (event === "mouse") {
      this.mouseListener = listener;
    }
  }

  removeListener(event: "key" | "unknown" | "mouse", listener: TerminalEventListener): void {
    if (event === "key" && this.keyListener === listener) {
      this.keyListener = null;
    }
    if (event === "unknown" && this.unknownListener === listener) {
      this.unknownListener = null;
    }
    if (event === "mouse" && this.mouseListener === listener) {
      this.mouseListener = null;
    }
  }

  emitKey(key: string): void {
    this.keyListener?.(key);
  }

  emitUnknown(input: string): void {
    this.unknownListener?.(Buffer.from(input));
  }

  emitMouse(name: string): void {
    this.mouseListener?.(name, {});
  }

  hasKeyListener(): boolean {
    return this.keyListener !== null;
  }
}

class FakePtyRuntime implements PtyRuntimePort {
  ensureSession = vi.fn((taskId: string, tabId: string): TerminalViewState => this.getRunningView(taskId, tabId));
  write = vi.fn();
  writeKey = vi.fn();
  scrollViewport = vi.fn();
  resize = vi.fn();
  detach = vi.fn();
  disposeSession = vi.fn();
  disposeAll = vi.fn();

  getViewState(tabId: string | null): TerminalViewState {
    if (tabId && this.ensureSession.mock.calls.some(([, attachedTabId]) => attachedTabId === tabId)) {
      return this.getRunningView("task_20260430_02", tabId);
    }

    return {
      status: "idle",
      rows: [],
      error: null,
    };
  }

  private getRunningView(taskId: string, tabId: string): TerminalViewState {
    return {
      status: "running",
      rows: [{ segments: [{ text: `${taskId} ${tabId} $` }] }],
      error: null,
    };
  }
}

function restoreProperty(target: object, key: "isTTY", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }

  Reflect.deleteProperty(target, key);
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

async function setupWorkspace(root: string) {
  const paths = await createCraigState(root, ["task_20260430_02"]);
  const repoRoot = join(root, "repo-a");
  await mkdir(repoRoot, { recursive: true });
  await createGitRepo(repoRoot);
  await writeFile(join(repoRoot, "README.md"), "# repo-a\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repoRoot });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repoRoot });
  await writeRepoRecord(
    root,
    {
      id: "repo_a",
      name: "repo-a",
      rootPath: repoRoot,
      defaultBranch: "main",
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    },
    {
      id: "workspace_repo_a",
      primaryRepoId: "repo_a",
      branch: "main",
      status: "active",
      linkedRepoIds: [],
      archivedAt: null,
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    },
  );
  await writeTaskRecord(root, {
    id: "task_20260430_02",
    repoId: "repo_a",
    workspaceId: "workspace_repo_a",
    worktreePath: join(root, "worktrees", "repo_a", "task_20260430_02"),
  });
  await writeFile(
    paths.uiStateFile,
    JSON.stringify({
      version: 1,
      selectedRepoId: "repo_a",
      selectedWorkspaceId: "workspace_repo_a",
      selectedTaskId: "task_20260430_02",
      selectedPtyTabId: "task_20260430_02:terminal",
      inputMode: "control",
      focusedRegion: "center",
      activeTab: "terminal",
      selectedActionId: "commit",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }),
  );
  return paths;
}
