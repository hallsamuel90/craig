import { emitKeypressEvents } from "node:readline";

export interface TerminalSize {
  columns: number;
  rows: number;
}

export type TerminalEvent =
  | { kind: "keypress"; text: string; ctrl: boolean; meta: boolean; shift: boolean; name?: string }
  | { kind: "resize" };

export interface TerminalSession {
  getSize(): TerminalSize;
  // eslint-disable-next-line no-unused-vars
  render(frame: string): void;
  readEvent(): Promise<TerminalEvent>;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

// eslint-disable-next-line no-unused-vars
type EventResolver = (value: TerminalEvent) => void;

export function canUseInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");
}

export function createTerminalSession(): TerminalSession {
  return new NodeTerminalSession();
}

class NodeTerminalSession implements TerminalSession {
  private readonly queue: TerminalEvent[] = [];
  private readonly onKeypress = (
    text: string,
    key: { ctrl?: boolean; meta?: boolean; shift?: boolean; name?: string },
  ) => {
    const event: TerminalEvent = {
      kind: "keypress",
      text,
      ctrl: Boolean(key.ctrl),
      meta: Boolean(key.meta),
      shift: Boolean(key.shift),
      ...(key.name ? { name: key.name } : {}),
    };

    this.pushEvent(event);
  };
  private readonly onResize = () => {
    this.pushEvent({ kind: "resize" });
  };
  private pendingResolver: EventResolver | null = null;
  private suspended = false;

  constructor() {
    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", this.onKeypress);
    process.stdout.on("resize", this.onResize);
    this.resume();
  }

  getSize(): TerminalSize {
    return {
      columns: process.stdout.columns ?? 120,
      rows: process.stdout.rows ?? 40,
    };
  }

  render(frame: string): void {
    process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${frame}`);
  }

  async readEvent(): Promise<TerminalEvent> {
    if (this.queue.length > 0) {
      return this.queue.shift() as TerminalEvent;
    }

    return new Promise<TerminalEvent>((resolve) => {
      this.pendingResolver = resolve;
    });
  }

  suspend(): void {
    if (this.suspended) {
      return;
    }

    this.suspended = true;

    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }

    process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
  }

  resume(): void {
    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }

    process.stdin.resume();
    this.suspended = false;
  }

  dispose(): void {
    process.stdin.off("keypress", this.onKeypress);
    process.stdout.off("resize", this.onResize);

    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }

    process.stdout.write("\x1b[?25h\x1b[0m\n");
  }

  private pushEvent(event: TerminalEvent): void {
    if (this.pendingResolver) {
      const resolve = this.pendingResolver;
      this.pendingResolver = null;
      resolve(event);
      return;
    }

    this.queue.push(event);
  }
}
