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
      stdout: {
        ...process.stdout,
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
    expect(startTerminalApp).toHaveBeenCalledWith({
      uiStateFile: expect.stringContaining(".craig/runtime/ui-state.json"),
    });
    expect(stdoutWriteMock).not.toHaveBeenCalled();
    expect(stderrWriteMock).not.toHaveBeenCalled();
  });

  test("the CLI no longer references the deleted interactive stack", async () => {
    const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

    expect(source).toContain("startTerminalApp");
    expect(source).not.toContain("startInteractiveApp");
    expect(source).not.toContain("startRepl");
  });
});
