import { RUNNER_IDS } from "../../domain/config/index.js";
import { isEnterKey } from "../state.js";

export function shouldTrackTerminalKey(key: string): boolean {
  return key.length === 1 || isEnterKey(key) || key === "BACKSPACE" || key === "TAB";
}

export function isAgentTabId(tabId: string | null): boolean {
  return typeof tabId === "string" && new RegExp(`:(?:agent|${RUNNER_IDS.join("|")})(?:-\\d+)?$`).test(tabId);
}

export function getTerminalScrollLinesForKey(key: string, scrolledBack: boolean): number {
  if (key === "UP" && scrolledBack) return -3;
  if (key === "DOWN" && scrolledBack) return 3;
  if (key === "PAGE_UP") return -5;
  if (key === "PAGE_DOWN") return 5;
  if (key === "MOUSE_WHEEL_UP") return -3;
  if (key === "MOUSE_WHEEL_DOWN") return 3;
  return 0;
}

export function getTerminalScrollLinesForMouseEvent(name: unknown): number {
  if (name === "MOUSE_WHEEL_UP") return -3;
  if (name === "MOUSE_WHEEL_DOWN") return 3;
  return 0;
}

export function getTerminalScrollLinesForRawInput(raw: string): number {
  const match = new RegExp(`${String.fromCharCode(27)}\\[<(\\d+);\\d+;\\d+[mM]`).exec(raw);
  if (!match?.[1]) return 0;
  const code = Number.parseInt(match[1], 10);
  if (code === 64) return -3;
  if (code === 65) return 3;
  return 0;
}

export function mapRawTerminalInputToKey(raw: string): string | null {
  if (SHIFT_ENTER_RAW_INPUTS.includes(raw)) return "SHIFT_ENTER";
  return null;
}

export function isRawTerminalInputPrefix(raw: string): boolean {
  return SHIFT_ENTER_RAW_INPUTS.some((input) => input.startsWith(raw));
}

export function terminalKeyToRawSequencePart(key: string): string | null {
  if (key === "ESCAPE") return "";
  return key.length === 1 ? key : null;
}

const SHIFT_ENTER_RAW_INPUTS = [
  "[13;2u",
  "[13;2~",
  "[27;2;13~",
  "[27;2;10~",
];

export function shouldSuppressRawTerminalInput(
  suppressTerminalEnterOnAttach: boolean,
  previous: { key: string; at: number } | null,
  raw: string,
): boolean {
  if (raw.length === 0) return false;
  if (suppressTerminalEnterOnAttach && (raw === "\r" || raw === "\n" || raw === "\r\n")) return true;
  if (!previous || Date.now() - previous.at >= 30) return false;
  if (raw === previous.key) return true;
  return raw.length <= 4 && raw.split("").every((char) => char === previous.key);
}

export function inputToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function positionFrameRows(frame: string): string {
  return frame
    .split("\n")
    .map((line, index) => `[${index + 1};1H${line}`)
    .join("");
}
