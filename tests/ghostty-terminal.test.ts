import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { createGhosttyEmulator } from "../src/ui/ghostty/emulator.js";

const size = { columns: 80, rows: 12 };
describe("Ghostty terminal backend", () => {
  test("renders styles and safe links, retains history, and reads the active screen independently", async () => {
    const terminal = createGhosttyEmulator({ columns: 20, rows: 3 }, { onReply: () => {} });
    try {
      await terminal.write("\x1b[1;38;2;10;20;30mone\x1b[0m\r\n\x1b]8;;https://example.com\x1b\\two\x1b]8;;\x07\r\nthree\r\nfour");
      expect(terminal.getScrollbackLength()).toBe(1);
      const history = terminal.renderRows(1);
      expect(history[0]?.segments[0]).toMatchObject({ text: "one", style: { fg: "0a141e", bold: true } });
      expect(history[1]?.segments[0]).toMatchObject({ text: "two", href: "https://example.com", style: { underline: true } });
      expect(terminal.getActiveScreenText()).toBe("two\nthree\nfour");
      expect(terminal.renderRows(1)).toEqual(history);
      await terminal.write("\x1b[H\x1b[2J\x1b]8;;javascript:alert(1)\x1b\\unsafe\x1b]8;;\x07");
      expect(terminal.renderRows().flatMap((row) => row.segments).some((segment) => segment.href)).toBe(false);
    } finally { terminal.dispose(); }
  });

  test("answers split queries once with actual coordinates and scopes replies to their session", async () => {
    const replies: string[] = [];
    const otherReplies: string[] = [];
    const terminal = createGhosttyEmulator(size, { onReply: (data) => replies.push(data) });
    const other = createGhosttyEmulator(size, { onReply: (data) => otherReplies.push(data) });
    try {
      await terminal.write("\x1b[3;7H\x1b[");
      await terminal.write("6n");
      expect(replies).toEqual(["\x1b[3;7R"]);
      expect(otherReplies).toEqual([]);
      await other.write("\x1b[6n");
      expect(otherReplies).toEqual(["\x1b[1;1R"]);
    } finally { terminal.dispose(); other.dispose(); }
  });

  test("encodes legacy, application-cursor and Kitty keys using native terminal modes", async () => {
    const terminal = createGhosttyEmulator(size, { onReply: () => {} });
    try {
      expect(terminal.encodeKey?.("a")).toBe("a");
      expect(terminal.encodeKey?.("CTRL_C")).toBe("\x03");
      expect(terminal.encodeKey?.("ENTER")).toBe("\r");
      expect(terminal.encodeKey?.("UP")).toBe("\x1b[A");
      await terminal.write("\x1b[?1h");
      expect(terminal.encodeKey?.("UP")).toBe("\x1bOA");
      await terminal.write("\x1b[>31u");
      expect(terminal.encodeKey?.("CTRL_C")).toBe("\x1b[99;5u");
      expect(terminal.encodeKey?.("SHIFT_ENTER")).toBe("\x1b[13;2u");
      expect(terminal.encodeKey?.("UNKNOWN_EVENT")).toBeNull();
    } finally { terminal.dispose(); }
  });

  test("honors cursor visibility, resize and alternate-screen restoration", async () => {
    const terminal = createGhosttyEmulator(size, { onReply: () => {} });
    try {
      await terminal.write("main\x1b[?1049hother\x1b[?1049l\x1b[?25l");
      expect(terminal.getActiveScreenText()).toContain("main");
      expect(terminal.renderRows().flatMap((row) => row.segments).some((segment) => segment.style?.inverse)).toBe(false);
      terminal.resize({ columns: 100, rows: 16 });
      expect(terminal.renderRows()).toHaveLength(16);
      await terminal.write("\x1b[?25h");
      expect(terminal.renderRows().flatMap((row) => row.segments).some((segment) => segment.style?.inverse)).toBe(true);
    } finally { terminal.dispose(); }
  });

  test("replays the real Codex startup trace with bounded styles and text", async () => {
    const fixture = JSON.parse(await readFile(new URL("../scripts/fixtures/codex-startup-replay.json", import.meta.url), "utf8")) as { columns: number; rows: number; chunks: string[] };
    const terminal = createGhosttyEmulator({ columns: fixture.columns, rows: fixture.rows }, { onReply: () => {} });
    try {
      for (const chunk of fixture.chunks) {
        await terminal.write(chunk);
        expect(terminal.renderRows()).toHaveLength(fixture.rows);
      }
      expect(terminal.getActiveScreenText()).toContain("OpenAI Codex");
      expect(terminal.getActiveScreenText()).toContain("Ask Codex");
    } finally { terminal.dispose(); }
  });

  test("serializes queued output and cancels queued writes on disposal", async () => {
    const replies: string[] = [];
    const terminal = createGhosttyEmulator(size, { onReply: (reply) => replies.push(reply) });
    await Promise.all([terminal.write("first"), terminal.write(" second\r\npasted text")]);
    expect(terminal.getActiveScreenText()).toContain("first second\npasted text");
    const pending = terminal.write("\x1b[6n");
    terminal.dispose();
    terminal.dispose();
    await pending;
    expect(replies).toEqual([]);
    expect(terminal.renderRows()).toEqual([]);
    expect(terminal.getActiveScreenText()).toBe("");
  });
});
