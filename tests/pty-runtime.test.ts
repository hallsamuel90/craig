import { describe, expect, test, vi } from "vitest";

import { isTerminalDetachKey } from "../src/ui/state.js";
import { mapKeyToPtyInput, PtyRuntime } from "../src/ui/pty/runtime.js";
import { createTerminalEmulator, renderTerminalScreenRows, writeTerminalEmulator } from "../src/ui/terminal-emulator.js";

describe("PTY runtime", () => {
  test("maps Craig terminal-mode keys to PTY input and reserves ctrl+]", () => {
    expect(mapKeyToPtyInput("a")).toBe("a");
    expect(mapKeyToPtyInput("ENTER")).toBe("\r");
    expect(mapKeyToPtyInput("SHIFT_ENTER")).toBe("\n");
    expect(mapKeyToPtyInput("BACKSPACE")).toBe("\x7f");
    expect(mapKeyToPtyInput("UP")).toBe("\x1b[A");
    expect(mapKeyToPtyInput("TAB")).toBe("\t");
    expect(mapKeyToPtyInput("SHIFT_TAB")).toBe("\x1b[Z");
    expect(mapKeyToPtyInput("BACK_TAB")).toBe("\x1b[Z");
    expect(mapKeyToPtyInput("CTRL_C")).toBe("\x03");
    expect(isTerminalDetachKey("\u001D")).toBe(true);
  });

  test("emulates SGR color cells instead of storing ANSI text", async () => {
    const terminal = createTerminalEmulator({ columns: 20, rows: 5 });

    await writeTerminalEmulator(terminal, "\u001B[32mhello\u001B[0m");
    const rows = renderTerminalScreenRows(terminal);

    expect(rows[0]?.segments[0]).toEqual({
      text: "hello",
      style: expect.objectContaining({ fg: "0dbc79" }),
    });
  });

  test("emulates clear-screen, cursor movement, carriage return, wrapping, and resize", async () => {
    const terminal = createTerminalEmulator({ columns: 6, rows: 4 });

    await writeTerminalEmulator(terminal, "abcdefg");
    expect(toPlainRows(terminal)).toEqual(["abcdef", "g"]);

    await writeTerminalEmulator(terminal, "\rZ");
    expect(toPlainRows(terminal)[1]).toBe("Z");

    await writeTerminalEmulator(terminal, "\u001B[2;4Hxy");
    expect(toPlainRows(terminal)[1]).toBe("Z  xy");

    await writeTerminalEmulator(terminal, "\u001B[H\u001B[2Jafter");
    expect(toPlainRows(terminal)).toEqual(["after"]);

    terminal.resize(10, 3);
    await writeTerminalEmulator(terminal, "\u001B[3;9H!");
    expect(renderTerminalScreenRows(terminal)[2]?.segments.map((segment) => segment.text).join("").trimEnd()).toBe("        !");
  });

  test("spawns one process-local PTY per mock task and forwards writes into the emulator", async () => {
    const fakePty = createFakePty();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => fakePty),
    });

    const initial = runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 80, rows: 24 });
    runtime.writeKey("a");
    runtime.writeKey("ENTER");
    fakePty.emitData("ok\r\n");
    await vi.waitFor(() => expect(runtime.getViewState("task_20260430_02:terminal").rows[0]?.segments[0]?.text).toContain("ok"));
    const updated = runtime.getViewState("task_20260430_02:terminal");

    expect(initial.status).toBe("running");
    expect(fakePty.writes).toEqual(["a", "\r"]);
    expect(updated.rows[0]?.segments[0]?.text).toContain("ok");
  });

  test("delivers one safely encoded prompt to the requested tab without changing the attached tab", () => {
    const firstPty = createFakePty();
    const secondPty = createFakePty();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn()
        .mockReturnValueOnce(firstPty)
        .mockReturnValueOnce(secondPty),
    });

    runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
    runtime.ensureSession("task_2", "task_2:agent", { columns: 80, rows: 24 });
    runtime.writeToSession("task_1:agent", "\u001b[200~review this\nthen report\u001b[201~\r");
    runtime.write("attached input");

    expect(firstPty.writes).toEqual(["\u001b[200~review this\nthen report\u001b[201~\r"]);
    expect(secondPty.writes).toEqual(["attached input"]);
  });

  test("observes submitted input, output, and process exits as session activity", () => {
    const fakePty = createFakePty();
    const onActivity = vi.fn();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => fakePty),
      onActivity,
    });

    runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
    expect(onActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task_1",
      tabId: "task_1:agent",
      sessionState: "running",
    }));
    onActivity.mockClear();

    runtime.writeKey("a");
    expect(onActivity).not.toHaveBeenCalled();
    runtime.writeKey("ENTER");
    expect(onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ sessionState: "running" }));

    fakePty.emitData("working");
    expect(onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ sessionState: "running" }));

    fakePty.emitExit(7);
    expect(onActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionState: "exited",
      exitCode: 7,
    }));
  });

  test("retains spawn failures as activity until the tab is disposed", () => {
    const onActivity = vi.fn();
    const onActivityRemoved = vi.fn();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      spawn: vi.fn(() => {
        throw new Error("agent executable missing");
      }),
      onActivity,
      onActivityRemoved,
    });

    expect(() => runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 }))
      .toThrow("agent executable missing");
    expect(runtime.getActivitySnapshots()).toEqual([
      expect.objectContaining({ tabId: "task_1:agent", sessionState: "failed" }),
    ]);

    runtime.disposeSession("task_1:agent");
    expect(runtime.getActivitySnapshots()).toEqual([]);
    expect(onActivityRemoved).toHaveBeenCalledWith("task_1:agent");
  });

  test("does not emit or update activity while observation is disabled", () => {
    const fakePty = createFakePty();
    const onActivity = vi.fn();
    const onActivityRemoved = vi.fn();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      spawn: vi.fn(() => fakePty),
      activityEnabled: false,
      onActivity,
      onActivityRemoved,
    });

    runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
    fakePty.emitData("preview disabled");
    expect(runtime.getActivitySnapshots()).toEqual([]);
    expect(onActivity).not.toHaveBeenCalled();

    runtime.setActivityEnabled(true);
    expect(runtime.getActivitySnapshots()).toEqual([
      expect.objectContaining({ tabId: "task_1:agent", sessionState: "running" }),
    ]);
    expect(onActivity).toHaveBeenCalledTimes(1);

    runtime.setActivityEnabled(false);
    const retainedSnapshot = runtime.getActivitySnapshots()[0];
    fakePty.emitData("disabled again");
    expect(runtime.getActivitySnapshots()[0]).toEqual(retainedSnapshot);
    expect(onActivityRemoved).not.toHaveBeenCalled();
  });

  test("reuses a terminal screen snapshot until PTY output changes it", async () => {
    const fakePty = createFakePty();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => fakePty),
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 80, rows: 24 });
    const initialRows = runtime.getViewState("task_20260430_02:terminal").rows;
    expect(runtime.getViewState("task_20260430_02:terminal").rows).toBe(initialRows);

    fakePty.emitData("updated\r\n");
    await vi.waitFor(() => expect(runtime.getViewState("task_20260430_02:terminal").rows).not.toBe(initialRows));
  });

  test("answers core terminal capability probes so runner CLIs can finish bootstrapping", () => {
    const fakePty = createFakePty();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => fakePty),
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:agent", { columns: 80, rows: 24 });
    fakePty.emitData("\u001B[6n\u001B[c\u001B[?u\u001B]10;?\u001B\\\u001B]11;?\u001B\\");

    expect(fakePty.writes).toEqual([
      "\u001B[1;1R",
      "\u001B[?1;2c",
      "\u001B[?0u",
    ]);
  });

  test("does not inject OSC color responses into interactive tabs", () => {
    const agentPty = createFakePty();
    const terminalPty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(agentPty)
      .mockReturnValueOnce(terminalPty);
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn,
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:agent", { columns: 80, rows: 24 });
    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 80, rows: 24 });
    agentPty.emitData("\u001B]10;?\u001B\\\u001B]11;?\u001B\\");
    terminalPty.emitData("\u001B]10;?\u001B\\\u001B]11;?\u001B\\");

    expect(agentPty.writes).toEqual([]);
    expect(terminalPty.writes).toEqual([]);
  });

  test("restarts an exited PTY session when the task is reattached", async () => {
    const firstPty = createFakePty();
    const secondPty = createFakePty();
    const spawn = vi.fn()
      .mockReturnValueOnce(firstPty)
      .mockReturnValueOnce(secondPty);
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn,
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 80, rows: 24 });
    firstPty.emitExit(0);
    await vi.waitFor(() => expect(runtime.getViewState("task_20260430_02:terminal").status).toBe("exited"));

    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 90, rows: 30 });
    runtime.writeKey("b");

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(firstPty.kill).toHaveBeenCalledTimes(1);
    expect(secondPty.writes).toEqual(["b"]);
    expect(runtime.getViewState("task_20260430_02:terminal").status).toBe("running");
  });

  test("spawns the PTY inside the selected task worktree when the session spec resolves one", async () => {
    const worktreePath = "/tmp/craig/task-worktree";
    const spawn = vi.fn(() => createFakePty());
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn,
      resolveSessionSpec: () => ({
        cwd: worktreePath,
        command: [],
      }),
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 80, rows: 24 });

    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      [],
      expect.objectContaining({
        cwd: worktreePath,
      }),
    );
  });

  test("passes session env overrides into spawned PTYs", async () => {
    const spawn = vi.fn(() => createFakePty());
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color", GIT_CEILING_DIRECTORIES: "/tmp/existing" },
      spawn,
      resolveSessionSpec: () => ({
        cwd: "/tmp/craig/task-bundle",
        command: [],
        env: { GIT_CEILING_DIRECTORIES: "/tmp/existing:/tmp/craig/task-bundle" },
      }),
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 80, rows: 24 });

    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CEILING_DIRECTORIES: "/tmp/existing:/tmp/craig/task-bundle",
        }),
      }),
    );
  });

  test("boots command tabs through the shell so they fall back to the same terminal", () => {
    const spawn = vi.fn(() => createFakePty());
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn,
      resolveSessionSpec: () => ({
        cwd: "/tmp/craig/task-worktree",
        command: ["/bin/echo", "ready"],
      }),
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:agent", { columns: 80, rows: 24 });

    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lc", "'/bin/echo' 'ready'; exec '/bin/zsh' -l"],
      expect.objectContaining({
        cwd: "/tmp/craig/task-worktree",
      }),
    );
  });

  test("scrolls the attached terminal viewport through scrollback", async () => {
    const fakePty = createFakePty();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => fakePty),
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 12, rows: 4 });
    fakePty.emitData("line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6\r\n");
    await vi.waitFor(() => expect(runtime.getViewState("task_20260430_02:terminal").rows.some((row) => row.segments.some((segment) => segment.text.includes("line6")))).toBe(true));

    runtime.scrollViewport(-2);
    const scrolled = runtime.getViewState("task_20260430_02:terminal").rows.map((row) => row.segments.map((segment) => segment.text).join(""));

    expect(scrolled.join("\n")).toContain("line3");
    expect(scrolled.join("\n")).toContain("line4");
  });

  test("sessionTabIds returns ids of all open sessions and excludes disposed ones", async () => {
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => createFakePty()),
    });

    expect(runtime.sessionTabIds()).toEqual([]);

    runtime.ensureSession("task_1", "task_1:agent", { columns: 80, rows: 24 });
    runtime.ensureSession("task_1", "task_1:terminal", { columns: 80, rows: 24 });
    expect(runtime.sessionTabIds()).toEqual(expect.arrayContaining(["task_1:agent", "task_1:terminal"]));
    expect(runtime.sessionTabIds()).toHaveLength(2);

    runtime.disposeSession("task_1:agent");
    expect(runtime.sessionTabIds()).toEqual(["task_1:terminal"]);

    runtime.disposeAll();
    expect(runtime.sessionTabIds()).toEqual([]);
  });

  test("scrolling the viewport does not emit a runtime update by itself", async () => {
    const fakePty = createFakePty();
    const onUpdate = vi.fn();
    const runtime = new PtyRuntime({
      workspaceRoot: "/tmp/craig",
      shell: "/bin/zsh",
      env: { TERM: "xterm-256color" },
      spawn: vi.fn(() => fakePty),
      onUpdate,
    });

    runtime.ensureSession("task_20260430_02", "task_20260430_02:terminal", { columns: 12, rows: 4 });
    onUpdate.mockClear();
    runtime.scrollViewport(-2);

    expect(onUpdate).not.toHaveBeenCalled();
  });
});

