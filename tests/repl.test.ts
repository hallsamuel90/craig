import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type MockReadline = {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  question: ReturnType<typeof vi.fn>;
};

const createInterfaceMock = vi.fn();
const executeCommandMock = vi.fn();
const focusPaneMock = vi.fn();
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

vi.mock("../src/services/tmux-session.js", () => ({
  focusPane: focusPaneMock,
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
    focusPaneMock.mockReset();
    stdoutWriteMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("recreates the REPL after focus failures instead of exiting", async () => {
    const firstRl = buildReadline(["new refactor auth"]);
    const secondRl = buildReadline(["exit"]);

    createInterfaceMock.mockReturnValueOnce(firstRl).mockReturnValueOnce(secondRl);
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
    focusPaneMock.mockRejectedValueOnce(new Error("tmux select failed"));

    const { startRepl } = await import("../src/repl.js");
    const exitCode = await startRepl({
      paths: {
        repoRoot: "/repo",
      },
    } as never);

    expect(exitCode).toBe(0);
    expect(createInterfaceMock).toHaveBeenCalledTimes(2);
    expect(secondRl.question).toHaveBeenCalledWith("craig> ");
    expect(stdoutWriteMock).toHaveBeenCalledWith(expect.stringContaining("tmux select failed"));
  });
});
