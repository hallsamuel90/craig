import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type MockReadline = {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  question: ReturnType<typeof vi.fn>;
};

const createInterfaceMock = vi.fn();
const executeCommandMock = vi.fn();
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

vi.mock("../src/control-view.js", () => ({
  renderControlView: vi.fn(async () => "CRAIG CONTROL\n<workspace summary>"),
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
    stdoutWriteMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("keeps the REPL active after registering a repo", async () => {
    const firstRl = buildReadline(["repo add ./repo-a", "exit"]);

    createInterfaceMock.mockReturnValueOnce(firstRl);
    executeCommandMock
      .mockResolvedValueOnce({
        kind: "createRepo",
        repo: {
          id: "repo_repo-a",
          name: "repo-a",
          rootPath: "/workspace/repo-a",
          defaultBranch: "main",
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
        },
        workspaceId: "workspace_repo_repo-a",
        created: true,
      })
      .mockResolvedValueOnce({ kind: "exit" });

    const { startRepl } = await import("../src/repl.js");
    const exitCode = await startRepl({
      paths: {
        workspaceRoot: "/workspace",
      },
    } as never);

    expect(exitCode).toBe(0);
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);
    expect(firstRl.question).toHaveBeenCalledWith("craig> ");
    expect(stdoutWriteMock).toHaveBeenCalledWith(expect.stringContaining("Registered repo repo_repo-a"));
  });

  test("prints command errors and keeps the REPL active until exit", async () => {
    const firstRl = buildReadline(["repo remove repo_missing", "exit"]);

    createInterfaceMock.mockReturnValueOnce(firstRl);
    executeCommandMock.mockRejectedValueOnce(new Error("Cannot remove repo repo_missing."));
    executeCommandMock.mockResolvedValueOnce({ kind: "exit" });

    const { startRepl } = await import("../src/repl.js");
    const exitCode = await startRepl({
      paths: {
        workspaceRoot: "/workspace",
      },
    } as never);

    expect(exitCode).toBe(0);
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteMock).toHaveBeenCalledWith(expect.stringContaining("Cannot remove repo repo_missing."));
  });
});
