import XtermHeadless from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import type { Terminal } from "@xterm/headless";

import type { PtySize } from "./pty-runtime.js";

export interface TerminalCellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface TerminalRowSegment {
  text: string;
  style?: TerminalCellStyle;
  href?: string;
}

export interface TerminalScreenRow {
  segments: TerminalRowSegment[];
}

const DEFAULT_SCROLLBACK = 1_000;
const ANSI_PALETTE = [
  "000000",
  "cd3131",
  "0dbc79",
  "e5e510",
  "2472c8",
  "bc3fbc",
  "11a8cd",
  "e5e5e5",
  "666666",
  "f14c4c",
  "23d18b",
  "f5f543",
  "3b8eea",
  "d670d6",
  "29b8db",
  "ffffff",
] as const;

export function createTerminalEmulator(size: PtySize): Terminal {
  return new XtermHeadless.Terminal({
    allowProposedApi: true,
    cols: size.columns,
    rows: size.rows,
    scrollback: DEFAULT_SCROLLBACK,
    theme: {
      foreground: "#e6e6e6",
      background: "#0a0a0a",
    },
  });
}

export function resizeTerminalEmulator(terminal: Terminal, size: PtySize): void {
  if (terminal.cols !== size.columns || terminal.rows !== size.rows) {
    terminal.resize(size.columns, size.rows);
  }
}

export function writeTerminalEmulator(terminal: Terminal, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(chunk, resolve);
  });
}

export function renderTerminalScreenRows(terminal: Terminal, scrollbackLines = 0): TerminalScreenRow[] {
  const buffer = terminal.buffer.active;
  const rows: TerminalScreenRow[] = [];
  const reusableCell = buffer.getNullCell();
  const cursorY = buffer.baseY + buffer.cursorY;
  const startY = Math.max(0, buffer.baseY - scrollbackLines);

  for (let rowIndex = 0; rowIndex < terminal.rows; rowIndex += 1) {
    const line = buffer.getLine(startY + rowIndex);

    if (!line) {
      rows.push({ segments: [] });
      continue;
    }

    const cells: Array<{ text: string; style: TerminalCellStyle }> = [];

    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line.getCell(column, reusableCell);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }

      cells.push({
        text: cell.getChars() || " ",
        style: getCellStyle(cell, startY + rowIndex === cursorY && column === buffer.cursorX),
      });
    }

    rows.push({ segments: cellsToSegments(trimTrailingDefaultCells(cells)) });
  }

  return rows;
}

function cellsToSegments(cells: Array<{ text: string; style: TerminalCellStyle }>): TerminalRowSegment[] {
  const segments: TerminalRowSegment[] = [];

  for (const cell of cells) {
    const previous = segments.at(-1);
    if (previous && stylesEqual(previous.style, cell.style)) {
      previous.text += cell.text;
      continue;
    }

    const nextSegment: TerminalRowSegment = { text: cell.text };
    if (!isDefaultStyle(cell.style)) {
      nextSegment.style = cell.style;
    }
    segments.push(nextSegment);
  }

  return segments;
}

function trimTrailingDefaultCells(cells: Array<{ text: string; style: TerminalCellStyle }>): Array<{ text: string; style: TerminalCellStyle }> {
  let end = cells.length;

  while (end > 0) {
    const cell = cells[end - 1];
    if (!cell || cell.text !== " " || !isDefaultStyle(cell.style)) {
      break;
    }

    end -= 1;
  }

  return cells.slice(0, end);
}

function getCellStyle(cell: IBufferCell, cursor: boolean): TerminalCellStyle {
  const style: TerminalCellStyle = {};
  const fg = getCellColor(cell, "fg");
  const bg = getCellColor(cell, "bg");

  if (fg) {
    style.fg = fg;
  }
  if (bg) {
    style.bg = bg;
  }
  if (cell.isBold()) {
    style.bold = true;
  }
  if (cell.isDim()) {
    style.dim = true;
  }
  if (cell.isItalic()) {
    style.italic = true;
  }
  if (cell.isUnderline()) {
    style.underline = true;
  }
  if (cell.isInverse() || cursor) {
    style.inverse = true;
  }

  return style;
}

function getCellColor(cell: IBufferCell, channel: "fg" | "bg"): string | undefined {
  const isDefault = channel === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    return undefined;
  }

  const isRgb = channel === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  const color = channel === "fg" ? cell.getFgColor() : cell.getBgColor();

  if (isRgb) {
    return color.toString(16).padStart(6, "0");
  }

  return ANSI_PALETTE[color] ?? palette256ToHex(color);
}

function palette256ToHex(index: number): string {
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const red = Math.floor(offset / 36);
    const green = Math.floor((offset % 36) / 6);
    const blue = offset % 6;
    return [red, green, blue].map(colorCubeToByte).map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  if (index >= 232 && index <= 255) {
    const value = 8 + (index - 232) * 10;
    return [value, value, value].map((part) => part.toString(16).padStart(2, "0")).join("");
  }

  return "e6e6e6";
}

function colorCubeToByte(value: number): number {
  return value === 0 ? 0 : 55 + value * 40;
}

function stylesEqual(left: TerminalCellStyle | undefined, right: TerminalCellStyle | undefined): boolean {
  return styleKey(left) === styleKey(right);
}

function styleKey(style: TerminalCellStyle | undefined): string {
  if (!style) {
    return "";
  }

  return [
    style.fg ?? "",
    style.bg ?? "",
    style.bold ? "b" : "",
    style.dim ? "d" : "",
    style.italic ? "i" : "",
    style.underline ? "u" : "",
    style.inverse ? "v" : "",
  ].join("|");
}

function isDefaultStyle(style: TerminalCellStyle | undefined): boolean {
  return styleKey(style) === "";
}
