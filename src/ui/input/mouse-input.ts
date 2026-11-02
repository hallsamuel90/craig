import type { TerminalRuntime } from "../app-context.js";

const ESC = 0x1b;

// terminal-kit parses each stdin chunk independently. Reassemble mouse reports
// before its parser, so a partial SGR/X11 report cannot become printable keys.
export class MouseInputBuffer {
  private pending = Buffer.alloc(0);
  private timer: ReturnType<typeof setTimeout> | null = null;

  // eslint-disable-next-line no-unused-vars
  constructor(private readonly emit: (chunk: Buffer) => void) {}

  write(chunk: Buffer): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const input = Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    let start = 0;
    let index = 0;
    while (index < input.length) {
      if (input[index] !== ESC) { index++; continue; }
      const rest = input.subarray(index);
      const ambiguous = rest.length === 1 || (rest.length === 2 && rest[1] === 0x5b);
      const mouse = rest[1] === 0x5b && (rest[2] === 0x3c || rest[2] === 0x4d);
      if (!ambiguous && !mouse) { index++; continue; }
      if (index > start) this.emit(input.subarray(start, index));
      if (ambiguous) {
        this.pending = rest;
        this.timer = setTimeout(() => {
          this.timer = null;
          const pending = this.pending;
          this.pending = Buffer.alloc(0);
          if (pending.length) this.emit(pending);
        }, 30);
        return;
      }
      if (rest[2] === 0x4d) {
        const interrupt = rest.subarray(3, 6).findIndex((byte) => byte < 0x20);
        if (interrupt !== -1) { index += 3 + interrupt; start = index; continue; }
        if (rest.length < 6) { this.pending = rest; return; }
        this.emit(rest.subarray(0, 6));
        index += 6;
      } else {
        const end = rest.findIndex((byte, i) => i >= 3 && (byte === 0x4d || byte === 0x6d || byte < 0x20));
        if (end === -1) {
          // A valid report is short. Drop malformed/unbounded reports instead
          // of feeding their numeric payload to a nested application.
          if (rest.length <= 64) this.pending = rest;
          return;
        }
        const report = rest.subarray(0, end + 1);
        if (/^\d+;\d+;\d+[Mm]$/.test(report.subarray(3).toString("ascii"))) this.emit(report);
        index += end + ((rest[end] ?? 0) < 0x20 ? 0 : 1);
      }
      start = index;
    }
    if (start < input.length) this.emit(input.subarray(start));
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = Buffer.alloc(0);
  }
}

export function installMouseInputBuffer(terminal: TerminalRuntime): { reset(): void; dispose(): void } {
  const original = terminal.onStdin;
  const buffer = new MouseInputBuffer((chunk) => original?.call(terminal, chunk));
  if (original) terminal.onStdin = (chunk) => buffer.write(chunk);
  return {
    reset: () => buffer.reset(),
    dispose: () => {
      buffer.reset();
      if (original) terminal.onStdin = original;
    },
  };
}
