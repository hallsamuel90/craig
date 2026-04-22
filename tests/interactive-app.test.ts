import { beforeEach, describe, expect, test, vi } from "vitest";

import { buildTaskRecord } from "./test-helpers.js";

const executeCommandMock = vi.fn();
const listTasksMock = vi.fn();
const streamTaskLogsMock = vi.fn();
const readSessionRuntimeMock = vi.fn();
const writeSessionRuntimeMock = vi.fn();

vi.mock("../src/commands/command-router.js", () => ({
  executeCommand: executeCommandMock,
}));

vi.mock("../src/services/list-tasks.js", () => ({
  listTasks: listTasksMock,
}));

vi.mock("../src/services/stream-task-logs.js", () => ({
  streamTaskLogs: streamTaskLogsMock,
}));

vi.mock("../src/state/runtime-store.js", async () => {
  const actual = await vi.importActual("../src/state/runtime-store.js");

  return {
    ...actual,
    readSessionRuntime: readSessionRuntimeMock,
    writeSessionRuntime: writeSessionRuntimeMock,
  };
});

type TestEvent =
  | { kind: "keypress"; text: string; ctrl: boolean; meta: boolean; shift: boolean; name?: string }
  | { kind: "resize" };

class FakeTerminal {
  renders: string[] = [];
  suspended = 0;
  resumed = 0;
  disposed = 0;
  private readonly events: TestEvent[];

  constructor(events: TestEvent[]) {
    this.events = events;
  }

  getSize() {
    return { columns: 120, rows: 20 };
  }

  render(frame: string) {
    this.renders.push(frame);
  }

  async readEvent(): Promise<TestEvent> {
    const next = this.events.shift();

    if (!next) {
      throw new Error("No more fake terminal events configured.");
    }

    return next;
  }

  suspend() {
    this.suspended += 1;
  }

  resume() {
    this.resumed += 1;
  }

  dispose() {
    this.disposed += 1;
  }
}

