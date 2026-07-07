import { createRequire } from "node:module";
import type * as NodePty from "node-pty";
import type { Terminal } from "@xterm/headless";

import type { TerminalStatus, TerminalViewState } from "../state.js";
import {
  createTerminalEmulator,
  renderTerminalScreenRows,
  resizeTerminalEmulator,
  writeTerminalEmulator,
} from "../terminal-emulator.js";
import { requireExecutablePath, withDefaultCommandPath } from "../../shared/command-path.js";

export interface PtySize {
  columns: number;
  rows: number;
}

export interface PtySessionSpec {
  cwd: string;
  command: string[];
  env?: Record<string, string | undefined>;
}

/* eslint-disable no-unused-vars */
export interface PtyRuntimeOptions {
  workspaceRoot: string;
  shell?: string;
  env?: Record<string, string | undefined>;
  spawn?: typeof NodePty.spawn;
  onUpdate?: (tabId: string) => void;
  resolveSessionSpec?: (taskId: string, tabId: string) => PtySessionSpec;
}
/* eslint-enable no-unused-vars */

interface PtySession {
  taskId: string;
  tabId: string;
  pty: NodePty.IPty;
  terminal: Terminal;
  status: TerminalStatus;
  error: string | null;
  disposables: NodePty.IDisposable[];
  scrollbackLines: number;
}

const require = createRequire(import.meta.url);
const CONTROL_KEY_PATTERN = /^CTRL_([A-Z])$/;
const DEVICE_STATUS_REPORT_QUERY = "\u001B[6n";
const PRIMARY_DEVICE_ATTRIBUTES_QUERY = "\u001B[c";
const KITTY_KEYBOARD_QUERY = "\u001B[?u";
const SPECIAL_KEY_INPUT: Record<string, string> = {
  ENTER: "\r",
  KP_ENTER: "\r",
  SHIFT_ENTER: "\n",
  TAB: "\t",
  SHIFT_TAB: "\x1b[Z",
  BACK_TAB: "\x1b[Z",
  BACKSPACE: "\x7f",
  DELETE: "\x1b[3~",
  ESCAPE: "\x1b",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
  HOME: "\x1b[H",
  END: "\x1b[F",
  PAGE_UP: "\x1b[5~",
  PAGE_DOWN: "\x1b[6~",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
};

export class PtyRuntime {
  private readonly sessions = new Map<string, PtySession>();
  private readonly shell: string;
  private readonly env: Record<string, string | undefined>;
  private readonly spawn: typeof NodePty.spawn | undefined;
  private readonly onUpdate: PtyRuntimeOptions["onUpdate"];
  private readonly resolveSessionSpec: NonNullable<PtyRuntimeOptions["resolveSessionSpec"]>;
  private attachedTabId: string | null = null;

  constructor(options: PtyRuntimeOptions) {
    this.shell = options.shell ?? process.env.SHELL ?? "/bin/zsh";
    this.env = options.env ?? process.env;
    this.spawn = options.spawn;
    this.onUpdate = options.onUpdate;
    this.resolveSessionSpec = options.resolveSessionSpec ?? (() => ({ cwd: options.workspaceRoot, command: [] }));
  }

  ensureSession(taskId: string, tabId: string, size: PtySize, specOverride?: PtySessionSpec): TerminalViewState {
    const existing = this.sessions.get(tabId);

    if (existing) {
      if (existing.status !== "running") {
        disposeSession(existing);
        this.sessions.delete(tabId);
      } else {
        this.attachedTabId = tabId;
        existing.scrollbackLines = 0;
        resizeSession(existing, size);
        return this.getViewState(tabId);
      }
    }

    const session = this.createSession(taskId, tabId, size, specOverride);
    this.sessions.set(tabId, session);
    this.attachedTabId = tabId;
    return this.getViewState(tabId);
  }

  write(input: string): void {
    const session = this.getAttachedSession();
    if (!session || session.status !== "running") {
      return;
    }

    session.pty.write(input);
  }

  writeKey(key: string): void {
    const input = mapKeyToPtyInput(key);
    if (input !== null) {
      this.write(input);
    }
  }

  scrollViewport(lines: number): void {
    const session = this.getAttachedSession();
    if (!session || lines === 0) {
      return;
    }

    const maxScrollback = session.terminal.buffer.active.baseY;
    session.scrollbackLines = Math.max(0, Math.min(maxScrollback, session.scrollbackLines - lines));
  }

  resize(size: PtySize): void {
    const session = this.getAttachedSession();
    if (session) {
      resizeSession(session, size);
    }
  }

  detach(): void {
    this.attachedTabId = null;
  }

  sessionTabIds(): string[] {
    return [...this.sessions.keys()];
  }

  disposeSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) {
      return;
    }

    disposeSession(session);
    this.sessions.delete(tabId);
    if (this.attachedTabId === tabId) {
      this.attachedTabId = null;
    }
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      disposeSession(session);
    }

    this.sessions.clear();
    this.attachedTabId = null;
  }

  getViewState(tabId: string | null): TerminalViewState {
    if (!tabId) {
      return { status: "idle", rows: [], error: null, scrolledBack: false };
    }

    const session = this.sessions.get(tabId);

    if (!session) {
      return { status: "idle", rows: [], error: null, scrolledBack: false };
    }

    return {
      status: session.status,
      rows: renderTerminalScreenRows(session.terminal, session.scrollbackLines),
      error: session.error,
      scrolledBack: session.scrollbackLines > 0,
    };
  }

  private createSession(taskId: string, tabId: string, size: PtySize, specOverride?: PtySessionSpec): PtySession {
    const spawn = this.spawn ?? loadNodePty().spawn;
    const terminal = createTerminalEmulator(size);
    const spec = specOverride ?? this.resolveSessionSpec(taskId, tabId);
    const env = withDefaultCommandPath({ ...this.env, ...(spec.env ?? {}) });
    const { executable, args } = resolveSpawnCommand(this.shell, spec.command, { cwd: spec.cwd, env });
    const pty = spawn(executable, args, {
      name: "xterm-256color",
      cols: size.columns,
      rows: size.rows,
      cwd: spec.cwd,
      env: toPtyEnv(env),
    });
    const session: PtySession = {
      taskId,
      tabId,
      pty,
      terminal,
      status: "running",
      error: null,
      disposables: [],
      scrollbackLines: 0,
    };

    session.disposables.push(
      pty.onData((chunk) => {
        respondToTerminalQueries(pty, chunk);
        void writeTerminalEmulator(session.terminal, chunk).then(() => {
          this.onUpdate?.(session.tabId);
        });
      }),
    );
    session.disposables.push(
      pty.onExit((event) => {
        session.status = "exited";
        void writeTerminalEmulator(session.terminal, `\r\n[process exited ${event.exitCode}]`).then(() => {
          this.onUpdate?.(session.tabId);
        });
      }),
    );

    return session;
  }

  private getAttachedSession(): PtySession | null {
    return this.attachedTabId ? this.sessions.get(this.attachedTabId) ?? null : null;
  }
}

export function mapKeyToPtyInput(key: string): string | null {
  if (key.length === 1) {
    return key;
  }

  const mapped = SPECIAL_KEY_INPUT[key];
  if (mapped !== undefined) {
    return mapped;
  }

  const controlMatch = CONTROL_KEY_PATTERN.exec(key);
  if (controlMatch?.[1]) {
    return String.fromCharCode(controlMatch[1].charCodeAt(0) - 64);
  }

  return null;
}

function resizeSession(session: PtySession, size: PtySize): void {
  resizePtySafely(session.pty, size);
  resizeTerminalEmulator(session.terminal, size);
}

function disposeSession(session: PtySession): void {
  for (const disposable of session.disposables) {
    disposable.dispose();
  }

  session.terminal.dispose();
  session.pty.kill();
}

function resizePtySafely(pty: NodePty.IPty, size: PtySize): void {
  if (size.columns > 0 && size.rows > 0 && (pty.cols !== size.columns || pty.rows !== size.rows)) {
    pty.resize(size.columns, size.rows);
  }
}

function loadNodePty(): typeof NodePty {
  return require("node-pty") as typeof NodePty;
}

function resolveSpawnCommand(
  shell: string,
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): { executable: string; args: string[] } {
  if (command.length === 0) {
    return { executable: shell, args: [] };
  }

  const resolvedCommand = [requireExecutablePath(command[0]!, options), ...command.slice(1)];
  const bootstrap = `${resolvedCommand.map(shellEscape).join(" ")}; exec ${shellEscape(shell)} -l`;
  return { executable: shell, args: ["-lc", bootstrap] };
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toPtyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const next: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      next[key] = value;
    }
  }

  next.TERM = next.TERM ?? "xterm-256color";
  return next;
}

function respondToTerminalQueries(pty: NodePty.IPty, chunk: string): void {
  for (let index = 0; index < countSubstring(chunk, DEVICE_STATUS_REPORT_QUERY); index += 1) {
    pty.write("\u001B[1;1R");
  }

  for (let index = 0; index < countSubstring(chunk, PRIMARY_DEVICE_ATTRIBUTES_QUERY); index += 1) {
    pty.write("\u001B[?1;2c");
  }

  for (let index = 0; index < countSubstring(chunk, KITTY_KEYBOARD_QUERY); index += 1) {
    pty.write("\u001B[?0u");
  }
}

function countSubstring(value: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = value.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }

  return count;
}
