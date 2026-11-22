// Investigation for #310. Run with: pnpm exec tsx scripts/libghostty-spike.mjs
// Downloads only the pinned, checksummed upstream Wasm to the OS temp directory.
// This module is deliberately outside the shipped CLI and has no runtime switch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Xterm from "@xterm/headless";
import { createTerminalEmulator, renderTerminalScreenRows, writeTerminalEmulator } from "../src/ui/terminal-xterm.ts";
import { createGhosttyFrameReader } from "./libghostty-frame-reader.mjs";

const VERSION = "1.0.0";
const SHA256 = "7b428fee6d0677bc81279458f8f9a3335454834123a9ff47efb3fd177f6da5a8";
const url = `https://release.files.ghostty.org/libghostty-vt/${VERSION}/ghostty-vt-${VERSION}.wasm`;
const cache = join(tmpdir(), "craig-libghostty-spike", `ghostty-vt-${VERSION}.wasm`);
await mkdir(join(tmpdir(), "craig-libghostty-spike"), { recursive: true });
let binary;
try {
  binary = await readFile(cache);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  binary = Buffer.from(await response.arrayBuffer());
}
assert.equal(createHash("sha256").update(binary).digest("hex"), SHA256);
await writeFile(cache, binary);
const start = performance.now();
const { instance } = await WebAssembly.instantiate(binary);
const e = instance.exports;
const startupMs = performance.now() - start;
const bytes = () => new Uint8Array(e.memory.buffer);
const view = () => new DataView(e.memory.buffer);
const decoder = new TextDecoder();
const jsonPtr = e.ghostty_type_json();
const layout = JSON.parse(decoder.decode(bytes().subarray(jsonPtr, bytes().indexOf(0, jsonPtr))));
assert.equal(layout.library_version, VERSION);
assert.equal(layout.abi.pointer_size, 4);
assert.equal(layout.abi.endian, "little");
const types = layout.types;
const values = (name) => types[name].values;
const offset = (type, field) => types[type].fields[field].offset;
const check = (result) => assert.equal(result, values("GhosttyResult").SUCCESS);
const allocations = [];
function alloc(size) {
  const ptr = e.ghostty_wasm_alloc(size);
  assert.ok(ptr, "Wasm allocation failed");
  allocations.push([ptr, size]);
  return ptr;
}
const slot = alloc(4);
const scratch = alloc(1024);
function handle(create, ...args) {
  check(create(0, slot, ...args));
  return e.ghostty_wasm_take_opaque(slot);
}

// A tiny Wasm module imports a JS callback and re-exports it as a Wasm function,
// which V8 accepts in the upstream indirect function table. Signature:
// (terminal: i32, userdata: i32, bytes: i32, length: i32) -> void.
// No experimental WebAssembly.Function, native FFI, compiler or npm binding.
const replies = new Map();
const callbackModule = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 8, 1, 96, 4, 127, 127, 127, 127, 0,
  2, 13, 1, 3, 101, 110, 118, 5, 114, 101, 112, 108, 121, 0, 0,
  7, 9, 1, 5, 114, 101, 112, 108, 121, 0, 0,
]);
const callback = await WebAssembly.instantiate(callbackModule, {
  env: { reply: (terminal, _userdata, ptr, len) => {
    // Copy synchronously: upstream owns this data only during the callback.
    replies.get(terminal)?.push(decoder.decode(bytes().subarray(ptr, ptr + len)));
  } },
});
const callbackIndex = e.__indirect_function_table.grow(1);
e.__indirect_function_table.set(callbackIndex, callback.instance.exports.reply);