describe("startInteractiveApp", () => {
  beforeEach(() => {
    vi.resetModules();
    executeCommandMock.mockReset();
    listTasksMock.mockReset();
    streamTaskLogsMock.mockReset();
    readSessionRuntimeMock.mockReset();
    writeSessionRuntimeMock.mockReset();
  });

  test("restores the previous selected task and exits on double ctrl-c", async () => {
    listTasksMock.mockResolvedValue({
      kind: "listTasks",
      tasks: [
        buildTaskRecord("/repo", { id: "task_1", updatedAt: "2026-04-22T00:00:00.000Z" }),
        buildTaskRecord("/repo", { id: "task_2", updatedAt: "2026-04-22T01:00:00.000Z" }),
      ],
      missingTaskIds: [],
    });
    readSessionRuntimeMock.mockResolvedValue({
      sessionName: "craig-test",
      controlPaneTarget: "%1",
      primaryWindowTarget: "@1",
      managedPages: [],
      ui: {
        selectedTaskId: "task_2",
        workSurfaceMode: "command",
        lastContextView: "summary",
        lastCommandBuffer: "",
        lastOutputLines: [],
      },
      updatedAt: "2026-04-22T00:00:00.000Z",
    });

    const terminal = new FakeTerminal([
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    const exitCode = await startInteractiveApp({ paths: { repoRoot: "/repo", sessionFile: "/repo/.craig/runtime/session.json" } } as never, {
      terminal: terminal as never,
    });

    expect(exitCode).toBe(0);
    expect(terminal.renders[0]).toContain("> task_2");
    expect(writeSessionRuntimeMock).toHaveBeenCalled();
    expect(terminal.disposed).toBe(1);
  });

  test("selects a newly created task after command execution", async () => {
    listTasksMock
      .mockResolvedValueOnce({ kind: "listTasks", tasks: [], missingTaskIds: [] })
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_9", title: "fresh task" })],
        missingTaskIds: [],
      });
    readSessionRuntimeMock
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: null,
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: null,
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      });
    executeCommandMock.mockResolvedValue({
      kind: "createTask",
      taskId: "task_9",
      status: "running",
      branch: "craig/task_9",
      worktreePath: "/repo/.craig/worktrees/task_9",
      tmuxTarget: "%42",
      runner: "cursor",
    });

    const terminal = new FakeTerminal([
      ...toTextEvents("new fresh task"),
      { kind: "keypress", text: "", ctrl: false, meta: false, shift: false, name: "return" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    await startInteractiveApp({ paths: { repoRoot: "/repo", sessionFile: "/repo/.craig/runtime/session.json" } } as never, {
      terminal: terminal as never,
    });

    expect(executeCommandMock).toHaveBeenCalledWith({ kind: "createTask", title: "fresh task" }, expect.anything());
    expect(terminal.renders.at(-1)).toContain("> task_9");
    expect(terminal.renders.some((frame) => frame.includes("Selected task task_9."))).toBe(true);
    expect(terminal.renders.some((frame) => frame.includes("Try: show, logs, focus, open, diff, check"))).toBe(true);
    expect(writeSessionRuntimeMock).toHaveBeenLastCalledWith(
      { sessionFile: "/repo/.craig/runtime/session.json" },
      expect.objectContaining({
        ui: expect.objectContaining({
          selectedTaskId: "task_9",
        }),
      }),
    );
  });

  test("suspends the terminal while streaming logs and then resumes", async () => {
    listTasksMock
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_1" })],
        missingTaskIds: [],
      })
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_1" })],
        missingTaskIds: [],
      });
    readSessionRuntimeMock
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: "task_1",
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: "task_1",
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      });
    executeCommandMock.mockResolvedValue({
      kind: "streamTaskLogs",
      taskId: "task_1",
      logPath: "/tmp/task_1.log",
    });

    const terminal = new FakeTerminal([
      ...toTextEvents("logs task_1"),
      { kind: "keypress", text: "", ctrl: false, meta: false, shift: false, name: "return" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    await startInteractiveApp({ paths: { repoRoot: "/repo", sessionFile: "/repo/.craig/runtime/session.json" } } as never, {
      terminal: terminal as never,
    });

    expect(streamTaskLogsMock).toHaveBeenCalledWith("/tmp/task_1.log");
    expect(terminal.suspended).toBe(1);
    expect(terminal.resumed).toBe(1);
    expect(terminal.renders.some((frame) => frame.includes("Returned to Craig control surface."))).toBe(true);
  });

  test("allows typing the letter f into the command buffer", async () => {
    listTasksMock.mockResolvedValue({
      kind: "listTasks",
      tasks: [],
      missingTaskIds: [],
    });
    readSessionRuntimeMock.mockResolvedValue({
      sessionName: "craig-test",
      controlPaneTarget: "%1",
      primaryWindowTarget: "@1",
      managedPages: [],
      ui: {
        selectedTaskId: null,
        workSurfaceMode: "command",
        lastContextView: "summary",
        lastCommandBuffer: "",
        lastOutputLines: [],
      },
      updatedAt: "2026-04-22T00:00:00.000Z",
    });

    const terminal = new FakeTerminal([
      ...toTextEvents("f"),
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    await startInteractiveApp({ paths: { repoRoot: "/repo", sessionFile: "/repo/.craig/runtime/session.json" } } as never, {
      terminal: terminal as never,
    });

    expect(terminal.renders.some((frame) => frame.includes("craig> f"))).toBe(true);
  });

  test("bare show uses the selected task", async () => {
    listTasksMock.mockResolvedValue({
      kind: "listTasks",
      tasks: [buildTaskRecord("/repo", { id: "task_3" })],
      missingTaskIds: [],
    });
    readSessionRuntimeMock.mockResolvedValue({
      sessionName: "craig-test",
      controlPaneTarget: "%1",
      primaryWindowTarget: "@1",
      managedPages: [],
      ui: {
        selectedTaskId: "task_3",
        workSurfaceMode: "command",
        lastContextView: "summary",
        lastCommandBuffer: "",
        lastOutputLines: [],
      },
      updatedAt: "2026-04-22T00:00:00.000Z",
    });
    executeCommandMock.mockResolvedValue({
      kind: "showTask",
      task: buildTaskRecord("/repo", { id: "task_3" }),
      inspection: {
        worktreeExists: true,
        logExists: true,
        recentFailureReason: null,
        runnerCommandText: "cursor agent test",
        checksSummary: "not run",
        lastCommitSummary: "none",
        prSummary: "not linked",
        cleanupSummary: "none",
      },
    });

    const terminal = new FakeTerminal([
      ...toTextEvents("show"),
      { kind: "keypress", text: "", ctrl: false, meta: false, shift: false, name: "return" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    await startInteractiveApp({ paths: { repoRoot: "/repo", sessionFile: "/repo/.craig/runtime/session.json" } } as never, {
      terminal: terminal as never,
    });

    expect(executeCommandMock).toHaveBeenCalledWith(
      { kind: "showSelectedTask" },
      expect.objectContaining({ selectedTaskId: "task_3" }),
    );
  });

  test("refreshes when r is pressed on an empty command buffer and types r otherwise", async () => {
    listTasksMock
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_1" })],
        missingTaskIds: [],
      })
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_2", updatedAt: "2026-04-22T01:00:00.000Z" })],
        missingTaskIds: [],
      })
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_2", updatedAt: "2026-04-22T01:00:00.000Z" })],
        missingTaskIds: [],
      });
    readSessionRuntimeMock
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: "task_1",
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: "task_2",
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      });

    const terminal = new FakeTerminal([
      { kind: "keypress", text: "r", ctrl: false, meta: false, shift: false, name: "r" },
      ...toTextEvents("ar"),
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    await startInteractiveApp({ paths: { repoRoot: "/repo", sessionFile: "/repo/.craig/runtime/session.json" } } as never, {
      terminal: terminal as never,
    });

    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(terminal.renders.some((frame) => frame.includes("Refreshed Craig state."))).toBe(true);
    expect(terminal.renders.some((frame) => frame.includes("> task_2"))).toBe(true);
    expect(terminal.renders.some((frame) => frame.includes("craig> ar"))).toBe(true);
  });

  test("enter on an empty buffer runs the default action for the selected task", async () => {
    listTasksMock
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_7", status: "running" })],
        missingTaskIds: [],
      })
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_7", status: "running" })],
        missingTaskIds: [],
      })
      .mockResolvedValueOnce({
        kind: "listTasks",
        tasks: [buildTaskRecord("/repo", { id: "task_7", status: "running" })],
        missingTaskIds: [],
      });
    readSessionRuntimeMock
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: "task_7",
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [],
        ui: {
          selectedTaskId: "task_7",
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      });
    executeCommandMock.mockResolvedValue({
      kind: "streamTaskLogs",
      taskId: "task_7",
      logPath: "/tmp/task_7.log",
    });

    const terminal = new FakeTerminal([
      { kind: "keypress", text: "", ctrl: false, meta: false, shift: false, name: "return" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    await startInteractiveApp({ paths: { repoRoot: "/repo", sessionFile: "/repo/.craig/runtime/session.json" } } as never, {
      terminal: terminal as never,
    });

    expect(executeCommandMock).toHaveBeenCalledWith(
      { kind: "streamSelectedTaskLogs" },
      expect.objectContaining({ selectedTaskId: "task_7" }),
    );
  });
});

function toTextEvents(value: string): TestEvent[] {
  return [...value].map((character) => ({
    kind: "keypress" as const,
    text: character,
    ctrl: false,
    meta: false,
    shift: false,
  }));
}
