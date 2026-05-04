import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as NodePty from "node-pty";
import type { Terminal } from "@xterm/headless";

import { getCraigPaths } from "../state/craig-paths.js";
import type { MockTaskId, TerminalStatus, TerminalViewState } from "./state.js";
import {
  createTerminalEmulator,
  renderTerminalScreenRows,
  resizeTerminalEmulator,
  writeTerminalEmulator,
} from "./terminal-emulator.js";

export interface PtySize {
  columns: number;
  rows: number;
}

/* eslint-disable no-unused-vars */
export interface PtyRuntimeOptions {
  workspaceRoot: string;
  shell?: string;
  env?: Record<string, string | undefined>;
  spawn?: typeof NodePty.spawn;
  onUpdate?: () => void;
  resolveTaskCwd?: (...args: [MockTaskId]) => string;
}
/* eslint-enable no-unused-vars */

interface PtySession {
  taskId: MockTaskId;
  pty: NodePty.IPty;
  terminal: Terminal;
  status: TerminalStatus;
  error: string | null;
  disposables: NodePty.IDisposable[];
}

const require = createRequire(import.meta.url);
const CONTROL_KEY_PATTERN = /^CTRL_([A-Z])$/;
const SPECIAL_KEY_INPUT: Record<string, string> = {
  ENTER: "\r",
  KP_ENTER: "\r",
  TAB: "\t",
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
  private readonly sessions = new Map<MockTaskId, PtySession>();
  private readonly workspaceRoot: string;
  private readonly shell: string;
  private readonly env: Record<string, string | undefined>;
  private readonly spawn: typeof NodePty.spawn | undefined;
  private readonly onUpdate: (() => void) | undefined;
  /* eslint-disable no-unused-vars */
  private readonly resolveTaskCwd: (...args: [MockTaskId]) => string;
  /* eslint-enable no-unused-vars */
  private attachedTaskId: MockTaskId | null = null;

  constructor(options: PtyRuntimeOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.shell = options.shell ?? process.env.SHELL ?? "/bin/zsh";
    this.env = options.env ?? process.env;
    this.spawn = options.spawn;
    this.onUpdate = options.onUpdate;
    this.resolveTaskCwd = options.resolveTaskCwd ?? ((taskId) => resolveTaskWorktreePath(this.workspaceRoot, taskId));
  }

  ensureSession(taskId: MockTaskId, size: PtySize): TerminalViewState {
    const existing = this.sessions.get(taskId);

    if (existing) {
      if (existing.status !== "running") {
        disposeSession(existing);
        this.sessions.delete(taskId);
      } else {
        this.attachedTaskId = taskId;
        resizeSession(existing, size);
        return this.getViewState(taskId);
      }
    }

    const session = this.createSession(taskId, size);
    this.sessions.set(taskId, session);
    this.attachedTaskId = taskId;
    return this.getViewState(taskId);
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

  resize(size: PtySize): void {
    const session = this.getAttachedSession();
    if (session) {
      resizeSession(session, size);
    }
  }

  detach(): void {
    this.attachedTaskId = null;
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      disposeSession(session);
    }

    this.sessions.clear();
    this.attachedTaskId = null;
  }

  getViewState(taskId: MockTaskId): TerminalViewState {
    const session = this.sessions.get(taskId);

    if (!session) {
      return {
        status: "idle",
        rows: [],
        error: null,
      };
    }

    return {
      status: session.status,
      rows: renderTerminalScreenRows(session.terminal),
      error: session.error,
    };
  }

  private createSession(taskId: MockTaskId, size: PtySize): PtySession {
    const spawn = this.spawn ?? loadNodePty().spawn;
    const terminal = createTerminalEmulator(size);
    const pty = spawn(this.shell, [], {
      name: "xterm-256color",
      cols: size.columns,
      rows: size.rows,
      cwd: this.resolveTaskCwd(taskId),
      env: toPtyEnv(this.env),
    });
    const session: PtySession = {
      taskId,
      pty,
      terminal,
      status: "running",
      error: null,
      disposables: [],
    };

    session.disposables.push(
      pty.onData((chunk) => {
        void writeTerminalEmulator(session.terminal, chunk).then(() => {
          this.onUpdate?.();
        });
      }),
    );
    session.disposables.push(
      pty.onExit((event) => {
        session.status = "exited";
        void writeTerminalEmulator(session.terminal, `\r\n[process exited ${event.exitCode}]`).then(() => {
          this.onUpdate?.();
        });
      }),
    );

    return session;
  }

  private getAttachedSession(): PtySession | null {
    return this.attachedTaskId ? this.sessions.get(this.attachedTaskId) ?? null : null;
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

function resolveTaskWorktreePath(workspaceRoot: string, taskId: MockTaskId): string {
  const taskFile = path.join(getCraigPaths(workspaceRoot).tasksDir, `${taskId}.json`);

  try {
    const parsed = JSON.parse(readFileSync(taskFile, "utf8")) as { worktreePath?: unknown };
    if (typeof parsed.worktreePath === "string" && parsed.worktreePath.length > 0) {
      return parsed.worktreePath;
    }
  } catch {
    return workspaceRoot;
  }

  return workspaceRoot;
}

function resizePtySafely(pty: NodePty.IPty, size: PtySize): void {
  if (size.columns > 0 && size.rows > 0 && (pty.cols !== size.columns || pty.rows !== size.rows)) {
    pty.resize(size.columns, size.rows);
  }
}

function loadNodePty(): typeof NodePty {
  return require("node-pty") as typeof NodePty;
}

function toPtyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const next: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }

  return next;
}