function toPlainRows(terminal: ReturnType<typeof createTerminalEmulator>): string[] {
  return renderTerminalScreenRows(terminal)
    .map((row) => row.segments.map((segment) => segment.text).join("").trimEnd())
    .filter((row) => row.length > 0);
}

function createFakePty() {
  /* eslint-disable no-unused-vars */
  const dataListeners: Array<(...args: [string]) => void> = [];
  const exitListeners: Array<(...args: [{ exitCode: number }]) => void> = [];
  /* eslint-enable no-unused-vars */

  return {
    pid: 123,
    cols: 80,
    rows: 24,
    process: "zsh",
    handleFlowControl: false,
    writes: [] as Array<string | Buffer>,
    /* eslint-disable no-unused-vars */
    onData(listener: (...args: [string]) => void) {
      dataListeners.push(listener);
      return { dispose: vi.fn() };
    },
    onExit(listener: (...args: [{ exitCode: number }]) => void) {
      exitListeners.push(listener);
      return { dispose: vi.fn() };
    },
    /* eslint-enable no-unused-vars */
    on: vi.fn(),
    resize(columns: number, rows: number) {
      this.cols = columns;
      this.rows = rows;
    },
    clear: vi.fn(),
    write(input: string | Buffer) {
      this.writes.push(input);
    },
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData(chunk: string) {
      for (const listener of dataListeners) {
        listener(chunk);
      }
    },
    emitExit(exitCode: number) {
      for (const listener of exitListeners) {
        listener({ exitCode });
      }
    },
  };
}