class Ghostty {
  constructor(cols = 20, rows = 6, reference = false) {
    this.reference = reference;
    this.cols = cols;
    this.rows = rows;
    this.terminal = handle(e.ghostty_terminal_new, cols, rows);
    replies.set(this.terminal, []);
    check(e.ghostty_terminal_set(this.terminal, values("GhosttyTerminalOption").WRITE_PTY, callbackIndex));
    view().setUint32(scratch, 1000, true);
    check(e.ghostty_terminal_set(this.terminal, values("GhosttyTerminalOption").SCROLLBACK_MAX_LINES, scratch));
    // Match Craig's fixed xterm palette for apples-to-apples styled snapshots.
    const ansi = ["000000", "cd3131", "0dbc79", "e5e510", "2472c8", "bc3fbc", "11a8cd", "e5e5e5", "666666", "f14c4c", "23d18b", "f5f543", "3b8eea", "d670d6", "29b8db", "ffffff"];
    for (let i = 0; i < 256; i++) {
      let channels;
      if (i < 16) channels = ansi[i].match(/../g).map((part) => Number.parseInt(part, 16));
      else if (i < 232) channels = [Math.floor((i - 16) / 36), Math.floor(((i - 16) % 36) / 6), (i - 16) % 6].map((n) => n ? 55 + n * 40 : 0);
      else channels = Array(3).fill(8 + (i - 232) * 10);
      bytes().set(channels, scratch + i * 3);
    }
    check(e.ghostty_terminal_set(this.terminal, values("GhosttyTerminalOption").COLOR_PALETTE, scratch));
    this.render = handle(e.ghostty_render_state_new);
    this.iterator = handle(e.ghostty_render_state_row_iterator_new);
    this.cells = handle(e.ghostty_render_state_row_cells_new);
    this.input = alloc(65536);
  }
  write(input) {
    const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
    for (let i = 0; i < data.length; i += 65536) {
      const part = data.subarray(i, i + 65536);
      bytes().set(part, this.input);
      e.ghostty_terminal_vt_write(this.terminal, this.input, part.length);
    }
  }
  get(key) {
    bytes().fill(0, scratch, scratch + 8);
    check(e.ghostty_terminal_get(this.terminal, values("GhosttyTerminalData")[key], scratch));
    return view().getUint32(scratch, true);
  }
  memoryUsage() {
    const type = types.GhosttyTerminalMemoryUsage;
    assert.ok(type.size <= 1024);
    bytes().fill(0, scratch, scratch + type.size);
    view().setUint32(scratch, type.size, true);
    check(e.ghostty_terminal_get(this.terminal, values("GhosttyTerminalData").MEMORY_USAGE, scratch));
    return Object.fromEntries(["primary_resident_bytes", "alternate_resident_bytes"].map((field) => [field, Number(view().getBigUint64(scratch + type.fields[field].offset, true))]));
  }
  resize(cols, rows) {
    check(e.ghostty_terminal_resize(this.terminal, cols, rows, 0, 0));
    this.cols = cols;
    this.rows = rows;
  }
  styledRows(forceFull = false) {
    this.frameReader ??= createGhosttyFrameReader(e, types, this.terminal, { reference: this.reference });
    return this.frameReader.renderRows({ forceFull });
  }
  scroll(scrollbackLines) {
    bytes().fill(0, scratch, scratch + types.GhosttyTerminalScrollViewport.size);
    view().setInt32(scratch, values("GhosttyTerminalScrollViewportTag").BOTTOM, true);
    check(e.ghostty_terminal_scroll_viewport(this.terminal, scratch));
    if (scrollbackLines) {
      view().setInt32(scratch, values("GhosttyTerminalScrollViewportTag").DELTA, true);
      view().setInt32(scratch + offset("GhosttyTerminalScrollViewport", "value"), -scrollbackLines, true);
      check(e.ghostty_terminal_scroll_viewport(this.terminal, scratch));
    }
  }
  // Render API for frames. Grid references below are only for targeted link/style probes.
  screen() {
    check(e.ghostty_render_state_update(this.render, this.terminal));
    view().setUint32(scratch, this.iterator, true);
    check(e.ghostty_render_state_get(this.render, values("GhosttyRenderStateData").ROW_ITERATOR, scratch));
    const rows = [];
    while (e.ghostty_render_state_row_iterator_next(this.iterator)) {
      view().setUint32(scratch, this.cells, true);
      check(e.ghostty_render_state_row_get(this.iterator, values("GhosttyRenderStateRowData").CELLS, scratch));
      let line = "";
      while (e.ghostty_render_state_row_cells_next(this.cells)) {
        check(e.ghostty_render_state_row_cells_get(this.cells, values("GhosttyRenderStateRowCellsData").RAW, scratch));
        check(e.ghostty_cell_get(view().getBigUint64(scratch, true), values("GhosttyCellData").WIDE, scratch + 8));
        const wide = view().getInt32(scratch + 8, true);
        if (wide === values("GhosttyCellWide").SPACER_TAIL || wide === values("GhosttyCellWide").SPACER_HEAD) continue;
        const buffer = scratch + 32;
        view().setUint32(buffer + offset("GhosttyBuffer", "ptr"), scratch + 128, true);
        view().setUint32(buffer + offset("GhosttyBuffer", "cap"), 896, true);
        check(e.ghostty_render_state_row_cells_get(this.cells, values("GhosttyRenderStateRowCellsData").GRAPHEMES_UTF8, buffer));
        const len = view().getUint32(buffer + offset("GhosttyBuffer", "len"), true);
        line += len ? decoder.decode(bytes().subarray(scratch + 128, scratch + 128 + len)) : " ";
      }
      rows.push(line.trimEnd());
    }
    return rows;
  }
  probe(x, y, tag = "ACTIVE") {
    const point = scratch;
    bytes().fill(0, point, point + types.GhosttyPoint.size);
    view().setInt32(point + offset("GhosttyPoint", "tag"), values("GhosttyPointTag")[tag], true);
    const coordinate = point + offset("GhosttyPoint", "value");
    view().setUint16(coordinate + offset("GhosttyPointCoordinate", "x"), x, true);
    view().setUint32(coordinate + offset("GhosttyPointCoordinate", "y"), y, true);
    const ref = scratch + 64;
    check(e.ghostty_terminal_grid_ref(this.terminal, point, ref));
    check(e.ghostty_grid_ref_style(ref, scratch + 96));
    const style = Array.from(bytes().subarray(scratch + 96, scratch + 96 + types.GhosttyStyle.size));
    const result = e.ghostty_grid_ref_hyperlink_uri(ref, scratch + 128, 896, scratch + 80);
    check(result);
    const len = view().getUint32(scratch + 80, true);
    return { style, href: decoder.decode(bytes().subarray(scratch + 128, scratch + 128 + len)) };
  }
  dispose() {
    replies.delete(this.terminal);
    this.frameReader?.dispose();
    e.ghostty_render_state_row_cells_free(this.cells);
    e.ghostty_render_state_row_iterator_free(this.iterator);
    e.ghostty_render_state_free(this.render);
    e.ghostty_terminal_free(this.terminal);
    const index = allocations.findIndex(([ptr]) => ptr === this.input);
    const [ptr, size] = allocations.splice(index, 1)[0];
    e.ghostty_wasm_free(ptr, size);
  }
}

