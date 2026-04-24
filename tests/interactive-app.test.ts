import { readFile, rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createCraigState, createRepoRoot } from "./test-helpers.js";

const tempRoots: string[] = [];
const renderMock = vi.fn();
const stdoutWriteMock = vi.fn(() => true);

vi.mock("ink", () => ({
  render: renderMock,
  useInput: vi.fn(),
}));

describe("startInteractiveApp", () => {
  beforeEach(() => {
    vi.resetModules();
    renderMock.mockReset();
    stdoutWriteMock.mockReset();

    vi.stubGlobal("process", {
      ...process,
      stdin: {
        ...process.stdin,
        isTTY: true,
      },
      stdout: {
        ...process.stdout,
        isTTY: true,
        columns: 160,
        rows: 48,
        write: stdoutWriteMock,
        on: vi.fn(),
        off: vi.fn(),
      },
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  });

  test("enters the alternate screen before resolving interactive startup", async () => {
    const workspaceRoot = await createRepoRoot("craig-ui-");
    tempRoots.push(workspaceRoot);
    const paths = await createCraigState(workspaceRoot);

    renderMock.mockImplementation((
      element: { props: { initialUiState: unknown; onResolve: Function } },
    ) => {
      element.props.onResolve({ kind: "exit", code: 0, uiState: element.props.initialUiState });
      return {
        unmount: vi.fn(),
        waitUntilExit: vi.fn(async () => undefined),
      };
    });

    const { startInteractiveApp } = await import("../src/interactive/app.js");
    const exitCode = await startInteractiveApp({ paths });

    expect(exitCode).toBe(0);
    expect(stdoutWriteMock).toHaveBeenNthCalledWith(1, "\x1b[?1049h\x1b[?25l");
    expect(stdoutWriteMock).toHaveBeenLastCalledWith("\x1b[?25h\x1b[?1049l");
  });

  test("the CLI no longer references a REPL fallback or pre-banner write", async () => {
    const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

    expect(source).not.toContain("startRepl");
    expect(source).not.toContain("renderBanner");
  });

  test("successful commands keep persisted task selection changes", async () => {
    const workspaceRoot = await createRepoRoot("craig-ui-command-state-");
    tempRoots.push(workspaceRoot);
    const paths = await createCraigState(workspaceRoot);
    const { readUiState, writeUiState } = await import("../src/state/ui-state-store.js");
    const { getDefaultUiState } = await import("../src/state/ui-state-store.js");
    const { resolveCommandUiState } = await import("../src/interactive/app.js");

    const staleUiState = {
      ...getDefaultUiState(),
      activeSurface: "shell" as const,
      selectedRepoId: "repo_old",
      selectedWorkspaceId: "workspace_old",
      selectedTaskId: "task_old",
    };

    await writeUiState(
      { uiStateFile: paths.uiStateFile },
      {
        ...staleUiState,
        selectedRepoId: "repo_new",
        selectedWorkspaceId: "workspace_new",
        selectedTaskId: "task_new",
      },
    );

    const resolved = await resolveCommandUiState({ paths }, staleUiState, ["Command completed."]);

    expect(resolved.selectedRepoId).toBe("repo_new");
    expect(resolved.selectedWorkspaceId).toBe("workspace_new");
    expect(resolved.selectedTaskId).toBe("task_new");
    expect(resolved.commandBuffer).toBe("");
    expect(resolved.outputLines).toEqual(["Command completed."]);
    expect((await readUiState({ uiStateFile: paths.uiStateFile }))?.selectedTaskId).toBe("task_new");
  });
});
