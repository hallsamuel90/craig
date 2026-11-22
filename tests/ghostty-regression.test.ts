import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, test, vi } from "vitest";

import type { TerminalEmulator, TerminalSize } from "../src/ui/terminal-emulator.js";
import { createGhosttyEmulator, getGhosttyRuntimeStats } from "../src/ui/ghostty/emulator.js";
import { createXtermEmulator } from "../src/ui/terminal-xterm.js";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
type Operation = { kind: "write"; text: string } | { kind: "resize"; size: TerminalSize };
async function apply(terminal: TerminalEmulator, operation: Operation): Promise<void> {
  if (operation.kind === "write") await terminal.write(operation.text);
  else terminal.resize(operation.size);
}

describe("terminal regression corpus", () => {
  test("the default xterm path does not initialize or change Ghostty state", async () => {
    const before = getGhosttyRuntimeStats();
    const terminal = createXtermEmulator({ columns: 80, rows: 24 }, { onReply: () => {} });
    try { await terminal.write("default backend"); terminal.renderRows(); }
    finally { terminal.dispose(); }
    expect(getGhosttyRuntimeStats()).toEqual(before);
  });

  test.each([1, 7, 42, 310, 20261122])("seed %i: cached frames match fresh full replay after output, scroll, resize and screen switches", async (seed) => {
    const rand = random(seed);
    const initial = { columns: 40, rows: 8 };
    const cached = createGhosttyEmulator(initial, { onReply: () => {} });
    const operations: Operation[] = [];
    const corpus = [
      "\r\nline 界 e\u0301 👩‍💻\r\n", "\x1b[1;3H\x1b[1;32mchanged\x1b[0m", "\x1b[2;5r\x1b[2S\x1b[r",
      "\x1b[?1049h\x1b[Halternate", "\x1b[?1049l", "\x1b[H\x1b[2Jcleared", "\x1b[?25l", "\x1b[?25h",
      "\x1b]8;;https://example.com/preview\x1b\\link\x1b]8;;\x07", "\x1b[48;2;1;2;3m\x1b[2K\x1b[0m",
      "\x1b]4;2;rgb:11/22/33\x07", "\x1b[38;5;201mcolored\x1b[0m", "\x1b]8;;javascript:bad\x1b\\unsafe\x1b]8;;\x07",
    ];
    let current = initial;
    try {
      for (let step = 0; step < 64; step++) {
        const operation: Operation = rand() < 0.15
          ? { kind: "resize", size: { columns: 24 + Math.floor(rand() * 60), rows: 6 + Math.floor(rand() * 12) } }
          : { kind: "write", text: corpus[Math.floor(rand() * corpus.length)]! };
        operations.push(operation);
        await apply(cached, operation);
        if (operation.kind === "resize") current = operation.size;
        const lines = Math.floor(rand() * 4);
        cached.renderRows(lines);
        const fresh = createGhosttyEmulator(initial, { onReply: () => {} });
        try {
          for (const op of operations) await apply(fresh, op);
          expect(cached.renderRows(lines), `seed=${seed} step=${step}`).toEqual(fresh.renderRows(lines));
          expect(cached.renderRows(lines)).toHaveLength(current.rows);
          expect(cached.getActiveScreenText()).toBe(fresh.getActiveScreenText());
        } finally { fresh.dispose(); }
      }
    } finally { cached.dispose(); }
  });

  test.each([11, 29, 73])("seed %i: portable styled corpus agrees with xterm under fragmented delivery", async (seed) => {
    const rand = random(seed);
    const size = { columns: 80, rows: 16 };
    const ghostty = createGhosttyEmulator(size, { onReply: () => {} });
    const xterm = createXtermEmulator(size, { onReply: () => {} });
    try {
      for (let step = 0; step < 60; step++) {
        const y = 1 + Math.floor(rand() * 14);
        const x = 1 + Math.floor(rand() * 30);
        const color = 30 + Math.floor(rand() * 8);
        // Erase the target row first: clearing half an existing wide cell has
        // different native blank-attribute policies (covered explicitly below).
        const output = `\x1b[${y};1H\x1b[2K\x1b[${y};${x}H\x1b[${color};${step % 2 ? "1" : "3"}mline-${step} 界 e\u0301\x1b[0m`;
        const split = 1 + Math.floor(rand() * (output.length - 1));
        await Promise.all([ghostty.write(output.slice(0, split)), ghostty.write(output.slice(split))]);
        await xterm.write(output);
        expect(ghostty.renderRows(), `seed=${seed} step=${step}`).toEqual(xterm.renderRows());
      }
    } finally { ghostty.dispose(); xterm.dispose(); }
  });

  test("records the native wide-cell overwrite difference without hiding styled-frame mismatches", async () => {
    const ghostty = createGhosttyEmulator({ columns: 12, rows: 3 }, { onReply: () => {} });
    const fresh = createGhosttyEmulator({ columns: 12, rows: 3 }, { onReply: () => {} });
    const xterm = createXtermEmulator({ columns: 12, rows: 3 }, { onReply: () => {} });
    try {
      const prefix = "\x1b[35;1m界\x1b[0m";
      const overwrite = "\x1b[1;2H\x1b[32;3mX\x1b[0m";
      await ghostty.write(prefix); ghostty.renderRows(); await ghostty.write(overwrite);
      await fresh.write(prefix + overwrite); await xterm.write(prefix + overwrite);
      expect(ghostty.renderRows()).toEqual(fresh.renderRows());
      expect(ghostty.renderRows()[0]?.segments.slice(0, 2)).toEqual([
        { text: " ", style: {} }, { text: "X", style: { fg: "0dbc79", italic: true } },
      ]);
      expect(xterm.renderRows()[0]?.segments[0]).toEqual({ text: " X", style: { fg: "0dbc79", italic: true } });
    } finally { ghostty.dispose(); fresh.dispose(); xterm.dispose(); }
  });

  test("large output yields, survives resize during parsing, and stops replying after disposal", async () => {
    const replies: string[] = [];
    const terminal = createGhosttyEmulator({ columns: 80, rows: 24 }, { onReply: (data) => replies.push(data) });
    const healthy = createGhosttyEmulator({ columns: 80, rows: 24 }, { onReply: () => {} });
    // Exercise the budget branch deterministically, independent of CPU speed.
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => { clock += 5; return clock; });
    try {
      let finished = false;
      const writing = terminal.write("progress\r\n".repeat(100000) + "\x1b[6n").then(() => { finished = true; });
      await nextTurn();
      expect(finished).toBe(false);
      terminal.resize({ columns: 100, rows: 30 });
      expect(terminal.renderRows()).toHaveLength(30);
      terminal.dispose();
      await writing;
      expect(replies).toEqual([]);
      await healthy.write("still healthy");
      expect(healthy.getActiveScreenText()).toContain("still healthy");
    } finally { now.mockRestore(); terminal.dispose(); healthy.dispose(); }
  });

  test("disposal inside a reply callback stops subsequent queued replies", async () => {
    const replies: string[] = [];
    const terminal = createGhosttyEmulator({ columns: 80, rows: 24 }, { onReply: (reply) => {
      replies.push(reply);
      terminal.dispose();
    } });
    try {
      await terminal.write("\x1b[6n\x1b[6n");
      expect(replies).toEqual(["\x1b[1;1R"]);
    } finally { terminal.dispose(); }
  });

  test("native allocations reach a plateau across repeated parallel session churn", async () => {
    const baseline = getGhosttyRuntimeStats().activeSessions;
    const highs: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      const terminals = Array.from({ length: 12 }, () => createGhosttyEmulator({ columns: 120, rows: 40 }, { onReply: () => {} }));
      try {
        await Promise.all(terminals.map(async (terminal, index) => {
          await terminal.write(`\x1b[32msession-${index}\x1b[0m\r\n`.repeat(10000));
          terminal.renderRows();
        }));
        expect(getGhosttyRuntimeStats().activeSessions).toBe(baseline + 12);
        highs.push(getGhosttyRuntimeStats().memoryBytes);
      } finally { terminals.forEach((terminal) => terminal.dispose()); }
      expect(getGhosttyRuntimeStats().activeSessions).toBe(baseline);
    }
    // Allow one extra 64 KiB page after warm-up; never assert that free()
    // shrinks shared linear memory or equate this with a process-RSS proof.
    expect(highs.at(-1)! - Math.max(...highs.slice(1, 4))).toBeLessThanOrEqual(65536);
  }, 30000);
});