const results = [];
const differences = [];
async function test(name, run) {
  await run();
  results.push(name);
}
const plain = (term) => Array.from({ length: term.rows }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? "");
await test("screen parity: cursor, erase, SGR, wrap, alternate screen, Unicode, resize", async () => {
  const g = new Ghostty();
  const x = createTerminalEmulator({ columns: 20, rows: 6 });
  try {
    for (const text of ["hello\r\nworld", "\x1b[2;3H\x1b[32mXY\x1b[0m", "\x1b[H\x1b[2J界 e\u0301", "\x1b[?1049hALT", "\x1b[?1049l", "\x1b[H\x1b[2Jabcdefghijklmnopqrstuvwxyz"]) {
      g.write(text);
      await writeTerminalEmulator(x, text);
      assert.deepEqual(g.screen(), plain(x));
      assert.equal(g.get("CURSOR_X"), x.buffer.active.cursorX);
      assert.equal(g.get("CURSOR_Y"), x.buffer.active.cursorY);
    }
    g.resize(12, 6);
    x.resize(12, 6);
    assert.equal(g.screen().join(""), "abcdefghijklmnopqrstuvwxyz");
    differences.push({ name: "shrink wrapped text from 20 to 12 columns at cursor row", ghostty: g.screen(), craig: plain(x) });
  } finally { g.dispose(); x.dispose(); }
});
await test("fragmented UTF-8 and control sequences match whole writes", () => {
  const g = new Ghostty();
  const whole = new Ghostty();
  try {
    const data = new TextEncoder().encode("界 e\u0301\x1b[32mgreen\x1b[0m\r\n\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07");
    for (const byte of data) g.write(Uint8Array.of(byte));
    whole.write(data);
    assert.deepEqual(g.screen(), whole.screen());
    assert.deepEqual(g.probe(0, 1), whole.probe(0, 1));
  } finally { g.dispose(); whole.dispose(); }
});
await test("public style and OSC 8 APIs, link overwrite and history", () => {
  const g = new Ghostty();
  try {
    g.write("\x1b[1;38;2;10;20;30m\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07\x1b[0m");
    const cell = g.probe(0, 0);
    assert.equal(cell.href, "https://example.com");
    assert.equal(cell.style[offset("GhosttyStyle", "fg_color")], values("GhosttyStyleColorTag").RGB);
    assert.deepEqual(cell.style.slice(1, 4), [10, 20, 30]);
    assert.ok(cell.style[offset("GhosttyStyle", "flags")] & 1);
    g.write("\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6");
    assert.equal(g.probe(0, 0, "HISTORY").href, "https://example.com");
    g.write("\x1b[H\x1b[2Jplain");
    assert.equal(g.probe(0, 0).href, "");
  } finally { g.dispose(); }
});
await test("terminal query replies use actual cursor and survive chunk boundaries", () => {
  const g = new Ghostty();
  try {
    g.write("\x1b[3;7H\x1b[");
    g.write("6n");
    assert.deepEqual(replies.get(g.terminal), ["\x1b[3;7R"]);
    g.write("\x1b[c\x1b[?u");
    assert.equal(replies.get(g.terminal).length, 3);
  } finally { g.dispose(); }
});
const skipPty = process.argv.includes("--skip-pty");
if (!skipPty) await test("real node-pty child: cwd, resize, query reply and clean exit", async () => {
  const { spawn } = await import("node-pty");
  const g = new Ghostty(80, 8);
  const cwd = await realpath(tmpdir());
  let child;
  try {
    child = spawn(process.execPath, ["-e", `
      require('node:assert/strict').equal(process.cwd(), ${JSON.stringify(cwd)});
      require('node:assert/strict').equal(process.stdout.columns, 90);
      require('node:assert/strict').equal(process.stdout.rows, 10);
      process.stdin.setRawMode(true);
      process.stdin.once('data', data => {
        if (data.toString() !== '\\x1b[3;7R') process.exit(2);
        process.stdout.write('\\r\\nPTY_REPLY_OK', () => process.exit(0));
      });
      process.stdout.write('\\x1b[3;7H\\x1b[6n');
    `], { cwd, cols: 80, rows: 8, env: { ...process.env, TERM: "xterm-256color" } });
    child.resize(90, 10);
    g.resize(90, 10);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PTY reply timed out")), 5000);
      child.onData((chunk) => {
        try {
          g.write(chunk);
          for (const reply of replies.get(g.terminal).splice(0)) child.write(reply);
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode !== 0) reject(new Error(`PTY child exited ${exitCode}`));
        else resolve();
      });
    });
    assert.ok(g.screen().some((row) => row.includes("PTY_REPLY_OK")));
  } finally { child?.kill(); g.dispose(); }
});

