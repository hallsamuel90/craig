import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";
import { spawn } from "node-pty";

import { createCraigState, writeTaskRecord } from "./test-helpers.js";

describe("Craig terminal mode E2E", () => {
  test("enters terminal mode and runs a real shell command", async () => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "craig-terminal-e2e-")).then((value) => realpath(value));
    await createCraigState(workspaceRoot, ["task_20260430_02"]);
    const taskWorktree = join(workspaceRoot, "worktrees", "repo-a", "task_20260430_02");
    await mkdir(taskWorktree, { recursive: true });
    await writeTaskRecord(workspaceRoot, {
      id: "task_20260430_02",
      worktreePath: taskWorktree,
    });
    const marker = "craig_e2e_terminal_ok";
    const colorMarker = "craig_e2e_color_ok";
    const clearMarker = "craig_e2e_clear_ok";
    const cursorMarker = "craig_e2e_cursor_ok";
    const restartedMarker = "craig_e2e_restart_ok";
    const cwdPromptMarker = " task_20260430_02 %";
    const output = new PtyOutputBuffer();
    await writeInitialUiState(workspaceRoot);

    const child = spawn(resolve(repoRoot, "node_modules/.bin/tsx"), [resolve(repoRoot, "src/cli.ts")], {
      cwd: workspaceRoot,
      cols: 120,
      rows: 36,
      env: {
        ...process.env,
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TERM: "xterm-256color",
      },
    });

    child.onData((chunk) => output.append(chunk));

    try {
      await output.waitFor("> Start");
      child.write("\r");
      await output.waitFor("terminal ▸ control mode");
      child.write("\r");
      await output.waitFor("terminal ▸ terminal mode");

      await output.waitForLatestFrame(cwdPromptMarker);
      child.write(`echo ${marker}\r`);
      await output.waitFor(marker);
      child.write(`printf '\\033[31m${colorMarker}\\033[0m\\n'\r`);
      await output.waitFor(colorMarker);
      await output.waitForLatestFrame(colorMarker);
      expect(output.latestFrame()).toContain("\u001B[38;2;");
      child.write("clear\r");
      child.write(`echo ${clearMarker}\r`);
      await output.waitFor(clearMarker);
      await output.waitForLatestFrame(clearMarker);
      expect(output.latestFrame()).not.toContain(marker);
      expect(output.latestFrame()).not.toContain(colorMarker);

      child.write(`printf '\\033[3;12H${cursorMarker}'\r`);
      await output.waitForLatestFrame(cursorMarker);
      child.write("\u001D");
      await output.waitForLatestFrame("terminal ▸ control mode · Enter reattach");
      child.write("\r");
      await output.waitForLatestFrame("terminal ▸ terminal mode · Ctrl+] detach");
      await output.waitForLatestFrame(cursorMarker);
      child.write("exit\r");
      await output.waitForLatestFrame("[process exited 0]");
      child.write("\u001D");
      await output.waitForLatestFrame("terminal ▸ control mode · Enter reattach");
      child.write("\r");
      await output.waitForLatestFrame("terminal ▸ terminal mode · Ctrl+] detach");
      child.write(`echo ${restartedMarker}\r`);
      await output.waitForLatestFrame(restartedMarker);

      expect(output.value).toContain("terminal ▸ terminal mode");
      expect(output.value).toContain(cwdPromptMarker);
      expect(output.value).toContain(restartedMarker);
    } finally {
      child.kill();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 15000);
});

async function writeInitialUiState(workspaceRoot: string): Promise<void> {
  const runtimeDir = join(workspaceRoot, ".craig", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "ui-state.json"),
    JSON.stringify({
      version: 1,
      selectedRepoId: null,
      selectedWorkspaceId: null,
      selectedTaskId: "task_20260430_02",
      inputMode: "control",
      focusedRegion: "center",
      activeTab: "terminal",
      selectedActionId: "commit",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }),
  );
}

class PtyOutputBuffer {
  value = "";

  append(chunk: string): void {
    this.value += chunk;
    if (this.value.length > 80_000) {
      this.value = this.value.slice(-80_000);
    }
  }

  async waitFor(needle: string, timeoutMs = 7000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (this.value.includes(needle)) {
        return;
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\n\nLast output:\n${this.value.slice(-5000)}`);
  }

  latestFrame(): string {
    const marker = "CRAIG  |";
    const index = this.value.lastIndexOf(marker);
    return index === -1 ? this.value : this.value.slice(index);
  }

  async waitForLatestFrame(needle: string, timeoutMs = 7000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (this.latestFrame().includes(needle)) {
        return;
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in latest frame.\n\nLatest frame:\n${this.latestFrame().slice(-5000)}`);
  }
}
