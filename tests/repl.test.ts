import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type MockReadline = {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  question: ReturnType<typeof vi.fn>;
};

const createInterfaceMock = vi.fn();
const executeCommandMock = vi.fn();
const streamTaskLogsMock = vi.fn();
const stdoutWriteMock = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: createInterfaceMock,
}));

vi.mock("node:process", () => ({
  stdin: {},
  stdout: {
    write: stdoutWriteMock,
  },
}));

vi.mock("../src/commands/command-router.js", () => ({
  executeCommand: executeCommandMock,
}));

vi.mock("../src/services/stream-task-logs.js", () => ({
  streamTaskLogs: streamTaskLogsMock,
}));

vi.mock("../src/control-view.js", () => ({
  renderControlView: vi.fn(async () => "CRAIG CONTROL\n<no tasks>"),
}));

function buildReadline(answers: string[]): MockReadline {
  return {
    close: vi.fn(),
    on: vi.fn(),
    prompt: vi.fn(),
    question: vi.fn(async () => {
      const next = answers.shift();

      if (next === undefined) {
        throw new Error("No more answers configured for readline mock.");
      }

      return next;
    }),
  };
}

describe("startRepl", () => {
  beforeEach(() => {
    vi.resetModules();
    createInterfaceMock.mockReset();
    executeCommandMock.mockReset();
    streamTaskLogsMock.mockReset();
    stdoutWriteMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("keeps the REPL active after creating a task", async () => {
    const firstRl = buildReadline(["new refactor auth", "exit"]);

    createInterfaceMock.mockReturnValueOnce(firstRl);
    executeCommandMock
      .mockResolvedValueOnce({
        kind: "createTask",
        taskId: "task_1",
        status: "running",
        branch: "craig/task_1",
        worktreePath: "/tmp/task_1",
        tmuxTarget: "%42",
        runner: "cursor",
      })
      .mockResolvedValueOnce({ kind: "exit" });

    const { startRepl } = await import("../src/repl.js");
    const exitCode = await startRepl({
      paths: {
        repoRoot: "/repo",
      },
    } as never);

    expect(exitCode).toBe(0);
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);
    expect(firstRl.question).toHaveBeenCalledWith("craig> ");
    expect(stdoutWriteMock).toHaveBeenCalledWith(expect.stringContaining("Created task task_1"));
  });

  test("recreates the REPL after streaming logs", async () => {
    const firstRl = buildReadline(["logs task_1"]);
    const secondRl = buildReadline(["exit"]);

    createInterfaceMock.mockReturnValueOnce(firstRl).mockReturnValueOnce(secondRl);
    executeCommandMock
      .mockResolvedValueOnce({
        kind: "streamTaskLogs",
        taskId: "task_1",
        logPath: "/tmp/task_1.log",
      })
      .mockResolvedValueOnce({ kind: "exit" });

    const { startRepl } = await import("../src/repl.js");
    const exitCode = await startRepl({
      paths: {
        repoRoot: "/repo",
      },
    } as never);

    expect(exitCode).toBe(0);
    expect(createInterfaceMock).toHaveBeenCalledTimes(2);
    expect(streamTaskLogsMock).toHaveBeenCalledWith("/tmp/task_1.log");
    expect(stdoutWriteMock).toHaveBeenCalledWith(
      expect.stringContaining("Streaming logs for task_1 from /tmp/task_1.log"),
    );
  });
});