// Record policy differences instead of asserting that emulator defaults agree.
const scrolling = [];
for (const [name, suffix] of [["full screen", "\x1b[2S"], ["Codex protected composer", "\x1b[1;5r\x1b[2S"], ["interior region", "\x1b[2;5r\x1b[2S"], ["alternate screen", "\x1b[?1049h\x1b[2S"]]) {
  const g = new Ghostty();
  const x = createTerminalEmulator({ columns: 20, rows: 6 });
  try {
    const data = `one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nprompt${suffix}`;
    g.write(data);
    await writeTerminalEmulator(x, data);
    assert.deepEqual(g.screen(), plain(x));
    scrolling.push({ name, ghosttyHistory: g.get("SCROLLBACK_ROWS"), craigHistory: x.buffer.active.baseY });
  } finally { g.dispose(); x.dispose(); }
}

await test("optimized styled rows match independent C getters and Craig's renderer", async () => {
  const g = new Ghostty(80, 12);
  const reference = new Ghostty(80, 12, true);
  const x = createTerminalEmulator({ columns: 80, rows: 12 });
  const chunks = [
    "plain text\r\n\x1b[1;2;3;4;7;31;44mbold dim italic underline inverse\x1b[0m",
    "\r\n\x1b[38;2;10;20;30;48;2;40;50;60mRGB\x1b[0m\x1b[38;5;200;48;5;235mpalette\x1b[0m",
    "\r\n界 e\u0301\r\n\x1b]8;;https://example.com/preview\x1b\\Open preview\x1b]8;;\x07 plain",
    "\x1b[2;10Hoverwrite\x1b[4;2H\x1b[42m\x1b[2K\x1b[0m",
    "\x1b[?1049h\x1b[Halternate\x1b[2;4H\x1b[35mstyled\x1b[0m",
    "\x1b[?1049l\x1b[3;5H",
    "\x1b[1;10r\x1b[2S\x1b[r\x1b[12;1Hcomposer",
    "\x1b[H\x1b[2Jreset\r\n\x1b]8;;javascript:alert(1)\x1b\\unsafe\x1b]8;;\x07",
    "\x1b[2;2H\x1b[1m\x1b]8;;https://example.com/" + "a".repeat(1500) + "\x1b\\long link\x1b]8;;\x07\x1b[0m",
  ];
  try {
    for (const chunk of chunks) {
      g.write(chunk);
      reference.write(chunk);
      await writeTerminalEmulator(x, chunk);
      const actual = g.styledRows();
      assert.deepEqual(actual, reference.styledRows());
      assert.deepEqual(actual, renderTerminalScreenRows(x));
    }
    const cached = g.styledRows();
    assert.equal(g.frameReader.counts.decodedRows, 0);
    assert.deepEqual(cached, reference.styledRows());
    assert.equal(g.styledRows()[5], cached[5], "unchanged non-cursor rows retain their identity");
    assert.deepEqual(g.styledRows(true), reference.styledRows());
    assert.equal(g.frameReader.counts.decodedRows, 12);
    for (const terminal of [g, reference]) terminal.resize(100, 16);
    x.resize(100, 16);
    assert.deepEqual(g.styledRows(), reference.styledRows());
    assert.deepEqual(g.styledRows(), renderTerminalScreenRows(x));
  } finally { g.dispose(); reference.dispose(); x.dispose(); }
});

