import type { TerminalScreenRow } from "./terminal-emulator.js";
export type TerminalStatus = "idle" | "running" | "exited" | "failed";
export interface TerminalViewState {
  status: TerminalStatus;
  rows: TerminalScreenRow[];
  error: string | null;
  scrolledBack?: boolean;
}
