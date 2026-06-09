import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startTerminalApp, type PtyRuntimePort, type TerminalRuntime } from "../src/ui/app.js";
import type { TerminalViewState } from "../src/ui/state.js";
import { listRepos } from "../src/state/repo-store.js";
import { runCommand, runCommandAllowingFailure } from "../src/utils/exec.js";
import { readTask, writeTask } from "../src/state/task-store.js";
import { readCraigConfig } from "../src/state/config-store.js";
import { createCraigState, createGitRepo, createStubCommands, writeRepoRecord, writeTaskRecord } from "./test-helpers.js";

/* eslint-disable no-unused-vars */
type TerminalEventListener = (...args: unknown[]) => void;
/* eslint-enable no-unused-vars */

describe("terminal app PTY attach flow", () => {
  const tempRoots: string[] = [];
  const originalPath = process.env.PATH ?? "";
  const originalGhMode = process.env.CRAIG_TEST_GH_MODE;
  const originalGhViewFile = process.env.CRAIG_TEST_GH_VIEW_FILE;
  const originalDisableCommandPathFallbacks = process.env.CRAIG_DISABLE_COMMAND_PATH_FALLBACKS;
  let stdinDescriptor: PropertyDescriptor | undefined;
  let stdoutDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    restoreProperty(process.stdin, "isTTY", stdinDescriptor);
    restoreProperty(process.stdout, "isTTY", stdoutDescriptor);
    process.env.PATH = originalPath;
    process.env.CRAIG_TEST_GH_MODE = originalGhMode;
    process.env.CRAIG_TEST_GH_VIEW_FILE = originalGhViewFile;
    process.env.CRAIG_DISABLE_COMMAND_PATH_FALLBACKS = originalDisableCommandPathFallbacks;
    await Promise.all(
      tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })),
    );
  });

  test("renders shell frames with absolute row positioning instead of newlines", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    const frame = terminal.frames.at(-1) ?? "";
    expect(frame).not.toContain("\n");
    expect(frame).toContain("\u001B[1;1H");
    expect(frame).toContain(`\u001B[${terminal.height};1H`);

    terminal.emitKey("\r");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("CRAIG"));
    terminal.emitKey("q");
    await expect(app).resolves.toBe(0);
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
      expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a");
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
      expect(terminal.frames.join("\n")).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll");
    },
  );

  test("terminal mode captures mouse button reporting for wheel scroll", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    expect(terminal.grabInput).toHaveBeenLastCalledWith(true);
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    expect(terminal.grabInput).toHaveBeenLastCalledWith({ mouse: "button" });
    terminal.emitKey("\u001D");
    expect(terminal.grabInput).toHaveBeenLastCalledWith(true);
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

  test("terminal mode forwards up/down to PTY when not scrolled back, PAGE_UP starts scrollback", async () => {
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

    // UP/DOWN when not scrolled back go to PTY, not viewport scroll
    terminal.emitKey("UP");
    terminal.emitKey("DOWN");
    await vi.waitFor(() => expect(ptyRuntime.writeKey).toHaveBeenCalledWith("UP"));
    expect(ptyRuntime.writeKey).toHaveBeenCalledWith("DOWN");
    expect(ptyRuntime.scrollViewport).not.toHaveBeenCalled();

    // PAGE_UP always scrolls the viewport regardless of scroll state
    terminal.emitKey("PAGE_UP");
    await vi.waitFor(() => expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(-5));

    terminal.emitKey("\u001D");
    terminal.emitKey("q");
    await expect(app).resolves.toBe(0);
  });

  test("boot start hydrates and renders the restored selected PTY tab without attaching input", async () => {
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
        selectedPtyTabId: "task_20260430_02:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "task_20260430_02:terminal",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.hydrateSessions).toHaveBeenCalledWith([
      "task_20260430_02:agent",
      "task_20260430_02:terminal",
    ]));
    expect(ptyRuntime.pruneStale).toHaveBeenCalledWith([
      "task_20260430_02:agent",
      "task_20260430_02:terminal",
    ]);
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
    expect(terminal.frames.join("\n")).toContain("+ new tab");
  });

  test("boot start renders a restored hydrated agent tab without prompting to attach", async () => {
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

    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("task_20260430_02 task_20260430_02:ag"));

    expect(stripAnsi(terminal.frames.at(-1) ?? "")).not.toContain("Press Enter on the AGENT tab to attach");
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

  test("boot start renders the active agent tab even when the persisted selected PTY tab is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    await writeTask(paths, {
      ...(await readTask(paths, "task_20260430_02")),
      selectedPtyTabId: "task_20260430_02:agent",
    });
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: "task_20260430_02:missing",
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

    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("task_20260430_02 task_20260430_02:ag"));

    expect(stripAnsi(terminal.frames.at(-1) ?? "")).not.toContain("Press Enter on the AGENT tab to attach");
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

  test("boot start prunes stale daemon sessions not in the active task list", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.pruneStale).toHaveBeenCalledWith([
      "task_20260430_02:agent",
      "task_20260430_02:terminal",
    ]));
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("+ New Task"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

  test("boot start calls pruneStale before hydrateSessions so stale kills happen first", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const callOrder: string[] = [];
    const ptyRuntime = new FakePtyRuntime();
    ptyRuntime.pruneStale = vi.fn(() => { callOrder.push("prune"); });
    ptyRuntime.hydrateSessions = vi.fn(() => { callOrder.push("hydrate"); });
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(callOrder.length).toBeGreaterThanOrEqual(2));
    for (let index = 0; index < callOrder.length - 1; index += 1) {
      if (callOrder[index] === "prune") {
        expect(callOrder[index + 1]).toBe("hydrate");
      }
    }
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("+ New Task"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

  test("boot start passes an empty list to pruneStale when there are no tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-empty-"));
    tempRoots.push(root);
    const repoRoot = join(root, "repo-empty");
    await mkdir(repoRoot, { recursive: true });
    await createGitRepo(repoRoot);
    const paths = await createCraigState(root, []);
    await writeRepoRecord(root, {
      id: "repo_empty",
      name: "repo-empty",
      rootPath: repoRoot,
      defaultBranch: "main",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    });
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.pruneStale).toHaveBeenCalledWith([]));
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("+ New Task"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

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
    await vi.waitFor(async () => expect(JSON.parse(await readFile(paths.uiStateFile, "utf8")).inputMode).toBe("control"));
    expect(terminal.frames.join("\n")).toContain("+ new tab");
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
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a");
    terminal.emitKey("ENTER");
    terminal.emitKey("n");
    terminal.emitUnknown("n");
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.writeKey).toHaveBeenCalledWith("n");
    expect(ptyRuntime.write).not.toHaveBeenCalledWith("n");
  });

  test("terminal mode preserves repeated characters in fast pasted printable key events", async () => {
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
    const command = "curl -fsSL https://claude.ai/install.sh | bash";
    for (const char of command) {
      terminal.emitKey(char);
    }
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const forwarded = ptyRuntime.writeKey.mock.calls.map(([key]) => key).join("");
    expect(forwarded).toContain(command);
  });

  test("terminal mode forwards shift+tab to the attached Codex PTY", async () => {
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
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:agent",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("SHIFT_TAB");
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.writeKey).toHaveBeenCalledWith("SHIFT_TAB");
  });

  test("terminal resume re-enters fullscreen and clears before repainting", async () => {
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
    terminal.fullscreen.mockClear();
    terminal.moveTo.mockClear();
    terminal.eraseDisplayBelow.mockClear();
    ptyRuntime.resize.mockClear();

    process.emit("SIGCONT");

    await vi.waitFor(() => expect(terminal.fullscreen).toHaveBeenCalledWith(true));
    expect(ptyRuntime.resize).toHaveBeenCalledWith(expect.objectContaining({ columns: expect.any(Number), rows: expect.any(Number) }));
    expect(terminal.moveTo).toHaveBeenCalledWith(1, 1);
    expect(terminal.eraseDisplayBelow).toHaveBeenCalled();
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
  });

  test("terminal mode maps Ghostty shift+enter CSI-u input to a PTY line feed", async () => {
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
    terminal.emitUnknown("\u001B[13;2u");
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.writeKey).toHaveBeenCalledWith("SHIFT_ENTER");
    expect(ptyRuntime.write).not.toHaveBeenCalledWith("\u001B[13;2u");
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
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a");
    terminal.emitKey("ENTER");
    terminal.emitMouse("MOUSE_WHEEL_UP");
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    await vi.waitFor(() => expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(3));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.scrollViewport).toHaveBeenCalledWith(3);
    expect(ptyRuntime.write).not.toHaveBeenCalledWith(expect.stringContaining("[<64;"));
  });

  test("raw unknown input in terminal mode is forwarded to the PTY without viewport scroll", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a");
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    terminal.emitUnknown("some-raw-input");
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.scrollViewport).not.toHaveBeenCalled();
    expect(ptyRuntime.write).toHaveBeenCalledWith("some-raw-input");
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
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a");
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
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
    const stubDir = await createStubCommands(root);
    process.env.PATH = `${stubDir}:${originalPath}`;
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

  test("enter on a selected task in the left pane drops directly into its selected PTY tab", async () => {
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
      "task_20260430_02:terminal",
      expect.objectContaining({ columns: expect.any(Number) }),
    );
  });

  test("center + creates a second terminal tab and attaches that concrete tab", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("+");
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
    await vi.waitFor(() => expect(ptyRuntime.hydrateSessions).toHaveBeenCalled());
    terminal.emitKey("+");
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

  test("center a creates a Codex tab when all task tabs are closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await readTask(paths, "task_20260430_02");
    await writeTask(paths, {
      ...task,
      selectedPtyTabId: null,
      ptyTabs: [],
    });
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: null,
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "inspection",
        preferredPtyTabKind: "terminal",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("a");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:agent",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, "task_20260430_02");
    expect(updatedTask.ptyTabs).toHaveLength(1);
    expect(updatedTask.ptyTabs[0]).toMatchObject({
      id: "task_20260430_02:agent",
      kind: "agent",
      title: "Codex",
    });
    expect(updatedTask.selectedPtyTabId).toBe("task_20260430_02:agent");
  });

  test("center a with a selected alternate runner opens and attaches that runner tab", async () => {
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
    terminal.emitKey("r"); // codex
    terminal.emitKey("r"); // cursor
    terminal.emitKey("a");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:cursor",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll"));
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).not.toContain("Press Enter to attach this PTY-backed agent session.");
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, "task_20260430_02");
    expect(updatedTask.selectedPtyTabId).toBe("task_20260430_02:cursor");
    expect(updatedTask.ptyTabs.find((tab) => tab.id === "task_20260430_02:cursor")).toMatchObject({
      kind: "agent",
      runner: "cursor",
      title: "Cursor",
      command: ["cursor-agent"],
    });
  });

  test("center t creates a terminal tab and attaches it immediately", async () => {
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
        activeTab: "inspection",
        preferredPtyTabKind: "agent",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("t");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:terminal-2",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, "task_20260430_02");
    expect(updatedTask.ptyTabs.find((tab) => tab.id === "task_20260430_02:terminal-2")).toMatchObject({
      kind: "terminal",
      title: "Terminal 2",
    });
    expect(updatedTask.selectedPtyTabId).toBe("task_20260430_02:terminal-2");
  });

  test("center + creates Codex by default when all task tabs are closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await readTask(paths, "task_20260430_02");
    await writeTask(paths, {
      ...task,
      selectedPtyTabId: null,
      ptyTabs: [],
    });
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_20260430_02",
        selectedPtyTabId: null,
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "inspection",
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
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:agent",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, "task_20260430_02");
    expect(updatedTask.ptyTabs[0]).toMatchObject({
      id: "task_20260430_02:agent",
      kind: "agent",
      title: "Codex",
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
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalledWith(
      "task_20260430_02",
      "task_20260430_02:terminal-2",
      expect.objectContaining({ columns: expect.any(Number) }),
    ));
    terminal.emitKey("\u001D");
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

  test("files inspector selection opens file content without attaching a PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await prepareInspectableTask(paths);
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: task.id,
        selectedPtyTabId: "task_20260430_02:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "task_20260430_02:terminal",
        inspectionMode: "files",
        openInspectionKind: null,
        selectedFilePath: "README.md",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    await vi.waitFor(() => expect(ptyRuntime.hydrateSessions).toHaveBeenCalled());
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("FILES"));
    terminal.emitKey("[");
    terminal.emitKey("[");
    terminal.emitKey("[");
    terminal.emitKey("TAB");
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("ENTER"); // open selected file in the center inspection tab
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("after staged"));
    terminal.emitKey("DOWN"); // src directory
    terminal.emitKey("ENTER"); // expand src
    terminal.emitKey("DOWN"); // src/app.ts
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("export const app = true;"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("diff inspector selection opens a grouped file diff without attaching a PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await prepareInspectableTask(paths);
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: task.id,
        selectedPtyTabId: "task_20260430_02:terminal",
        inputMode: "control",
        focusedRegion: "inspector",
        activeTab: "task_20260430_02:terminal",
        inspectionMode: "diff",
        openInspectionKind: null,
        selectedDiffPath: "README.md",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    await vi.waitFor(() => expect(ptyRuntime.hydrateSessions).toHaveBeenCalled());
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("CHANGES  FILES"));
    terminal.emitKey("[");
    terminal.emitKey("[");
    terminal.emitKey("[");
    terminal.emitKey("TAB");
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("ENTER"); // open selected diff in the center inspection tab
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("after staged"));
    terminal.emitKey("DOWN"); // src/app.ts
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("after"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("mouse wheel diff scrolling refreshes when it advances to the next changed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await prepareInspectableTask(paths);
    await writeFile(
      paths.uiStateFile,
      JSON.stringify({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: task.id,
        selectedPtyTabId: "task_20260430_02:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "inspection",
        inspectionMode: "diff",
        openInspectionKind: "diff",
        selectedDiffPath: "README.md",
        selectedActionId: "commit",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }),
    );
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("after staged"));
    terminal.emitMouse("MOUSE_WHEEL_DOWN");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("after unstaged"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("switching to diff refreshes task changes made after startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await prepareCleanInspectableTask(paths);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    await writeFile(join(task.worktreePath, "README.md"), "changed after craig started\n", "utf8");
    terminal.emitKey("\r"); // boot start
    terminal.emitKey("[");
    terminal.emitKey("[");
    terminal.emitKey("[");
    terminal.emitKey("TAB"); // center
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("LEFT"); // changes
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("changed"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review P does not create a PR from the side panel", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "";
    process.env.CRAIG_TEST_GH_MODE = "no-pr";
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: task.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("R refresh checks"));
    terminal.emitKey("P");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.prs).toHaveLength(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review refresh discovers an externally-created PR for the task branch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 23,
        url: "https://github.com/example/repo/pull/23",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: task.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("R refresh checks"));
    terminal.emitKey("R");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("#23"));
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("✓ Refreshed checks: 1 reported");
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).not.toContain("Discovered PR");
    terminal.emitKey("LEFT"); // files
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("✓ Refreshed checks: 1 reported");
    await vi.advanceTimersByTimeAsync(3100);
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).not.toContain("✓ Refreshed checks: 1 reported"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.prs[0]?.number).toBe(23);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("polling discovers an externally-created PR for the selected task", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await writeFile(paths.configFile, JSON.stringify({ github: { watchIntervalSeconds: 1 } }, null, 2), "utf8");
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 24,
        url: "https://github.com/example/repo/pull/24",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: task.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    await vi.waitFor(async () => {
      const updatedTask = await readTask(paths, task.id);
      expect(updatedTask.prs[0]?.number).toBe(24);
    }, { timeout: 2500 });
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).not.toContain("Discovered PR");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.prs[0]?.number).toBe(24);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("polling refreshes unselected task badges without navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await writeFile(paths.configFile, JSON.stringify({ github: { watchIntervalSeconds: 1 } }, null, 2), "utf8");
    const unselectedTask = await writeTaskRecord(root, {
      id: "task_20260430_03",
      title: "background poll",
      status: "checked",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      branch: "craig/task_20260430_03",
      worktreePath: join(root, "worktrees", "repo_a", "task_20260430_03"),
      lastCommit: {
        sha: "background-sha",
        message: "ship background task",
        committedAt: "2026-05-04T00:00:00.000Z",
      },
    });
    await mkdir(unselectedTask.worktreePath, { recursive: true });
    const index = JSON.parse(await readFile(paths.indexFile, "utf8")) as { taskIds: string[] };
    await writeFile(paths.indexFile, JSON.stringify({ ...index, taskIds: [...index.taskIds, unselectedTask.id] }, null, 2), "utf8");
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 25,
        url: "https://github.com/example/repo/pull/25",
        baseRefName: "main",
        headRefName: unselectedTask.branch,
        headRefOid: unselectedTask.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    await vi.waitFor(async () => expect((await readTask(paths, unselectedTask.id)).prs[0]?.number).toBe(25), { timeout: 2500 });
    await vi.waitFor(() => {
      const frame = stripAnsi(terminal.frames.at(-1) ?? "");
      expect(frame).toContain("background poll");
      expect(frame).toContain("✓");
    });
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const selectedTask = await readTask(paths, task.id);
    expect(selectedTask.prs[0]?.number).toBe(25);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review sync PR action shows GitHub errors and keeps Craig usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "auth-fail";
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("R refresh checks"));
    terminal.emitKey("R");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("gh auth failed"));
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("✗ gh auth failed"));
    await vi.waitFor(async () => expect(await readFile(paths.errorLogFile, "utf8")).toContain("refresh PR checks"));
    expect(await readFile(paths.errorLogFile, "utf8")).toContain("message: gh auth failed");
    terminal.emitKey("ESCAPE"); // pause
    terminal.emitKey("DOWN"); // Options
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("Error Log"));
    terminal.emitKey("DOWN"); // Error Log
    terminal.emitKey("ENTER");
    await vi.waitFor(() => {
      const frame = stripAnsi(terminal.frames.at(-1) ?? "");
      expect(frame).toContain("Error Log");
      expect(frame).toContain("gh auth failed");
      expect(frame).toContain(paths.errorLogFile);
    });
    terminal.emitKey("ESCAPE"); // Options
    terminal.emitKey("ESCAPE"); // Pause
    terminal.emitKey("ESCAPE"); // Main
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.prs).toHaveLength(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review sync PR action refreshes metadata without pushing new commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir, remoteRepo } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const initialSha = task.lastCommit!.sha;
    await writeFile(join(task.worktreePath, "README.md"), "synced again\n", "utf8");
    await runCommand("git", ["add", "-A"], { cwd: task.worktreePath });
    await runCommand("git", ["commit", "-m", "sync task"], { cwd: task.worktreePath });
    const nextSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: task.worktreePath })).stdout.trim();
    await writeTask(paths, {
      ...task,
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: task.branch,
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-04T00:00:00.000Z",
        lastSyncedHeadSha: initialSha,
      }],
      lastCommit: {
        sha: nextSha,
        message: "sync task",
        committedAt: "2026-05-04T00:00:00.000Z",
      },
    });
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: nextSha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("#17"));
    terminal.emitKey("R");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("Refreshed checks: 0 reported"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    const remoteBranch = await runCommandAllowingFailure("git", ["rev-parse", `refs/heads/${task.branch}`], { cwd: remoteRepo });
    expect(updatedTask.prs[0]?.lastSyncedHeadSha).toBe(nextSha);
    expect(remoteBranch.exitCode).not.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review refresh checks action updates tracked PR checks without attaching a PTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await writeTask(paths, {
      ...task,
      status: "pr_open",
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: task.branch,
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [{ name: "ci", status: "pending", conclusion: null }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-04T00:00:00.000Z",
        lastSyncedHeadSha: task.lastCommit?.sha ?? null,
      }],
    });
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: task.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { context: "ci", state: "SUCCESS", conclusion: "SUCCESS" },
          { context: "docs", state: "COMPLETED", conclusion: "SKIPPED" },
        ],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("#17"));
    terminal.emitKey("R");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("Refreshed checks: 2 reported"));
    await vi.waitFor(async () => {
      const refreshedTask = await readTask(paths, task.id);
      expect(refreshedTask.prs[0]?.requiredChecks.map((check) => `${check.name}:${check.status}`)).toEqual([
        "ci:success",
        "docs:skipped",
      ]);
    });
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.prs[0]?.requiredChecks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "ci:success",
      "docs:skipped",
    ]);
    expect(updatedTask.status).toBe("merge_ready");
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review refresh dedupes stale cancelled checks and captures review blockers and comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await writeTask(paths, {
      ...task,
      status: "pr_open",
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: task.branch,
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [{ name: "ci", status: "failed", conclusion: "CANCELLED" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-04T00:00:00.000Z",
        lastSyncedHeadSha: task.lastCommit?.sha ?? null,
      }],
    });
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: task.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "REVIEW_REQUIRED",
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: [
          { context: "ci", state: "COMPLETED", conclusion: "CANCELLED", completedAt: "2026-05-04T00:01:00.000Z" },
          { context: "ci", state: "SUCCESS", conclusion: "SUCCESS", completedAt: "2026-05-04T00:02:00.000Z" },
        ],
        comments: [
          {
            author: { login: "octocat" },
            bodyText: "Please get another approval before merging.",
            createdAt: "2026-05-04T00:03:00.000Z",
            url: "https://github.com/example/repo/pull/17#issuecomment-1",
          },
        ],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("#17"));
    terminal.emitKey("R");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("Refreshed checks: 1 reported"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.status).toBe("pr_open");
    expect(updatedTask.prs[0]?.requiredChecks).toEqual([{ name: "ci", status: "success", conclusion: "SUCCESS" }]);
    expect(updatedTask.prs[0]?.reviewDecision).toBe("REVIEW_REQUIRED");
    expect(updatedTask.prs[0]?.comments?.[0]?.body).toBe("Please get another approval before merging.");
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review refresh checks action shows missing PR errors and keeps Craig usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "no-pr";
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("R refresh checks"));
    terminal.emitKey("R");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("No PR found for"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review M does not merge a ready PR from the side panel", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await writeTask(paths, {
      ...task,
      status: "merge_ready",
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: task.branch,
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-04T00:00:00.000Z",
        lastSyncedHeadSha: task.lastCommit?.sha ?? null,
      }],
    });
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: task.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("#17"));
    terminal.emitKey("M");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.status).toBe("merge_ready");
    expect(updatedTask.prs[0]?.status).toBe("open");
    expect(updatedTask.cleanup.preservedWorktree).toBe(false);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review M does not run merge blocker checks from the side panel", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const { task, stubDir } = await preparePrTask(paths, tempRoots);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await writeTask(paths, {
      ...task,
      status: "merge_ready",
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: task.branch,
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-04T00:00:00.000Z",
        lastSyncedHeadSha: task.lastCommit?.sha ?? null,
      }],
    });
    const viewFile = join(root, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: task.branch,
        headRefOid: task.lastCommit?.sha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: [{ context: "ci", state: "IN_PROGRESS", conclusion: null }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("#17"));
    terminal.emitKey("M");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.status).toBe("merge_ready");
    expect(updatedTask.prs[0]?.requiredChecks[0]?.status).toBe("success");
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("review close task action marks merged tasks closed and disposes task sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await readTask(paths, "task_20260430_02");
    await mkdir(task.worktreePath, { recursive: true });
    await writeTask(paths, {
      ...task,
      status: "merged",
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "merged",
        draft: false,
        baseBranch: "main",
        headBranch: task.branch,
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-04T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      }],
    });
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("TAB"); // inspector
    terminal.emitKey("RIGHT"); // review
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("#17"));
    terminal.emitKey("X");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("Archived task task_20260430_02"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.status).toBe("closed");
    expect(updatedTask.cleanup.preservedWorktree).toBe(true);
    expect(ptyRuntime.disposeSession).toHaveBeenCalledWith("task_20260430_02:agent");
    expect(ptyRuntime.disposeSession).toHaveBeenCalledWith("task_20260430_02:terminal");
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("left task row x archives an unmerged task, hides it, and disposes task sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const task = await readTask(paths, "task_20260430_02");
    await mkdir(task.worktreePath, { recursive: true });
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02"));
    terminal.emitKey("["); // focus left pane
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("n new task"));
    terminal.emitKey("x");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("Archived task task_20260430_02"));
    await vi.waitFor(async () => expect((await readTask(paths, task.id)).status).toBe("closed"), { timeout: 10000 });
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("· no tasks yet"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, task.id);
    expect(updatedTask.status).toBe("closed");
    expect(updatedTask.cleanup.preservedWorktree).toBe(true);
    expect(ptyRuntime.disposeSession).toHaveBeenCalledWith("task_20260430_02:agent");
    expect(ptyRuntime.disposeSession).toHaveBeenCalledWith("task_20260430_02:terminal");
  }, 15000);

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
    expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("TERMINAL  task_20260430_02 · repo-a");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
  });

  test("left-pane attach keeps the selected terminal tab when the agent tab is missing", async () => {
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
      "task_20260430_02:terminal",
      expect.anything(),
    ));
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const updatedTask = await readTask(paths, "task_20260430_02");
    expect(updatedTask.ptyTabs.map((tab) => tab.id)).toEqual(["task_20260430_02:terminal"]);
    expect(updatedTask.selectedPtyTabId).toBe("task_20260430_02:terminal");
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
    const stubDir = await createStubCommands(root);
    process.env.PATH = `${stubDir}:${originalPath}`;
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

  test("creating a task from the left pane uses the selected runner profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-runner-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const stubDir = await createStubCommands(root);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("["); // focus left pane
    terminal.emitKey("DOWN"); // + New Task
    terminal.emitKey("r"); // Cursor
    terminal.emitKey("r"); // Claude
    terminal.emitKey("ENTER");
    for (const char of "use claude runner") {
      terminal.emitKey(char);
    }
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(ptyRuntime.ensureSession).toHaveBeenCalled());
    terminal.emitKey("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const createdTaskId = String(ptyRuntime.ensureSession.mock.calls[0]?.[0] ?? "");
    const task = await readTask(paths, createdTaskId);
    expect(task.runner).toBe("claude");
    expect(task.runnerSession.command).toEqual(["claude", "use claude runner"]);
    expect(task.ptyTabs.find((tab) => tab.kind === "agent")).toMatchObject({
      title: "Claude",
      command: ["claude"],
    });
  });

  test("options menu toggles runners and edits runner paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-options-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("DOWN"); // Options
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(terminal.frames.at(-1) ?? "").toContain("Runners"));

    terminal.emitKey("ENTER"); // Runners submenu
    await vi.waitFor(() => expect(terminal.frames.at(-1) ?? "").toContain("Codex  enabled"));

    terminal.emitKey("ENTER"); // Codex toggle (already at index 0)
    await vi.waitFor(async () => expect((await readCraigConfig(paths)).runners?.codex?.enabled).toBe(false));

    terminal.emitKey("DOWN"); // Cursor (index 1)
    terminal.emitKey("e"); // edit Cursor executable path
    for (const char of "/tmp/cursor-agent") {
      terminal.emitKey(char);
    }
    terminal.emitKey("ENTER");
    await vi.waitFor(async () => expect((await readCraigConfig(paths)).runners?.cursor?.path).toBe("/tmp/cursor-agent"));

    terminal.emitKey("ESCAPE"); // back to options menu
    terminal.emitKey("ESCAPE"); // back to boot menu
    terminal.emitKey("DOWN");
    terminal.emitKey("ENTER");
    await expect(app).resolves.toBe(0);
  });

  test("missing selected runner binary leaves a durable failed task", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-missing-runner-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const stubDir = await createStubCommands(root);
    await rm(join(stubDir, "claude"), { force: true });
    await writeFile(
      paths.configFile,
      JSON.stringify({
        runners: {
          codex: { enabled: false },
          cursor: { enabled: false },
          claude: { enabled: true },
        },
      }),
      "utf8",
    );
    process.env.PATH = `${stubDir}:/bin:/usr/bin`;
    process.env.CRAIG_DISABLE_COMMAND_PATH_FALLBACKS = "1";
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("["); // focus left pane
    terminal.emitKey("DOWN"); // + New Task
    terminal.emitKey("ENTER");
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("NEW TASK"));
    for (const char of "missing claude") {
      terminal.emitKey(char);
    }
    terminal.emitKey("ENTER");
    await vi.waitFor(async () => {
      const tasks = await import("../src/services/list-tasks.js").then(({ listTasks }) => listTasks(paths));
      expect(tasks.tasks.some((task) => task.runner === "claude" && task.runnerSession.lastKnownState === "failed")).toBe(true);
    });
    await vi.waitFor(() => expect(stripAnsi(terminal.frames.at(-1) ?? "")).toContain("▸ missing claude"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.ensureSession).not.toHaveBeenCalled();
    const taskIds = (await import("../src/services/list-tasks.js").then(({ listTasks }) => listTasks(paths))).tasks.map((task) => task.id);
    const createdTaskId = taskIds.find((id) => id !== "task_20260430_02");
    expect(createdTaskId).toBeDefined();
    const task = await readTask(paths, createdTaskId!);
    expect(task.runner).toBe("claude");
    expect(task.runnerSession.lastKnownState).toBe("failed");
    expect(task.lastFailureReason).toMatch(/claude/);
  }, 10000);

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
    await vi.waitFor(() => expect(terminal.frames.join("\n")).toContain("Registered workspace: repo-b"));
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    const repos = await listRepos(paths);
    expect(repos.map((repo) => repo.name)).toContain("repo-b");
    expect(terminal.frames.join("\n")).toContain("Registered workspace: repo-b");
  });

  test("the left panel can remove an empty workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const paths = await setupWorkspace(root);
    const repoBRoot = join(root, "repo-b");
    await mkdir(repoBRoot, { recursive: true });
    await createGitRepo(repoBRoot);
    await writeRepoRecord(
      root,
      {
        id: "repo_b",
        name: "repo-b",
        rootPath: repoBRoot,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "workspace_repo_b",
        kind: "repo",
        name: "repo-b",
        rootPath: repoBRoot,
        primaryRepoId: "repo_b",
        repoId: "repo_b",
        discoveredRepoIds: ["repo_b"],
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    );

    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile: paths.uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("\r"); // boot start
    terminal.emitKey("["); // focus left pane
    terminal.emitKey("DOWN"); // + New Task under repo-a
    terminal.emitKey("DOWN"); // repo-b workspace
    terminal.emitKey("x");

    await vi.waitFor(() => expect(stripAnsi(terminal.frames.join("\n"))).toContain("Removed workspace"));
    await expect(readFile(join(paths.workspacesDir, "workspace_repo_b.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(paths.reposDir, "repo_b.json"), "utf8")).resolves.toContain(repoBRoot);

    terminal.emitKey("q");
    await expect(app).resolves.toBe(0);
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
  private readonly hydratedTabIds = new Set<string>();
  private scrollbackLines = 0;
  ensureSession = vi.fn((taskId: string, tabId: string): TerminalViewState => this.getRunningView(taskId, tabId));
  hydrateSessions = vi.fn((tabIds: string[]) => {
    for (const tabId of tabIds) {
      this.hydratedTabIds.add(tabId);
    }
  });
  pruneStale = vi.fn();
  write = vi.fn();
  writeKey = vi.fn();
  scrollViewport = vi.fn((lines: number) => {
    this.scrollbackLines = Math.max(0, this.scrollbackLines - lines);
  });
  resize = vi.fn();
  detach = vi.fn();
  disposeSession = vi.fn();
  disposeAll = vi.fn();

  getViewState(tabId: string | null): TerminalViewState {
    if (tabId && (this.hydratedTabIds.has(tabId) || this.ensureSession.mock.calls.some(([, attachedTabId]) => attachedTabId === tabId))) {
      return this.getRunningView("task_20260430_02", tabId);
    }

    return {
      status: "idle",
      rows: [],
      error: null,
      scrolledBack: false,
    };
  }

  private getRunningView(taskId: string, tabId: string): TerminalViewState {
    return {
      status: "running",
      rows: [{ segments: [{ text: `${taskId} ${tabId} $` }] }],
      error: null,
      scrolledBack: this.scrollbackLines > 0,
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

async function prepareInspectableTask(paths: Awaited<ReturnType<typeof setupWorkspace>>) {
  const task = await prepareCleanInspectableTask(paths);
  await writeFile(join(task.worktreePath, "README.md"), "after staged\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: task.worktreePath });
  await writeFile(join(task.worktreePath, "src", "app.ts"), "export const app = true;\n// after unstaged\n", "utf8");
  await writeFile(join(task.worktreePath, "new.txt"), "brand new\n", "utf8");
  await writeFile(join(task.worktreePath, "ignored.txt"), "ignored\n", "utf8");
  return task;
}

async function prepareCleanInspectableTask(paths: Awaited<ReturnType<typeof setupWorkspace>>) {
  const task = await readTask(paths, "task_20260430_02");
  await mkdir(task.worktreePath, { recursive: true });
  await createGitRepo(task.worktreePath);
  await mkdir(join(task.worktreePath, "src"), { recursive: true });
  await writeFile(join(task.worktreePath, ".gitignore"), "ignored.txt\n", "utf8");
  await writeFile(join(task.worktreePath, "README.md"), "before\n", "utf8");
  await writeFile(join(task.worktreePath, "src", "app.ts"), "export const app = false;\n", "utf8");
  await runCommand("git", ["add", ".gitignore", "README.md", "src/app.ts"], { cwd: task.worktreePath });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: task.worktreePath });
  return task;
}

async function preparePrTask(paths: Awaited<ReturnType<typeof setupWorkspace>>, tempRoots: string[]) {
  const task = await readTask(paths, "task_20260430_02");
  const repoRoot = join(paths.workspaceRoot, "repo-a");
  const remoteRepo = await mkdtemp(join(tmpdir(), "craig-ui-remote-"));
  tempRoots.push(remoteRepo);
  await runCommand("git", ["init", "--bare", remoteRepo], { cwd: paths.workspaceRoot });
  await runCommand("git", ["remote", "add", "origin", remoteRepo], { cwd: repoRoot });
  await runCommand("git", ["push", "-u", "origin", "main"], { cwd: repoRoot });
  await runCommand("git", ["worktree", "add", "-b", task.branch, task.worktreePath, "main"], { cwd: repoRoot });
  await writeFile(join(task.worktreePath, "README.md"), "ready for pr\n", "utf8");
  await runCommand("git", ["add", "-A"], { cwd: task.worktreePath });
  await runCommand("git", ["commit", "-m", "ship task"], { cwd: task.worktreePath });
  const sha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: task.worktreePath })).stdout.trim();
  const fullStubDir = await createStubCommands(paths.workspaceRoot);
  const stubDir = await mkdtemp(join(tmpdir(), "craig-ui-gh-"));
  tempRoots.push(stubDir);
  await symlink(join(fullStubDir, "gh"), join(stubDir, "gh"));
  const updatedTask = {
    ...task,
    status: "checked" as const,
    lastCommit: {
      sha,
      message: "ship task",
      committedAt: "2026-05-04T00:00:00.000Z",
    },
  };
  await writeTask(paths, updatedTask);
  return { task: updatedTask, stubDir, remoteRepo };
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
