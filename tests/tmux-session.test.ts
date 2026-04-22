import { readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { focusPane, getSessionNameForRepo, relayoutManagedWindow } from "../src/services/tmux-session.js";
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
    const sessionName = getSessionNameForRepo(repoRoot);

    expect(tmuxCommands).toContain("select-window -t %42");
    expect(tmuxCommands).toContain("select-pane -t %42");
    expect(tmuxCommands).toContain(`attach-session -t ${sessionName}`);
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
    const sessionName = getSessionNameForRepo(repoRoot);

    expect(tmuxCommands).toContain("select-window -t %42");
    expect(tmuxCommands).toContain("select-pane -t %42");
    expect(tmuxCommands).toContain(`switch-client -t ${sessionName}`);
    expect(tmuxCommands).not.toContain(`attach-session -t ${sessionName}`);
  });
});

describe("relayoutManagedWindow", () => {
  test("resizes the control pane after applying the tiled layout", async () => {
    const repoRoot = await createRepoRoot("craig-relayout-");
    tempRoots.push(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;

    await relayoutManagedWindow(repoRoot, "@0", true, "%1");

    const tmuxCommands = (await readFile(tmuxCommandLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(tmuxCommands).toContain("select-layout -t @0 tiled");
    expect(tmuxCommands).toContain("resize-pane -t %1 -y 8");
    expect(tmuxCommands.indexOf("select-layout -t @0 tiled")).toBeLessThan(
      tmuxCommands.indexOf("resize-pane -t %1 -y 8"),
    );
  });
});
