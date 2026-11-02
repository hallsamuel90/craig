import { readFile, rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRepoRoot } from "./test-helpers.js";

const tempRoots: string[] = [];
const stdoutWriteMock = vi.fn(() => true);
const stderrWriteMock = vi.fn(() => true);

describe("cli terminal startup", () => {
  beforeEach(() => {
    vi.resetModules();
    stdoutWriteMock.mockReset();
    stderrWriteMock.mockReset();

    vi.stubGlobal("process", {
      ...process,
      argv: ["node", "src/cli.ts"],
      env: {
        ...process.env,
        CI: undefined,
        CRAIG_AGENT_CAPABILITY: undefined,
        CRAIG_AGENT_TAB_ID: undefined,
        CRAIG_TASK_ID: undefined,
        CRAIG_WORKSPACE_ROOT: undefined,
      },
      stdin: {
        ...process.stdin,
        isTTY: true,
      },
      stdout: {
        ...process.stdout,
        isTTY: true,
        write: stdoutWriteMock,
      },
      stderr: {
        ...process.stderr,
        write: stderrWriteMock,
      },
      exit: vi.fn(),
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  });

  test("no-arg startup launches the terminal shell", async () => {
    const workspaceRoot = await createRepoRoot("craig-cli-");
    tempRoots.push(workspaceRoot);
    process.chdir(workspaceRoot);

    const startTerminalApp = vi.fn(async () => 0);
    vi.doMock("../src/ui/app.js", () => ({ startTerminalApp }));

    await import("../src/cli.js");

    expect(startTerminalApp).toHaveBeenCalledTimes(1);
    expect(startTerminalApp).toHaveBeenCalledWith(
      expect.objectContaining({
        uiStateFile: expect.stringContaining(".craig/runtime/ui-state.json"),
        workspaceRoot: expect.stringContaining("craig-cli-"),
      }),
    );
    expect(stdoutWriteMock).not.toHaveBeenCalled();
    expect(stderrWriteMock).not.toHaveBeenCalled();
  });

  test("restarts from the newly installed global Craig after terminal cleanup", async () => {
    const workspaceRoot = await createRepoRoot("craig-cli-restart-");
    tempRoots.push(workspaceRoot);
    process.chdir(workspaceRoot);
    process.argv = ["node", "src/cli.ts"];

    const startTerminalApp = vi.fn(async () => 75);
    const restartCraig = vi.fn(async () => 0);
    vi.doMock("../src/ui/app.js", () => ({ startTerminalApp }));
    vi.doMock("../src/shell/craig-update.js", () => ({
      CRAIG_RESTART_EXIT_CODE: 75,
      restartCraig,
    }));

    await import("../src/cli.js");

    expect(restartCraig).toHaveBeenCalledWith({
      argv: [],
      cwd: expect.stringContaining("craig-cli-restart-"),
      env: process.env,
    });
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  test("prints a relaunch instruction when automatic restart fails", async () => {
    const workspaceRoot = await createRepoRoot("craig-cli-restart-failure-");
    tempRoots.push(workspaceRoot);
    process.chdir(workspaceRoot);

    const startTerminalApp = vi.fn(async () => 75);
    const restartCraig = vi.fn(async () => { throw new Error("global Craig was not found"); });
    vi.doMock("../src/ui/app.js", () => ({ startTerminalApp }));
    vi.doMock("../src/shell/craig-update.js", () => ({
      CRAIG_RESTART_EXIT_CODE: 75,
      restartCraig,
    }));

    await import("../src/cli.js");

    expect(stderrWriteMock).toHaveBeenCalledWith(expect.stringContaining("could not restart automatically: global Craig was not found"));
    expect(stderrWriteMock).toHaveBeenCalledWith(expect.stringContaining("Run `craig` again"));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("the CLI no longer references the deleted interactive stack", async () => {
    const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

    expect(source).toContain("startTerminalApp");
    expect(source).not.toContain("startInteractiveApp");
    expect(source).not.toContain("startRepl");
  });
});
