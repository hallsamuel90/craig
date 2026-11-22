import { createRequire } from "node:module";
import type * as NodePty from "node-pty";

import type { TerminalStatus, TerminalViewState } from "../state.js";
import type { TerminalEmulator, TerminalEmulatorFactory, TerminalScreenRow, TerminalSize } from "../terminal-emulator.js";
import { createTerminalEmulator } from "../terminal-emulator.js";
import { requireExecutablePath, withDefaultCommandPath } from "../../shared/command-path.js";
import type { PtyActivitySnapshot } from "../../domain/agent/index.js";
import type { RunnerType } from "../../domain/config/index.js";
import type { AgentCapabilitySession } from "../../domain/orchestration/index.js";
import { findRunnerStartupBlocker } from "../../shell/prompt-delivery.js";

export type PtySize = TerminalSize;

export interface PtySessionSpec {
  cwd: string;
  command: string[];
  env?: Record<string, string | undefined>;
}

export type PtyViewInvalidation =
  | { tabId: string; kind: "full" }
  | { tabId: string; kind: "rows"; rowIndices: number[] };

/* eslint-disable no-unused-vars */
export interface PtyRuntimeOptions {
  workspaceRoot: string;
  shell?: string;
  env?: Record<string, string | undefined>;
  spawn?: typeof NodePty.spawn;
  createEmulator?: TerminalEmulatorFactory;
  onUpdate?: (invalidation: PtyViewInvalidation) => void;
  onActivity?: (snapshot: PtyActivitySnapshot) => void;
  onActivityRemoved?: (tabId: string) => void;
  activityEnabled?: boolean;
  resolveSessionSpec?: (taskId: string, tabId: string) => PtySessionSpec;
}
/* eslint-enable no-unused-vars */

interface PtySession {
  capabilityToken: string | undefined;
  taskId: string;
  tabId: string;
  pty: NodePty.IPty;
  terminal: TerminalEmulator;
  status: TerminalStatus;
  error: string | null;
  disposables: NodePty.IDisposable[];
  scrollbackLines: number;
  rows: TerminalScreenRow[];
  renderedScrollbackLines: number | null;
  screenDirty: boolean;
  lastActivityAt: number;
  exitCode: number | null;
  disposed: boolean;
}