await test("styled history, cursor movement/visibility and palette invalidation", async () => {
  const g = new Ghostty(20, 6);
  const reference = new Ghostty(20, 6, true);
  const x = createTerminalEmulator({ columns: 20, rows: 6 });
  try {
    const output = "\x1b[32mone\x1b[0m\r\n\x1b]8;;https://example.com\x1b\\two\x1b]8;;\x07\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight";
    g.write(output); reference.write(output); await writeTerminalEmulator(x, output);
    for (const scroll of [0, 1, 2, 0]) {
      g.scroll(scroll); reference.scroll(scroll);
      assert.deepEqual(g.styledRows(), reference.styledRows());
      assert.deepEqual(g.styledRows(), renderTerminalScreenRows(x, scroll));
    }
    for (const chunk of ["\x1b[2;3H", "\x1b[4;7H", "\x1b[?25l", "\x1b[?25h"]) {
      g.write(chunk); reference.write(chunk); await writeTerminalEmulator(x, chunk);
      assert.deepEqual(g.styledRows(), reference.styledRows());
      assert.deepEqual(g.styledRows(), renderTerminalScreenRows(x));
    }
    g.write("\x1b[H\x1b[32mgreen\x1b[0m"); reference.write("\x1b[H\x1b[32mgreen\x1b[0m");
    g.styledRows(); reference.styledRows();
    g.write("\x1b]4;2;rgb:11/22/33\x07"); reference.write("\x1b]4;2;rgb:11/22/33\x07");
    assert.deepEqual(g.styledRows(), reference.styledRows());
    assert.equal(g.styledRows()[0].segments[0].style.fg, "112233");
  } finally { g.dispose(); reference.dispose(); x.dispose(); }
});

