import { readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { focusPane } from "../src/services/tmux-session.js";
import { createRepoRoot, createStubCommands } from "./test-helpers.js";

const tempRoots: string[] = [];
const originalPath = process.env.PATH ?? "";
const originalEnv = {
  CRAIG_TEST_TMUX_COMMAND_LOG: process.env.CRAIG_TEST_TMUX_COMMAND_LOG,
  TMUX: process.env.TMUX,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  process.env.CRAIG_TEST_TMUX_COMMAND_LOG = originalEnv.CRAIG_TEST_TMUX_COMMAND_LOG;
  process.env.TMUX = originalEnv.TMUX;
});

describe("focusPane", () => {
  test("attaches the craig session when launched outside tmux", async () => {
    const repoRoot = await createRepoRoot("craig-focus-");
    tempRoots.push(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    delete process.env.TMUX;

    await focusPane(repoRoot, "%42");

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(tmuxCommands).toContain("select-pane -t %42");
    expect(tmuxCommands).toContain("attach-session -t craig");
  });

  test("switches the current client when already inside tmux", async () => {
    const repoRoot = await createRepoRoot("craig-focus-client-");
    tempRoots.push(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.TMUX = "stub-client";

    await focusPane(repoRoot, "%42");

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(tmuxCommands).toContain("select-pane -t %42");
    expect(tmuxCommands).toContain("switch-client -t craig");
    expect(tmuxCommands).not.toContain("attach-session -t craig");
  });
});
