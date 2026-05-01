import { readFile, rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRepoRoot } from "./test-helpers.js";

const tempRoots: string[] = [];
const stdoutWriteMock = vi.fn(() => true);
const stderrWriteMock = vi.fn(() => true);

describe("cli phase 0 startup", () => {
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

  test("no-arg startup prints the phase 0 placeholder", async () => {
    const workspaceRoot = await createRepoRoot("craig-cli-");
    tempRoots.push(workspaceRoot);
    process.chdir(workspaceRoot);

    await import("../src/cli.js");

    expect(stdoutWriteMock).toHaveBeenCalledWith(
      "Craig phase 0 is active: the old interactive shell has been removed, and the new terminal workspace shell is not implemented yet.\n",
    );
    expect(stderrWriteMock).not.toHaveBeenCalled();
  });

  test("the CLI no longer references the deleted interactive stack", async () => {
    const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

    expect(source).not.toContain("startInteractiveApp");
    expect(source).not.toContain("startRepl");
    expect(source).not.toContain("renderBanner");
  });
});
