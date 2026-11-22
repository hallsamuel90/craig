import { createXtermEmulator } from "./terminal-xterm.js";

export interface TerminalSize {
  columns: number;
  rows: number;
}

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

// UI-owned contract: consumers never inspect backend buffers or parser state.
/* eslint-disable no-unused-vars */
export interface TerminalEmulator {
  // Resolves after parsing so the next screen read observes this chunk.
  write(chunk: string): Promise<void>;
  resize(size: TerminalSize): void;
  renderRows(scrollbackLines?: number): TerminalScreenRow[];
  getActiveScreenText(): string;
  getScrollbackLength(): number;
  encodeKey?(key: string): string | null;
  dispose(): void;
}

export interface TerminalEmulatorOptions {
  // The backend owns terminal replies; the runtime only forwards these to its PTY.
  onReply: (data: string) => void;
}

export type TerminalEmulatorFactory = (size: TerminalSize, options: TerminalEmulatorOptions) => TerminalEmulator;
/* eslint-enable no-unused-vars */

export const createTerminalEmulator: TerminalEmulatorFactory = createXtermEmulator;
