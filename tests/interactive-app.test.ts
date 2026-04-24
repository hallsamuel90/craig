import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { startInteractiveApp } from "../src/interactive/app.js";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { readUiState, writeUiState } from "../src/state/ui-state-store.js";
import { createCraigState, createGitRepo, createRepoRoot } from "./test-helpers.js";
import { executeCommand } from "../src/commands/command-router.js";

type TestEvent =
  | { kind: "keypress"; text: string; ctrl: boolean; meta: boolean; shift: boolean; name?: string }
  | { kind: "resize" };

class FakeTerminal {
  renders: string[] = [];
  disposed = 0;
  private readonly events: TestEvent[];

  constructor(events: TestEvent[]) {
    this.events = events;
  }

  getSize() {
    return { columns: 120, rows: 24 };
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

  dispose() {
    this.disposed += 1;
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("startInteractiveApp", () => {
  test("renders the overlay and exits on ctrl-c", async () => {
    const workspaceRoot = await createRepoRoot("craig-ui-");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);
    const terminal = new FakeTerminal([{ kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" }]);

    const exitCode = await startInteractiveApp({ paths }, { terminal: terminal as never });

    expect(exitCode).toBe(0);
    expect(terminal.renders[0]).toContain("CRAIG |");
    expect(terminal.renders[0]).toContain("Start");
    expect(terminal.disposed).toBe(1);
    expect(await readUiState({ uiStateFile: paths.uiStateFile })).toMatchObject({
      activeSurface: "overlay",
      overlayMode: "start",
    });
  });

  test("restores the archived overlay mode from persisted ui state", async () => {
    const workspaceRoot = await createRepoRoot("craig-ui-restore-");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);
    await writeUiState(
      { uiStateFile: paths.uiStateFile },
      {
        version: 1,
        selectedRepoId: null,
        selectedWorkspaceId: null,
        selectedTaskId: null,
        activeSurface: "overlay",
        overlayMode: "archives",
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    );
    const terminal = new FakeTerminal([{ kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" }]);

    await startInteractiveApp({ paths }, { terminal: terminal as never });

    expect(terminal.renders[0]).toContain("Archived workspaces");
  });

  test("navigates to archives and persists the overlay mode", async () => {
    const workspaceRoot = await createRepoRoot("craig-ui-nav-");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);
    const terminal = new FakeTerminal([
      { kind: "keypress", text: "", ctrl: false, meta: false, shift: false, name: "down" },
      { kind: "keypress", text: "", ctrl: false, meta: false, shift: false, name: "return" },
      { kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" },
    ]);

    await startInteractiveApp({ paths }, { terminal: terminal as never });

    const uiState = await readUiState({ uiStateFile: paths.uiStateFile });
    expect(uiState?.overlayMode).toBe("archives");
    expect(terminal.renders.some((frame) => frame.includes("Browsing archived workspaces."))).toBe(true);
  });

  test("shows repo and workspace summary inside the overlay", async () => {
    const workspaceRoot = await createRepoRoot("craig-ui-summary-");
    const repoRoot = path.join(workspaceRoot, "repo-a");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    await mkdir(repoRoot, { recursive: true });
    await createGitRepo(repoRoot);
    const paths = getCraigPaths(workspaceRoot);
    await executeCommand({ kind: "addRepo", path: "./repo-a" }, { paths });
    const terminal = new FakeTerminal([{ kind: "keypress", text: "", ctrl: true, meta: false, shift: false, name: "c" }]);

    await startInteractiveApp({ paths }, { terminal: terminal as never });

    expect(terminal.renders[0]).toContain("Repos: 1");
    expect(terminal.renders[0]).toContain("Active workspaces: 1");
  });
});