await test("emoji graphemes match C getters; record native width and URL policy differences", async () => {
  const g = new Ghostty(40, 6);
  const reference = new Ghostty(40, 6, true);
  const x = createTerminalEmulator({ columns: 40, rows: 6 });
  try {
    const output = "👩‍💻 done";
    g.write(output); reference.write(output); await writeTerminalEmulator(x, output);
    assert.deepEqual(g.styledRows(), reference.styledRows());
    assert.equal(g.styledRows()[0].segments.map((part) => part.text).join("").trimEnd(), output);
    differences.push({ name: "emoji ZWJ width", ghosttyCursorX: g.get("CURSOR_X"), craigCursorX: x.buffer.active.cursorX });
    const url = "https://example.com/" + "a".repeat(2048);
    const linked = `\x1b[H\x1b[2J\x1b]8;;${url}\x1b\\long link\x1b]8;;\x07`;
    g.write(linked); reference.write(linked); await writeTerminalEmulator(x, linked);
    assert.deepEqual(g.styledRows(), reference.styledRows());
    differences.push({ name: "2068-byte OSC 8 URL acceptance", ghosttyHasLink: g.styledRows()[0].segments.some((part) => !!part.href), craigHasLink: renderTerminalScreenRows(x)[0].segments.some((part) => !!part.href) });
  } finally { g.dispose(); reference.dispose(); x.dispose(); }
});

const captured = JSON.parse(await readFile(new URL("./fixtures/codex-startup-replay.json", import.meta.url), "utf8"));
const meaningfulRows = (rows) => rows.map(({ segments }) => {
  const output = segments.map((segment) => ({ ...segment }));
  const tail = output.at(-1);
  if (tail && !tail.href && !Object.keys(tail.style ?? {}).length) {
    tail.text = tail.text.trimEnd();
    if (!tail.text) output.pop();
  }
  return { segments: output };
});
await test("real Codex startup replay: styled content parity, ignoring trailing default padding", async () => {
  const g = new Ghostty(captured.columns, captured.rows);
  const reference = new Ghostty(captured.columns, captured.rows, true);
  const x = createTerminalEmulator({ columns: captured.columns, rows: captured.rows });
  try {
    for (const chunk of captured.chunks) {
      g.write(chunk);
      reference.write(chunk);
      await writeTerminalEmulator(x, chunk);
      assert.deepEqual(g.styledRows(), reference.styledRows());
      assert.deepEqual(meaningfulRows(g.styledRows()), meaningfulRows(renderTerminalScreenRows(x)));
    }
  } finally { g.dispose(); reference.dispose(); x.dispose(); }
});

