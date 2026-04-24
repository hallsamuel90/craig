/* eslint-disable no-unused-vars */
import { createRequire } from "node:module";

import type { IPty } from "node-pty";

import type { SessionRecord, SessionTerminalSize } from "../types/session.js";

const requireFromHere = createRequire(import.meta.url);

export interface TerminalBridge {
  attach(session: SessionRecord, size: SessionTerminalSize): Promise<void> | void;
  resize(size: SessionTerminalSize): void;
  write(data: string): void;
  detach(): void;
  dispose(): void;
  waitForDetach(): Promise<void>;
}

export function createNodePtyTerminalBridge(): TerminalBridge {
  return new NodePtyTerminalBridge();
}

class NodePtyTerminalBridge implements TerminalBridge {
  private ptyProcess: IPty | null = null;
  private detachPromise: Promise<void> | null = null;
  private resolveDetach: (() => void) | null = null;
  private readonly onData = (buffer: Buffer) => {
    const data = buffer.toString("utf8");

    if (data === "\x1d") {
      this.detach();
      return;
    }

    this.write(data);
  };

  attach(session: SessionRecord, size: SessionTerminalSize): void {
    const { spawn } = requireNodePty();
    this.detachPromise = new Promise<void>((resolve) => {
      this.resolveDetach = resolve;
    });
    this.ptyProcess = spawn("tmux", ["attach-session", "-t", session.sessionName], {
      cols: size.columns,
      rows: size.rows,
      cwd: session.worktreePath,
      name: process.env.TERM ?? "xterm-256color",
      env: process.env,
    });
    this.ptyProcess.onData((data) => {
      process.stdout.write(data);
    });
    this.ptyProcess.onExit(() => {
      this.completeDetach();
    });

    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }

    process.stdin.resume();
    process.stdin.on("data", this.onData);
  }

  resize(size: SessionTerminalSize): void {
    this.ptyProcess?.resize(size.columns, size.rows);
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
  }

  detach(): void {
    this.ptyProcess?.kill();
    this.completeDetach();
  }

  dispose(): void {
    process.stdin.off("data", this.onData);

    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }

    this.ptyProcess?.kill();
    this.ptyProcess = null;
    this.completeDetach();
  }

  async waitForDetach(): Promise<void> {
    await (this.detachPromise ?? Promise.resolve());
  }

  private completeDetach(): void {
    process.stdin.off("data", this.onData);

    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }

    this.ptyProcess = null;

    if (this.resolveDetach) {
      const resolve = this.resolveDetach;
      this.resolveDetach = null;
      resolve();
    }
  }
}

function requireNodePty(): {
  spawn: (
    file: string,
    args: string[],
    options: { cols: number; rows: number; cwd: string; name: string; env: Record<string, string | undefined> },
  ) => IPty;
} {
  try {
    return requireFromHere("node-pty") as {
      spawn: (
        file: string,
        args: string[],
        options: { cols: number; rows: number; cwd: string; name: string; env: Record<string, string | undefined> },
      ) => IPty;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown node-pty error";
    throw new Error(
      `node-pty is unavailable. Approve and build native dependencies before using Craig terminal mode. (${message})`,
    );
  }
}