const require = createRequire(import.meta.url);
const CONTROL_KEY_PATTERN = /^CTRL_([A-Z])$/;
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
  private readonly activitySnapshots = new Map<string, PtyActivitySnapshot>();
  private readonly shell: string;
  private readonly env: Record<string, string | undefined>;
  private readonly spawn: typeof NodePty.spawn | undefined;
  private readonly createEmulator: TerminalEmulatorFactory;
  private readonly onUpdate: PtyRuntimeOptions["onUpdate"];
  private readonly onActivity: PtyRuntimeOptions["onActivity"];
  private readonly onActivityRemoved: PtyRuntimeOptions["onActivityRemoved"];
  private activityEnabled: boolean;
  private readonly resolveSessionSpec: NonNullable<PtyRuntimeOptions["resolveSessionSpec"]>;
  private attachedTabId: string | null = null;

  constructor(options: PtyRuntimeOptions) {
    this.shell = options.shell ?? process.env.SHELL ?? "/bin/zsh";
    this.env = options.env ?? process.env;
    this.spawn = options.spawn;
    this.createEmulator = options.createEmulator ?? createTerminalEmulator;
    this.onUpdate = options.onUpdate;
    this.onActivity = options.onActivity;
    this.onActivityRemoved = options.onActivityRemoved;
    this.activityEnabled = options.activityEnabled ?? true;
    this.resolveSessionSpec = options.resolveSessionSpec ?? (() => ({ cwd: options.workspaceRoot, command: [] }));
  }

  ensureSession(taskId: string, tabId: string, size: PtySize, specOverride?: PtySessionSpec, emulatorFactory?: TerminalEmulatorFactory): TerminalViewState {
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

    let session: PtySession;
    try {
      session = this.createSession(taskId, tabId, size, specOverride, emulatorFactory);
    } catch (error) {
      this.recordActivity({
        taskId,
        tabId,
        sessionState: "failed",
        lastActivityAt: Date.now(),
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.sessions.set(tabId, session);
    this.notifyActivity(session);
    this.attachedTabId = tabId;
    return this.getViewState(tabId);
  }

  getRunningAgentCapabilities(): AgentCapabilitySession[] {
    return [...this.sessions.values()].flatMap((session) =>
      session.status === "running" && session.capabilityToken
        ? [{ taskId: session.taskId, agentTabId: session.tabId, capabilityToken: session.capabilityToken }]
        : []);
  }

  write(input: string): void {
    const session = this.getAttachedSession();
    if (!session || session.status !== "running") {
      return;
    }

    session.pty.write(input);
    if (input.includes("\r") || input.includes("\n")) {
      this.touchActivity(session);
    }
  }

  writeKey(key: string): void {
    const terminal = this.getAttachedSession()?.terminal;
    const input = terminal?.encodeKey ? terminal.encodeKey(key) : mapKeyToPtyInput(key);
    if (input !== null) {
      this.write(input);
    }
  }

  hasRunningSession(tabId: string): boolean {
    return this.sessions.get(tabId)?.status === "running";
  }

  writeToSession(tabId: string, input: string): void {
    const session = this.sessions.get(tabId);
    if (!session || session.status !== "running") {
      throw new Error(`Agent tab ${tabId} is not running.`);
    }
    session.pty.write(input);
    this.touchActivity(session);
  }

  scrollViewport(lines: number): void {
    const session = this.getAttachedSession();
    if (!session || session.disposed || lines === 0) {
      return;
    }

    const maxScrollback = session.terminal.getScrollbackLength();
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

  getActivitySnapshots(): PtyActivitySnapshot[] {
    return [...this.activitySnapshots.values()];
  }

  setActivityEnabled(enabled: boolean): void {
    if (this.activityEnabled === enabled) {
      return;
    }
    this.activityEnabled = enabled;
    if (!enabled) {
      return;
    }
    for (const session of this.sessions.values()) {
      this.notifyActivity(session);
    }
  }

  disposeSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session) {
      disposeSession(session);
      this.sessions.delete(tabId);
    }
    this.removeActivity(tabId);
    if (this.attachedTabId === tabId) {
      this.attachedTabId = null;
    }
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      disposeSession(session);
    }

    this.sessions.clear();
    for (const tabId of this.activitySnapshots.keys()) {
      this.onActivityRemoved?.(tabId);
    }
    this.activitySnapshots.clear();
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
      rows: getRenderedRows(session),
      error: session.error,
      scrolledBack: session.scrollbackLines > 0,
    };
  }

  getStartupBlocker(tabId: string, runner: RunnerType): string | null {
    const session = this.sessions.get(tabId);
    if (!session || session.disposed) return null;
    return findRunnerStartupBlocker(runner, session.terminal.getActiveScreenText());
  }

  private createSession(taskId: string, tabId: string, size: PtySize, specOverride?: PtySessionSpec, emulatorFactory = this.createEmulator): PtySession {
    const spawn = this.spawn ?? loadNodePty().spawn;
    const spec = specOverride ?? this.resolveSessionSpec(taskId, tabId);
    const env = withDefaultCommandPath({ ...this.env, ...(spec.env ?? {}) });
    const { executable, args } = resolveSpawnCommand(this.shell, spec.command, { cwd: spec.cwd, env });
    let pty: NodePty.IPty | undefined;
    const terminal = emulatorFactory(size, { onReply: (data) => pty?.write(data) });
    try {
      pty = spawn(executable, args, {
        name: "xterm-256color",
        cols: size.columns,
        rows: size.rows,
        cwd: spec.cwd,
        env: toPtyEnv(env),
      });
    } catch (error) {
      terminal.dispose();
      throw error;
    }
    const session: PtySession = {
      capabilityToken: spec.env?.CRAIG_AGENT_CAPABILITY,
      taskId,
      tabId,
      pty,
      terminal,
      status: "running",
      error: null,
      disposables: [],
      scrollbackLines: 0,
      rows: [],
      renderedScrollbackLines: null,
      screenDirty: true,
      lastActivityAt: Date.now(),
      exitCode: null,
      disposed: false,
    };

    session.disposables.push(
      pty.onData((chunk) => {
        if (session.disposed) return;
        this.touchActivity(session);
        this.writeOutput(session, chunk);
      }),
    );
    session.disposables.push(
      pty.onExit((event) => {
        if (session.disposed) return;
        session.status = "exited";
        session.exitCode = event.exitCode;
        session.lastActivityAt = Date.now();
        this.notifyActivity(session);
        this.writeOutput(session, `\r\n[process exited ${event.exitCode}]`);
      }),
    );

    return session;
  }

  private writeOutput(session: PtySession, chunk: string): void {
    let writing: Promise<void>;
    try { writing = session.terminal.write(chunk); }
    catch (error) { writing = Promise.reject(error); }
    void writing.then(() => {
      if (session.disposed || this.sessions.get(session.tabId) !== session) return;
      session.screenDirty = true;
      this.onUpdate?.({ tabId: session.tabId, kind: "full" });
    }, (error: unknown) => {
      if (session.disposed || this.sessions.get(session.tabId) !== session) return;
      session.status = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      session.rows = [];
      session.scrollbackLines = 0;
      session.renderedScrollbackLines = 0;
      session.screenDirty = false;
      session.lastActivityAt = Date.now();
      disposeSession(session);
      this.notifyActivity(session);
      this.onUpdate?.({ tabId: session.tabId, kind: "full" });
    });
  }

  private getAttachedSession(): PtySession | null {
    return this.attachedTabId ? this.sessions.get(this.attachedTabId) ?? null : null;
  }

  private touchActivity(session: PtySession): void {
    session.lastActivityAt = Date.now();
    if (this.activityEnabled) {
      this.notifyActivity(session);
    }
  }

  private notifyActivity(session: PtySession): void {
    if (!this.activityEnabled) {
      return;
    }
    this.recordActivity(this.buildActivitySnapshot(session));
  }

  private recordActivity(snapshot: PtyActivitySnapshot): void {
    if (!this.activityEnabled) {
      return;
    }
    this.activitySnapshots.set(snapshot.tabId, snapshot);
    this.onActivity?.(snapshot);
  }

  private removeActivity(tabId: string): void {
    if (!this.activitySnapshots.delete(tabId)) {
      return;
    }
    this.onActivityRemoved?.(tabId);
  }

  private buildActivitySnapshot(session: PtySession): PtyActivitySnapshot {
    return {
      taskId: session.taskId,
      tabId: session.tabId,
      sessionState: session.status === "failed" ? "failed" : session.status === "exited" ? "exited" : "running",
      lastActivityAt: session.lastActivityAt,
      exitCode: session.exitCode,
      error: session.error,
    };
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
  if (session.disposed) return;
  resizePtySafely(session.pty, size);
  session.terminal.resize(size);
  session.screenDirty = true;
}

function getRenderedRows(session: PtySession): TerminalScreenRow[] {
  if (session.screenDirty || session.renderedScrollbackLines !== session.scrollbackLines) {
    session.rows = session.terminal.renderRows(session.scrollbackLines);
    session.renderedScrollbackLines = session.scrollbackLines;
    session.screenDirty = false;
  }

  return session.rows;
}

function disposeSession(session: PtySession): void {
  if (session.disposed) return;
  session.disposed = true;
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