// Synthetic throughput, not a UI latency measurement. Both parse identical 4 KiB
// UTF-8/ASCII chunks, and the xterm callback is awaited before stopping the clock.
const payload = new TextEncoder().encode("\x1b[32mbuild\x1b[0m src/example.ts:123 completed successfully\r\n".repeat(20000));
const samples = { ghostty: [], xterm: [], craig: [] };
for (let round = 0; round < 6; round++) {
  for (const name of round % 2 ? ["craig", "xterm", "ghostty"] : ["ghostty", "xterm", "craig"]) {
    const terminal = name === "ghostty" ? new Ghostty(120, 40) : name === "craig" ? createTerminalEmulator({ columns: 120, rows: 40 }) : new Xterm.Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: true });
    try {
      const started = performance.now();
      for (let i = 0; i < payload.length; i += 4096) {
        const part = payload.subarray(i, i + 4096);
        if (name === "ghostty") terminal.write(part);
        else if (name === "craig") await writeTerminalEmulator(terminal, decoder.decode(part));
        else await new Promise((resolve) => terminal.write(part, resolve));
      }
      if (round > 0) samples[name].push(performance.now() - started);
    } finally { terminal.dispose(); }
  }
}
const median = (data) => [...data].sort((a, b) => a - b)[Math.floor(data.length / 2)];
// Control for xterm's asynchronous write-callback scheduling. Queue every chunk
// immediately and await only the last callback, then measure a viewport read.
const batched = { ghostty: [], xterm: [] };
const frames = { ghostty: [], xterm: [] };
for (let round = 0; round < 6; round++) {
  for (const name of round % 2 ? ["xterm", "ghostty"] : ["ghostty", "xterm"]) {
    const terminal = name === "ghostty" ? new Ghostty(120, 40) : new Xterm.Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: true });
    try {
      const started = performance.now();
      if (name === "ghostty") {
        for (let i = 0; i < payload.length; i += 4096) terminal.write(payload.subarray(i, i + 4096));
      }
      else await new Promise((resolve) => {
        for (let i = 0; i < payload.length; i += 4096) terminal.write(payload.subarray(i, i + 4096), i + 4096 >= payload.length ? resolve : undefined);
      });
      const elapsed = performance.now() - started;
      const frameStart = performance.now();
      for (let i = 0; i < 100; i++) {
        const rows = name === "ghostty" ? terminal.screen() : plain(terminal);
        assert.ok(rows.some((row) => row.includes("completed successfully")));
      }
      if (round > 0) {
        batched[name].push(elapsed);
        frames[name].push((performance.now() - frameStart) / 100);
      }
    } finally { terminal.dispose(); }
  }
}
const medians = (data) => Object.fromEntries(Object.entries(data).map(([name, samples]) => [name, median(samples)]));
const grid = (linked = false) => Array.from({ length: 40 }, (_, y) =>
  `\x1b[${y + 1};1H\x1b[${y % 2 ? "1;32;48;5;235" : "3;38;2;100;150;220"}m` +
  (linked ? "\x1b]8;;https://example.com/preview\x1b\\" : "") +
  `src/feature-${y}.ts build passed `.padEnd(118, ".") +
  (linked ? "\x1b]8;;\x07" : "") + "\x1b[0m").join("");
const denseGrid = grid();
const workloads = {
  codexStartup: captured.chunks,
  protectedComposer: [denseGrid, ...Array.from({ length: 64 }, (_, n) =>
    n % 3 ? `\x1b[1;38r\x1b[2S\x1b[37;1H\x1b[32mcompleted task ${n}\x1b[0m\x1b[r\x1b[40;1Hcomposer ${n}` : `\x1b[6;1H\x1b[2K\x1b[2;33mworking ${n}\x1b[0m\x1b[40;12H`)],
  fullRepaint: Array.from({ length: 24 }, (_, n) => denseGrid + `\x1b[40;1Hframe ${n}`),
  linkDense: Array.from({ length: 12 }, () => grid(true)),
};
await test("benchmark workload snapshots agree with C getters and Craig at every frame", async () => {
  for (const chunks of [workloads.protectedComposer, workloads.fullRepaint, workloads.linkDense]) {
    const g = new Ghostty(120, 40);
    const reference = new Ghostty(120, 40, true);
    const x = createTerminalEmulator({ columns: 120, rows: 40 });
    try {
      for (const chunk of chunks) {
        g.write(chunk); reference.write(chunk); await writeTerminalEmulator(x, chunk);
        const actual = g.styledRows();
        assert.deepEqual(actual, reference.styledRows());
        assert.deepEqual(actual, renderTerminalScreenRows(x));
      }
    } finally { g.dispose(); reference.dispose(); x.dispose(); }
  }
});
const percentile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
const styledBenchmark = {};
for (const [workload, chunks] of Object.entries(workloads)) {
  const metrics = { ghostty: [], craig: [] };
  for (let round = 0; round < 4; round++) {
    for (const name of round % 2 ? ["craig", "ghostty"] : ["ghostty", "craig"]) {
      const terminal = name === "ghostty" ? new Ghostty(120, 40) : createTerminalEmulator({ columns: 120, rows: 40 });
      try {
        for (const chunk of chunks) {
          const parseStart = performance.now();
          if (name === "ghostty") terminal.write(chunk);
          else await writeTerminalEmulator(terminal, chunk);
          const renderStart = performance.now();
          const rows = name === "ghostty" ? terminal.styledRows() : renderTerminalScreenRows(terminal);
          const serializeStart = performance.now();
          const serialized = JSON.stringify(rows);
          assert.ok(serialized.length > 0);
          const end = performance.now();
          if (round > 0) metrics[name].push({ parse: renderStart - parseStart, styledFrame: serializeStart - renderStart, serialize: end - serializeStart, combined: end - parseStart });
        }
      } finally { terminal.dispose(); }
    }
  }
  styledBenchmark[workload] = { framesPerRound: chunks.length, measuredRounds: 3 };
  for (const [name, data] of Object.entries(metrics)) {
    styledBenchmark[workload][name] = Object.fromEntries(["parse", "styledFrame", "serialize", "combined"].map((metric) => [metric, { medianMs: median(data.map((sample) => sample[metric])), p95Ms: percentile(data.map((sample) => sample[metric]), 0.95), maxMs: Math.max(...data.map((sample) => sample[metric])) }]));
  }
}

