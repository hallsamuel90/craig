import { setImmediate as yieldTurn } from "node:timers/promises";

import type { TerminalEmulator, TerminalEmulatorOptions, TerminalSize } from "../terminal-emulator.js";
import { createGhosttyFrameReader } from "./frame-reader.js";
import { ghosttyOffset, ghosttyValue, instantiateGhostty, REPLY_TRAMPOLINE, wasmHost } from "./wasm.js";

type Core = ReturnType<typeof instantiateGhostty> & { replies: Map<number, string[]>; callbackIndex: number };
let core: Core | undefined;

// Read-only diagnostics for soak verification; do not expose native handles.
export function getGhosttyRuntimeStats(): { activeSessions: number; memoryBytes: number } {
  return { activeSessions: core?.replies.size ?? 0, memoryBytes: core?.api.memory.buffer.byteLength ?? 0 };
}

function getCore(): Core {
  if (core) return core;
  const loaded = instantiateGhostty();
  const replies = new Map<number, string[]>();
  const callback = new wasmHost.Instance(new wasmHost.Module(REPLY_TRAMPOLINE), {
    env: { reply: (terminal: number, _userdata: number, ptr: number, len: number) => {
      replies.get(terminal)?.push(Buffer.from(loaded.api.memory.buffer, ptr, len).toString("utf8"));
    } },
  });
  const callbackIndex = loaded.api.table.grow(1);
  loaded.api.table.set(callbackIndex, callback.exports.reply);
  core = { ...loaded, replies, callbackIndex };
  return core;
}

