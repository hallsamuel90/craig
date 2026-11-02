import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import type * as TerminalKit from "terminal-kit";
import { describe, expect, test, vi } from "vitest";
import { installMouseInputBuffer, MouseInputBuffer } from "../src/ui/input/mouse-input.js";
import type { TerminalRuntime } from "../src/ui/app-context.js";

const { createTerminal } = createRequire(import.meta.url)("terminal-kit") as typeof TerminalKit;

describe("raw mouse input boundary", () => {
  test.each(["\u001b[<0;40;12M", "\u001b[<64;40;12M", "\u001b[M H,"])("reassembles every split of %j before terminal-kit can emit printable payload", (report) => {
    const term = createTerminal({ stdin: new PassThrough(), stdout: new PassThrough(), generic: "xterm", appId: "craig-test", appName: "Craig test", isTTY: false });
    for (let split = 1; split < report.length; split++) {
      const raw = term as unknown as TerminalRuntime & { onStdin: NonNullable<TerminalRuntime["onStdin"]> };
      const original = raw.onStdin;
      const key = vi.fn();
      const mouse = vi.fn();
      const unknown = vi.fn();
      term.on("key", key); term.on("mouse", mouse); term.on("unknown", unknown);
      const input = installMouseInputBuffer(raw);
      try {
        raw.onStdin(Buffer.from(report.slice(0, split)));
        raw.onStdin(Buffer.from(report.slice(split)));
        expect(mouse).toHaveBeenCalledOnce();
        expect(mouse.mock.calls[0]?.[0]).not.toBe("ERROR");
        expect(key).not.toHaveBeenCalled();
        expect(unknown).not.toHaveBeenCalled();
        raw.onStdin(Buffer.from("hello"));
        expect(key.mock.calls.map((call) => call[0]).join("")).toBe("hello");
      } finally {
        input.dispose();
        term.removeAllListeners("key"); term.removeAllListeners("mouse"); term.removeAllListeners("unknown");
        expect(raw.onStdin).toBe(original);
      }
    }
  });

  test("preserves surrounding keyboard bytes, arrows and Shift+Enter while dropping malformed SGR reports", () => {
    const emit = vi.fn();
    const input = new MouseInputBuffer(emit);
    input.write(Buffer.from("before\u001b[<"));
    input.write(Buffer.from("bad;3;4Mafter\u001b[A\u001b[13;2u"));
    expect(Buffer.concat(emit.mock.calls.map((call) => call[0])).toString()).toBe("beforeafter\u001b[A\u001b[13;2u");
    input.reset();
    emit.mockClear();
    input.write(Buffer.from("\u001b[<0;"));
    input.write(Buffer.from("\u0003"));
    expect(Buffer.concat(emit.mock.calls.map((call) => call[0])).toString()).toBe("\u0003");
    input.reset();
  });

  test("flushes a standalone Escape and discards pending bytes on suspend/cleanup", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const input = new MouseInputBuffer(emit);
    try {
      input.write(Buffer.from("\u001b"));
      vi.advanceTimersByTime(31);
      expect(emit).toHaveBeenCalledWith(Buffer.from("\u001b"));
      emit.mockClear();
      input.write(Buffer.from("\u001b[<0;"));
      input.reset();
      vi.runAllTimers();
      expect(emit).not.toHaveBeenCalled();
      input.write(Buffer.from("x"));
      expect(emit).toHaveBeenCalledWith(Buffer.from("x"));
    } finally { input.reset(); vi.useRealTimers(); }
  });
});
