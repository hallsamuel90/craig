import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startTerminalApp, type PtyRuntimePort, type TerminalRuntime } from "../src/ui/app.js";
import type { MockTaskId, TerminalViewState } from "../src/ui/state.js";

/* eslint-disable no-unused-vars */
type KeyListener = (...args: [unknown]) => void;
/* eslint-enable no-unused-vars */

describe("terminal app PTY attach flow", () => {
  const tempRoots: string[] = [];
  let stdinDescriptor: PropertyDescriptor | undefined;
  let stdoutDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  });

  afterEach(async () => {
    restoreProperty(process.stdin, "isTTY", stdinDescriptor);
    restoreProperty(process.stdout, "isTTY", stdoutDescriptor);
    await Promise.all(
      tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })),
    );
  });

  test.each(["ENTER", "CTRL_M", "RETURN"])(
    "%s on the focused terminal center pane attaches and forwards later keys to the PTY",
    async (enterKey) => {
      const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
      tempRoots.push(root);
      const uiStateFile = join(root, "ui-state.json");
      await writeFile(
        uiStateFile,
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
      const terminal = new FakeTerminal();
      const ptyRuntime = new FakePtyRuntime();
      const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile, workspaceRoot: root });
      await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

      terminal.emitKey(enterKey);
      terminal.emitKey(enterKey);
      terminal.emitKey("p");
      terminal.emitKey("\u001D");
      terminal.emitKey("q");

      await expect(app).resolves.toBe(0);
      expect(ptyRuntime.ensureSession).toHaveBeenCalledWith("task_20260430_02", expect.objectContaining({ columns: expect.any(Number) }));
      expect(ptyRuntime.writeKey).toHaveBeenCalledWith("p");
      expect(ptyRuntime.detach).toHaveBeenCalledTimes(1);
      expect(ptyRuntime.disposeAll).toHaveBeenCalledTimes(1);
      expect(terminal.frames.join("\n")).toContain("terminal ▸ terminal mode · Ctrl+] detach");
    },
  );

  test("raw terminal-kit unknown ctrl+] detaches from terminal mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-ui-app-"));
    tempRoots.push(root);
    const uiStateFile = join(root, "ui-state.json");
    await writeFile(
      uiStateFile,
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
    const terminal = new FakeTerminal();
    const ptyRuntime = new FakePtyRuntime();
    const app = startTerminalApp({ terminal, ptyRuntime, uiStateFile, workspaceRoot: root });
    await vi.waitFor(() => expect(terminal.hasKeyListener()).toBe(true));

    terminal.emitKey("ENTER");
    terminal.emitKey("ENTER");
    terminal.emitUnknown("\u001D");
    terminal.emitKey("q");

    await expect(app).resolves.toBe(0);
    expect(ptyRuntime.detach).toHaveBeenCalledTimes(1);
    expect(terminal.frames.join("\n")).toContain("terminal ▸ control mode · Enter reattach");
  });
});

class FakeTerminal implements TerminalRuntime {
  width = 120;
  height = 36;
  frames: string[] = [];
  private keyListener: KeyListener | null = null;
  private unknownListener: KeyListener | null = null;

  moveTo = vi.fn();
  eraseDisplayBelow = vi.fn();
  grabInput = vi.fn();
  hideCursor = vi.fn();
  fullscreen = vi.fn();

  noFormat(input: string): void {
    this.frames.push(input);
  }

  on(event: "key" | "unknown", listener: KeyListener): void {
    if (event === "key") {
      this.keyListener = listener;
    }
    if (event === "unknown") {
      this.unknownListener = listener;
    }
  }

  removeListener(event: "key" | "unknown", listener: KeyListener): void {
    if (event === "key" && this.keyListener === listener) {
      this.keyListener = null;
    }
    if (event === "unknown" && this.unknownListener === listener) {
      this.unknownListener = null;
    }
  }

  emitKey(key: string): void {
    this.keyListener?.(key);
  }

  emitUnknown(input: string): void {
    this.unknownListener?.(Buffer.from(input));
  }

  hasKeyListener(): boolean {
    return this.keyListener !== null;
  }
}

class FakePtyRuntime implements PtyRuntimePort {
  ensureSession = vi.fn((taskId: MockTaskId): TerminalViewState => this.getRunningView(taskId));
  write = vi.fn();
  writeKey = vi.fn();
  resize = vi.fn();
  detach = vi.fn();
  disposeAll = vi.fn();

  getViewState(taskId: MockTaskId): TerminalViewState {
    if (this.ensureSession.mock.calls.some(([attachedTaskId]) => attachedTaskId === taskId)) {
      return this.getRunningView(taskId);
    }

    return {
      status: "idle",
      rows: [],
      error: null,
    };
  }

  private getRunningView(taskId: MockTaskId): TerminalViewState {
    return {
      status: "running",
      rows: [{ segments: [{ text: `${taskId} $` }] }],
      error: null,
    };
  }
}

function restoreProperty(target: object, key: "isTTY", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }

  Reflect.deleteProperty(target, key);
}
