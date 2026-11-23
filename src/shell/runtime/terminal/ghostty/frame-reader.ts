import type { TerminalCellStyle, TerminalScreenRow, TerminalRowSegment } from "../terminal-emulator.js";
import type { BitSpec, GhosttyApi, GhosttyTypes } from "./wasm.js";
import { ghosttyOffset, ghosttyValue } from "./wasm.js";

interface DecodedCell { x: number; text: string; style: TerminalCellStyle; key: string; href: string | undefined }
interface Cursor { x: number; y: number; inViewport: boolean; visible: boolean }

export function createGhosttyFrameReader(api: GhosttyApi, types: GhosttyTypes, terminal: number) {
  const e = api.functions;
  const value = (type: string, key: string) => ghosttyValue(types, type, key);
  const offset = (type: string, field: string) => ghosttyOffset(types, type, field);
  const check = (result: number) => {
    if (result !== value("GhosttyResult", "SUCCESS")) throw new Error(`Ghostty frame read failed: ${result}`);
  };
  const allocations = new Map<number, number>();
  const handles: Array<() => void> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const release of handles.reverse()) release();
    for (const [ptr, size] of allocations) e.ghostty_wasm_free!(ptr, size);
    allocations.clear();
  };
  const allocate = (size: number) => {
    const ptr = e.ghostty_wasm_alloc!(size);
    if (!ptr) throw new Error("Ghostty frame allocation failed");
    allocations.set(ptr, size);
    return ptr;
  };
  try {
    const scratch = allocate(4096);
    let capacity = 1024;
    let data = allocate(capacity);
    let buffer: ArrayBuffer | undefined;
    let dv: DataView;
    const memory = () => {
      if (buffer !== api.memory.buffer || dv.byteLength !== api.memory.buffer.byteLength) {
        buffer = api.memory.buffer;
        dv = new DataView(buffer);
      }
      return dv;
    };
    const construct = (fn: NonNullable<typeof e[string]>, destroy: NonNullable<typeof e[string]>) => {
      check(fn(0, scratch));
      const handle = e.ghostty_wasm_take_opaque!(scratch);
      handles.push(() => { destroy(handle); });
      return handle;
    };
    const render = construct(e.ghostty_render_state_new!, e.ghostty_render_state_free!);
    const iterator = construct(e.ghostty_render_state_row_iterator_new!, e.ghostty_render_state_row_iterator_free!);
    const cells = construct(e.ghostty_render_state_row_cells_new!, e.ghostty_render_state_row_cells_free!);
    const decoder = new TextDecoder();
    const dirtyPtr = scratch + 128;
    const colsPtr = scratch + 144;
    const rowsPtr = scratch + 160;
    const cursorPtr = scratch + 176;
    const colorsPtr = scratch + 256;
    const rowDirty = scratch + 1088;
    const rawView = scratch + 1104;
    const cellsSlot = scratch + 1120;
    const stylePtr = scratch + 1136;
    const textBuffer = scratch + 1168;
    const refPtr = scratch + 1200;
    const pointPtr = scratch + 1216;
    const lenPtr = scratch + 1248;
    const frameFields = ["DIRTY", "COLS", "ROWS", "CURSOR", "COLORS"];
    for (let i = 0; i < frameFields.length; i++) {
      memory().setInt32(scratch + 16 + 4 * i, value("GhosttyRenderStateData", frameFields[i]!), true);
      memory().setUint32(scratch + 48 + 4 * i, [dirtyPtr, colsPtr, rowsPtr, cursorPtr, colorsPtr][i]!, true);
    }
    for (let i = 0; i < 2; i++) {
      memory().setInt32(scratch + 80 + 4 * i, value("GhosttyRenderStateRowData", ["CELLS_RAW", "CELLS"][i]!), true);
      memory().setUint32(scratch + 96 + 4 * i, [rawView, cellsSlot][i]!, true);
    }
    // Decode packed positions from the artifact's manifest, not a hard-coded ABI.
    // eslint-disable-next-line no-unused-vars
    const field = ({ lsb, width }: Pick<BitSpec, "lsb" | "width">): ((low: number, high: number) => number) => {
      if (lsb >= 32) return (_low, high) => (high >>> (lsb - 32)) % 2 ** width;
      if (lsb + width <= 32) return (low) => (low >>> lsb) % 2 ** width;
      return (low, high) => ((low >>> lsb) + (high % 2 ** (lsb + width - 32)) * 2 ** (32 - lsb)) % 2 ** width;
    };
    const rawBits = Object.fromEntries(Object.entries(types.GhosttyCell!.bits).map(([name, spec]) => [name, field(spec)]));
    const content = types.GhosttyCell!.bits.content!;
    const cpBits = content.arms.CODEPOINT!.bits.codepoint!;
    const codepoint = field({ lsb: content.lsb + cpBits.lsb, width: cpBits.width });
    const flag = (bits: number, name: string) => field(types.GhosttyStyleFlags!.bits[name]!)(bits, 0);
    const hex = (number: number) => number.toString(16).padStart(2, "0");
    const rgb = (ptr: number) => hex(memory().getUint8(ptr)) + hex(memory().getUint8(ptr + 1)) + hex(memory().getUint8(ptr + 2));
    const palette = (index: number) => rgb(colorsPtr + offset("GhosttyRenderStateColors", "palette") + index * types.GhosttyColorRgb!.size);
    const color = (ptr: number) => {
      const tag = memory().getUint8(ptr + offset("GhosttyStyleColor", "tag"));
      const payload = ptr + offset("GhosttyStyleColor", "value");
      if (tag === value("GhosttyStyleColorTag", "RGB")) return rgb(payload);
      if (tag === value("GhosttyStyleColorTag", "PALETTE")) return palette(memory().getUint8(payload));
    };
    let counts = { decodedRows: 0, styleReads: 0, graphemeReads: 0, linkReads: 0 };
    const style = () => {
      const output: TerminalCellStyle = {};
      const fg = color(stylePtr + offset("GhosttyStyle", "fg_color"));
      const bg = color(stylePtr + offset("GhosttyStyle", "bg_color"));
      if (fg !== undefined) output.fg = fg;
      if (bg !== undefined) output.bg = bg;
      const bits = memory().getUint16(stylePtr + offset("GhosttyStyle", "flags"), true);
      for (const [source, target] of [["bold", "bold"], ["faint", "dim"], ["italic", "italic"], ["underline", "underline"], ["inverse", "inverse"]] as const) {
        if (flag(bits, source)) output[target] = true;
      }
      return output;
    };
    const resizeData = (needed: number) => {
      if (needed <= capacity) throw new Error("Unexpected Ghostty buffer size");
      if (needed > 16 * 1024 * 1024) throw new Error("Ghostty metadata exceeds 16 MiB");
      const next = allocate(needed);
      e.ghostty_wasm_free!(data, capacity);
      allocations.delete(data);
      data = next;
      capacity = needed;
    };
    const text = () => {
      for (;;) {
        memory().setUint32(textBuffer + offset("GhosttyBuffer", "ptr"), data, true);
        memory().setUint32(textBuffer + offset("GhosttyBuffer", "cap"), capacity, true);
        const result = e.ghostty_render_state_row_cells_get!(cells, value("GhosttyRenderStateRowCellsData", "GRAPHEMES_UTF8"), textBuffer);
        const len = memory().getUint32(textBuffer + offset("GhosttyBuffer", "len"), true);
        if (result === value("GhosttyResult", "OUT_OF_SPACE")) { resizeData(len); continue; }
        check(result);
        return len ? decoder.decode(new Uint8Array(api.memory.buffer, data, len)) : " ";
      }
    };
    let uriValidity = new Map<string, boolean>();
    const hyperlink = (x: number, y: number) => {
      new Uint8Array(api.memory.buffer, pointPtr, types.GhosttyPoint!.size).fill(0);
      memory().setInt32(pointPtr, value("GhosttyPointTag", "VIEWPORT"), true);
      const coordinate = pointPtr + offset("GhosttyPoint", "value");
      memory().setUint16(coordinate + offset("GhosttyPointCoordinate", "x"), x, true);
      memory().setUint32(coordinate + offset("GhosttyPointCoordinate", "y"), y, true);
      check(e.ghostty_terminal_grid_ref!(terminal, pointPtr, refPtr));
      for (;;) {
        const result = e.ghostty_grid_ref_hyperlink_uri!(refPtr, data, capacity, lenPtr);
        const len = memory().getUint32(lenPtr, true);
        if (result === value("GhosttyResult", "OUT_OF_SPACE")) { resizeData(len); continue; }
        check(result);
        const uri = decoder.decode(new Uint8Array(api.memory.buffer, data, len));
        if (!uriValidity.has(uri)) uriValidity.set(uri, /^(https?:|file:|mailto:)/i.test(uri) && ![...uri].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)));
        return uriValidity.get(uri) ? uri : undefined;
      }
    };
    const styleKeys = new WeakMap<TerminalCellStyle, string>();
    const key = (s: TerminalCellStyle): string => {
      if (!styleKeys.has(s)) styleKeys.set(s, [s.fg ?? "", s.bg ?? "", !!s.bold, !!s.dim, !!s.italic, !!s.underline, !!s.inverse].join("|"));
      return styleKeys.get(s)!;
    };
    const readRow = (y: number): DecodedCell[] => {
      counts.decodedRows++;
      memory().setUint32(cellsSlot, cells, true);
      check(e.ghostty_render_state_row_get_multi!(iterator, 2, scratch + 80, scratch + 96, 0));
      const ptr = memory().getUint32(rawView + offset("GhosttyCellsView", "ptr"), true);
      const len = memory().getUint32(rawView + offset("GhosttyCellsView", "len"), true);
      const output: DecodedCell[] = [];
      // Style ids are page-local. Never reuse this cache across rows/updates.
      const styles = new Map<number, TerminalCellStyle>([[0, {}]]);
      const linkStyles = new Map<TerminalCellStyle, TerminalCellStyle>();
      uriValidity = new Map<string, boolean>();
      for (let x = 0; x < len; x++) {
        const low = memory().getUint32(ptr + x * types.GhosttyCell!.size, true);
        const high = memory().getUint32(ptr + x * types.GhosttyCell!.size + 4, true);
        let wide = rawBits.wide!(low, high);

        if (wide === value("GhosttyCellWide", "SPACER_HEAD") || wide === value("GhosttyCellWide", "SPACER_TAIL")) continue;
        const tag = rawBits.content_tag!(low, high);
        const styleId = rawBits.style_id!(low, high);
        const grapheme = tag === value("GhosttyCellContentTag", "CODEPOINT_GRAPHEME");
        const needsStyle = !styles.has(styleId);
        if ((needsStyle || grapheme)) check(e.ghostty_render_state_row_cells_select!(cells, x));
        let cellStyle = styles.get(styleId)!;
        if (needsStyle) {
          counts.styleReads++;
          check(e.ghostty_render_state_row_cells_get!(cells, value("GhosttyRenderStateRowCellsData", "STYLE"), stylePtr));
          cellStyle = style();
          styles.set(styleId, cellStyle);
        }
        // Blank cells may store their background directly in the raw content.
        if (tag === value("GhosttyCellContentTag", "BG_COLOR_PALETTE")) cellStyle = { ...cellStyle, bg: palette(rawBits.content!(low, high) % 256) };
        if (tag === value("GhosttyCellContentTag", "BG_COLOR_RGB")) {
          const packed = rawBits.content!(low, high);
          cellStyle = { ...cellStyle, bg: hex(packed % 256) + hex((packed >>> 8) % 256) + hex((packed >>> 16) % 256) };
        }
        let chars;
        if (grapheme) { counts.graphemeReads++; chars = text(); }
        else chars = tag === value("GhosttyCellContentTag", "CODEPOINT") && codepoint(low, high) ? String.fromCodePoint(codepoint(low, high)) : " ";
        let href;
        if (rawBits.hyperlink!(low, high)) {
          counts.linkReads++;
          href = hyperlink(x, y);
          // xterm exposes OSC 8 links as underlined cells; preserve Craig's look.
          if (!linkStyles.has(cellStyle)) linkStyles.set(cellStyle, { ...cellStyle, underline: true });
          cellStyle = linkStyles.get(cellStyle)!;
        }
        output.push({ x, text: chars, style: cellStyle, key: key(cellStyle), href });
      }
      return output;
    };
    const segments = (row: DecodedCell[], cursorX: number): TerminalScreenRow => {
      const output: TerminalRowSegment[] = [];
      let previousKey: string | undefined;
      for (const cell of row) {
        const s = cell.x === cursorX ? { ...cell.style, inverse: true } : cell.style;
        const k = cell.x === cursorX ? key(s) : cell.key;
        const previous = output.at(-1);
        if (previous && previousKey === k && previous.href === cell.href) previous.text += cell.text;
        else {
          const next: TerminalRowSegment = { text: cell.text, style: s };
          if (cell.href) next.href = cell.href;
          output.push(next);
        }
        previousKey = k;
      }
      // Preserve Craig's styled-row shape and padding, with an inverse overlay
      // only while the native cursor is visible within the viewport.
      return { segments: output };
    };
    let cached: TerminalScreenRow[] = [];
    let decoded: DecodedCell[][] = [];
    let oldCursor = { x: -1, y: -1 };
    let oldCols: number | undefined;
    let cursor: Cursor | undefined;
    return {
      renderRows({ forceFull = false } = {}): TerminalScreenRow[] {
        if (disposed) throw new Error("Ghostty frame reader is disposed.");
        counts = { decodedRows: 0, styleReads: 0, graphemeReads: 0, linkReads: 0 };
        check(e.ghostty_render_state_update!(render, terminal));
        memory().setUint32(cursorPtr, types.GhosttyRenderStateCursor!.size, true);
        memory().setUint32(colorsPtr, types.GhosttyRenderStateColors!.size, true);
        check(e.ghostty_render_state_get_multi!(render, 5, scratch + 16, scratch + 48, 0));
        const cols = memory().getUint16(colsPtr, true);
        const rows = memory().getUint16(rowsPtr, true);
        const cf = (field: string) => cursorPtr + offset("GhosttyRenderStateCursor", field);
        cursor = {
          x: memory().getUint16(cf("viewport_x"), true), y: memory().getUint16(cf("viewport_y"), true),
          inViewport: !!memory().getUint8(cf("viewport_has_value")), visible: !!memory().getUint8(cf("visible")),
        };
        if (!cursor.inViewport || !cursor.visible) { cursor.x = -1; cursor.y = -1; }
        const full = forceFull || oldCols !== cols || cached.length !== rows || memory().getInt32(dirtyPtr, true) === value("GhosttyRenderStateDirty", "FULL");
        const next = cached.slice(0, rows);
        memory().setUint32(scratch, iterator, true);
        check(e.ghostty_render_state_get!(render, value("GhosttyRenderStateData", "ROW_ITERATOR"), scratch));
        let y = 0;
        while (e.ghostty_render_state_row_iterator_next!(iterator)) {
          check(e.ghostty_render_state_row_get!(iterator, value("GhosttyRenderStateRowData", "DIRTY"), rowDirty));
          const dirty = full || !!memory().getUint8(rowDirty) || !decoded[y];
          if (dirty) decoded[y] = readRow(y);
          if (dirty || y === oldCursor.y || y === cursor.y) next[y] = segments(decoded[y]!, y === cursor.y ? cursor.x : -1);
          y++;
        }
        check(e.ghostty_render_state_clean!(render));
        decoded.length = rows;
        cached = next;
        oldCols = cols;
        oldCursor = cursor;
        return next;
      },
      get counts() { return counts; },
      get cursor() { return cursor; },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