export function createGhosttyEmulator(size: TerminalSize, options: TerminalEmulatorOptions): TerminalEmulator {
  validateSize(size);
  const { api, types, replies, callbackIndex } = getCore();
  const e = api.functions;
  const value = (type: string, key: string) => ghosttyValue(types, type, key);
  const offset = (type: string, field: string) => ghosttyOffset(types, type, field);
  const check = (result: number) => { if (result !== 0) throw new Error(`Ghostty operation failed: ${result}`); };
  const allocated: Array<[number, number]> = [];
  const handles: Array<() => void> = [];
  let terminal = 0;
  let disposed = false;
  let reader: ReturnType<typeof createGhosttyFrameReader> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    replies.delete(terminal);
    reader?.dispose();
    for (const release of handles.reverse()) release();
    for (const [ptr, len] of allocated) e.ghostty_wasm_free!(ptr, len);
  };
  const alloc = (len: number) => {
    const ptr = e.ghostty_wasm_alloc!(len);
    if (!ptr) throw new Error("Ghostty allocation failed.");
    allocated.push([ptr, len]);
    return ptr;
  };
  try {
    const scratch = alloc(1024);
    const input = alloc(16384);
    const dv = () => new DataView(api.memory.buffer);
    const bytes = () => new Uint8Array(api.memory.buffer);
    const create = (name: string, free: string, ...args: number[]) => {
      check(e[name]!(0, scratch, ...args));
      const handle = e.ghostty_wasm_take_opaque!(scratch);
      handles.push(() => { e[free]!(handle); });
      return handle;
    };
    terminal = create("ghostty_terminal_new", "ghostty_terminal_free", size.columns, size.rows);
    replies.set(terminal, []);
    const set = (key: string, ptr: number, allowUnsupported = false) => {
      const result = e.ghostty_terminal_set!(terminal, value("GhosttyTerminalOption", key), ptr);
      // The freestanding artifact compiles out host image facilities. A
      // disabled option being unsupported means the facility is unavailable.
      if (allowUnsupported && result === value("GhosttyResult", "UNSUPPORTED")) return;
      check(result);
    };
    set("WRITE_PTY", callbackIndex);
    for (const [key, limit] of [["SCROLLBACK_MAX_LINES", 1000], ["SCROLLBACK_MAX_BYTES", 8 * 1024 * 1024], ["KITTY_IMAGE_STORAGE_LIMIT", 0]] as const) {
      bytes().fill(0, scratch, scratch + 8);
      dv().setUint32(scratch, limit, true);
      set(key, scratch, limit === 0);
    }
    bytes().fill(0, scratch, scratch + 8);
    set("KITTY_IMAGE_MEDIUM_FILE", scratch, true);
    set("KITTY_IMAGE_MEDIUM_SHARED_MEM", scratch, true);
    const ansi = ["000000", "cd3131", "0dbc79", "e5e510", "2472c8", "bc3fbc", "11a8cd", "e5e5e5", "666666", "f14c4c", "23d18b", "f5f543", "3b8eea", "d670d6", "29b8db", "ffffff"];
    for (let index = 0; index < 256; index++) {
      const channels = index < 16 ? ansi[index]!.match(/../g)!.map((part) => Number.parseInt(part, 16))
        : index < 232 ? [Math.floor((index - 16) / 36), Math.floor(((index - 16) % 36) / 6), (index - 16) % 6].map((n) => n ? 55 + n * 40 : 0)
          : Array<number>(3).fill(8 + (index - 232) * 10);
      bytes().set(channels, scratch + index * 3);
    }
    set("COLOR_PALETTE", scratch);
    for (const [key, color] of [["COLOR_FOREGROUND", [230, 230, 230]], ["COLOR_BACKGROUND", [10, 10, 10]]] as const) {
      bytes().set(color, scratch);
      set(key, scratch);
    }
    reader = createGhosttyFrameReader(api, types, terminal);
    const frameReader = reader;
    const encoder = create("ghostty_key_encoder_new", "ghostty_key_encoder_free");
    const event = create("ghostty_key_event_new", "ghostty_key_event_free");
    let queue: Promise<void> = Promise.resolve();
    let scrollback = 0;
    const flushReplies = () => {
      for (const reply of replies.get(terminal)?.splice(0) ?? []) {
        if (disposed) break;
        options.onReply(reply);
      }
    };
    const enqueue = (operation: () => void | Promise<void>) => {
      const work = queue.then(() => { if (!disposed) return operation(); });
      queue = work.catch(() => {});
      return work;
    };
    const get = (key: string) => {
      bytes().fill(0, scratch, scratch + 8);
      check(e.ghostty_terminal_get!(terminal, value("GhosttyTerminalData", key), scratch));
      return dv().getUint32(scratch, true);
    };
    const scrollTo = (lines: number) => {
      if (scrollback === lines) return;
      bytes().fill(0, scratch, scratch + types.GhosttyTerminalScrollViewport!.size);
      dv().setInt32(scratch, value("GhosttyTerminalScrollViewportTag", "BOTTOM"), true);
      check(e.ghostty_terminal_scroll_viewport!(terminal, scratch));
      if (lines > 0) {
        dv().setInt32(scratch, value("GhosttyTerminalScrollViewportTag", "DELTA"), true);
        dv().setInt32(scratch + offset("GhosttyTerminalScrollViewport", "value"), -lines, true);
        check(e.ghostty_terminal_scroll_viewport!(terminal, scratch));
      }
      scrollback = lines;
    };
    return {
      write(chunk) {
        return enqueue(async () => {
          // Output always updates the active screen, independent of which
          // historical rows the UI last requested.
          scrollTo(0);
          const encoded = Buffer.from(chunk, "utf8");
          let turnStart = performance.now();
          for (let start = 0; start < encoded.length && !disposed; start += 16384) {
            const part = encoded.subarray(start, start + 16384);
            bytes().set(part, input);
            e.ghostty_terminal_vt_write!(terminal, input, part.length);
            if (performance.now() - turnStart >= 4 && start + part.length < encoded.length) {
              flushReplies();
              await yieldTurn();
              turnStart = performance.now();
            }
          }
          if (!disposed) flushReplies();
        });
      },
      resize(nextSize) {
        if (disposed) return;
        validateSize(nextSize);
        check(e.ghostty_terminal_resize!(terminal, nextSize.columns, nextSize.rows, 0, 0));
        scrollback = -1;
        scrollTo(0);
        flushReplies();
      },
      renderRows(lines = 0) {
        if (disposed) return [];
        scrollTo(Math.max(0, Math.min(get("SCROLLBACK_ROWS"), Math.floor(lines))));
        return frameReader.renderRows();
      },
      getActiveScreenText() {
        if (disposed) return "";
        const previous = scrollback;
        scrollTo(0);
        const text = frameReader.renderRows().map((row) => row.segments.map((segment) => segment.text).join("").trimEnd()).join("\n");
        scrollTo(previous);
        return text;
      },
      getScrollbackLength: () => disposed ? 0 : get("SCROLLBACK_ROWS"),
      encodeKey(key) {
        if (disposed) return null;
        const mapped = mapKey(key);
        if (!mapped) return null;
        check(e.ghostty_key_encoder_set_from_terminal!(encoder, terminal));
        check(e.ghostty_key_event_set_action!(event, value("GhosttyKeyAction", "PRESS")));
        check(e.ghostty_key_event_set_key!(event, value("GhosttyKey", mapped.key)));
        check(e.ghostty_key_event_set_mods!(event, mapped.mods));
        check(e.ghostty_key_event_set_unshifted_codepoint!(event, mapped.text?.toLowerCase().codePointAt(0) ?? 0));
        const text = Buffer.from(mapped.text ?? "");
        bytes().set(text, scratch + 128);
        dv().setUint32(scratch, text.length ? scratch + 128 : 0, true);
        dv().setUint32(scratch + 4, text.length, true);
        check(e.ghostty_key_event_set_utf8!(event, scratch));
        check(e.ghostty_key_encoder_encode!(encoder, event, scratch + 256, 512, scratch + 8));
        return Buffer.from(api.memory.buffer, scratch + 256, dv().getUint32(scratch + 8, true)).toString("utf8");
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}

function validateSize(size: TerminalSize): void {
  if (![size.columns, size.rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000) || size.columns * size.rows > 100000) {
    throw new Error("Ghostty terminal dimensions exceed the supported limits.");
  }
}

function mapKey(input: string): { key: string; mods: number; text?: string } | null {
  let key = input;
  let mods = 0;
  if (key === "BACK_TAB") key = "SHIFT_TAB";
  for (;;) {
    const match = /^(SHIFT|CTRL|ALT|META)_/.exec(key);
    if (!match) break;
    mods |= { SHIFT: 1, CTRL: 2, ALT: 4, META: 8 }[match[1]!] ?? 0;
    key = key.slice(match[0].length);
  }
  const names: Record<string, string> = { UP: "ARROW_UP", DOWN: "ARROW_DOWN", LEFT: "ARROW_LEFT", RIGHT: "ARROW_RIGHT", KP_ENTER: "NUMPAD_ENTER" };
  if (/^(ENTER|KP_ENTER|TAB|BACKSPACE|DELETE|ESCAPE|UP|DOWN|LEFT|RIGHT|HOME|END|PAGE_UP|PAGE_DOWN|F(?:[1-9]|1[0-2]))$/.test(key)) return { key: names[key] ?? key, mods };
  if ([...key].length === 1) {
    const physical = /^[a-z]$/i.test(key) ? key.toUpperCase() : /^[0-9]$/.test(key) ? `DIGIT_${key}` : key === " " ? "SPACE" : "UNIDENTIFIED";
    return { key: physical, mods, text: key };
  }
  return null;
}