const memorySoak = { note: "Shared Wasm high-water marks, not process RSS or a leak proof", cycles: [] };
for (let cycle = 0; cycle < 3; cycle++) {
  const terminals = [];
  const before = e.memory.buffer.byteLength;
  try {
    for (let i = 0; i < 20; i++) {
      const terminal = new Ghostty(120, 40);
      terminals.push(terminal);
      terminal.write(denseGrid);
      terminal.styledRows();
    }
    memorySoak.cycles.push({ beforeBytes: before, with20SessionsBytes: e.memory.buffer.byteLength, oneTerminalCore: terminals[0].memoryUsage() });
  } finally { for (const terminal of terminals) terminal.dispose(); }
  memorySoak.cycles.at(-1).afterDisposeBytes = e.memory.buffer.byteLength;
}

// Yield once per frame and measure how long a queued event-loop turn waits.
// This isolates scheduling latency from an unpaced throughput loop. It does not
// emulate the daemon socket, rendering to a real terminal, or large output bursts.
const responsiveness = {};
for (const name of ["ghostty", "craig"]) {
  const delays = [];
  const terminal = name === "ghostty" ? new Ghostty(120, 40) : createTerminalEmulator({ columns: 120, rows: 40 });
  try {
    for (const chunk of workloads.protectedComposer) {
      const start = performance.now();
      const turn = new Promise((resolve) => setImmediate(() => resolve(performance.now() - start)));
      if (name === "ghostty") terminal.write(chunk);
      else await writeTerminalEmulator(terminal, chunk);
      JSON.stringify(name === "ghostty" ? terminal.styledRows() : renderTerminalScreenRows(terminal));
      delays.push(await turn);
    }
    responsiveness[name] = { p95QueuedTurnMs: percentile(delays, 0.95), maxQueuedTurnMs: Math.max(...delays) };
  } finally { terminal.dispose(); }
}

// Cached output must remain correct after an allocation grows shared Wasm memory.
await test("cached rows survive memory growth and repeated session disposal", () => {
  const g = new Ghostty(120, 40);
  try {
    g.write(denseGrid);
    const expected = g.styledRows();
    e.memory.grow(1);
    assert.deepEqual(g.styledRows(), expected);
    assert.equal(g.frameReader.counts.decodedRows, 0);
    for (let i = 0; i < 100; i++) {
      const other = new Ghostty(120, 40);
      try { other.write(denseGrid); other.styledRows(); } finally { other.dispose(); }
    }
    assert.deepEqual(g.styledRows(), expected);
  } finally { g.dispose(); }
});
console.log(JSON.stringify({ version: VERSION, sha256: SHA256, wasmBytes: binary.length, startupMs, runtime: process.version, platform: `${process.platform}-${process.arch}`, passed: results, skipped: skipPty ? ["real node-pty child (--skip-pty)"] : [], differences, scrolling, benchmark: { bytes: payload.length, chunkBytes: 4096, warmupRounds: 1, measuredRounds: 5, serialCallbackMedianMs: medians(samples), queuedChunksMedianMs: medians(batched), plainViewportMedianMs: medians(frames) }, styledBenchmark, memorySoak, responsiveness, wasmMemoryBytesAfterRun: e.memory.buffer.byteLength }, null, 2));
e.__indirect_function_table.set(callbackIndex, null);
for (const [ptr, size] of allocations) e.ghostty_wasm_free(ptr, size);
