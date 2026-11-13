import type { Terminal } from "@xterm/headless";

const SCROLL_UP_SEQUENCE = new RegExp(`^${String.fromCharCode(27)}\\[(\\d*)S$`);

// xterm's CSI S removes rows instead of retaining them in scrollback. Codex
// uses it to grow its inline transcript above a protected composer. Line feeds
// at the region's bottom produce the same screen and retain the departing rows.
export class TerminalScrollbackWriter {
  private top = 0;
  private bottom: number | null = null;
  private originMode = false;
  private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";
  private pending = "";
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly terminal: Terminal) {
    terminal.onResize(() => {
      this.top = 0;
      this.bottom = null;
    });
    terminal.parser.registerCsiHandler({ final: "r" }, (params) => {
      if (terminal.buffer.active.type !== "normal") return false;
      const top = Number(params[0] || 1) - 1;
      const bottom = Math.min(Number(params[1] || terminal.rows), terminal.rows) - 1;
      if (top >= 0 && top < bottom && bottom < terminal.rows) {
        this.top = top;
        this.bottom = bottom;
      }
      return false;
    });
    for (const final of ["h", "l"]) {
      terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (terminal.buffer.active.type === "normal" && params.includes(6)) this.originMode = final === "h";
        return false;
      });
    }
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.top = 0;
      this.bottom = null;
      this.originMode = false;
      return false;
    });
    terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      if (terminal.buffer.active.type === "normal") {
        this.top = 0;
        this.bottom = null;
        this.originMode = false;
      }
      return false;
    });
  }

  write(chunk: string): Promise<void> {
    this.queue = this.queue.then(() => this.writeChunk(chunk));
    return this.queue;
  }

  private async writeChunk(chunk: string): Promise<void> {
    let output = "";
    for (const char of chunk) {
      if (this.state === "string" || this.state === "stringEscape") {
        output += char;
        if (char === "\x07" || (this.state === "stringEscape" && char === "\\")) this.state = "text";
        else this.state = char === "\x1b" ? "stringEscape" : "string";
        continue;
      }
      if (this.state === "text") {
        if (char === "\x1b") {
          this.pending = char;
          this.state = "escape";
        } else output += char;
        continue;
      }
      this.pending += char;
      if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else {
          if ("]PX^_".includes(char)) this.state = "string";
          else this.state = "text";
          output += this.pending;
          this.pending = "";
        }
        continue;
      }
      if (char < "@" || char > "~") continue;
      const sequence = this.pending;
      this.pending = "";
      this.state = "text";
      const scroll = SCROLL_UP_SEQUENCE.exec(sequence);
      if (!scroll) {
        output += sequence;
        continue;
      }
      await this.writeRaw(output);
      output = "";
      await this.scrollUp(sequence, Number(scroll[1]) || 1);
    }
    await this.writeRaw(output);
  }

  private async scrollUp(sequence: string, count: number): Promise<void> {
    const terminal = this.terminal;
    if (terminal.buffer.active.type !== "normal" || this.top !== 0) {
      await this.writeRaw(sequence);
      return;
    }
    const bottom = Math.min(this.bottom ?? terminal.rows - 1, terminal.rows - 1);
    const { cursorX, cursorY } = terminal.buffer.active;
    const lines = Math.min(count, bottom + 1);
    const disableOrigin = this.originMode ? "\x1b[?6l" : "";
    const enableOrigin = this.originMode ? "\x1b[?6h" : "";
    await this.writeRaw(`${disableOrigin}\x1b[${bottom + 1};1H${"\n".repeat(lines)}${enableOrigin}\x1b[${cursorY + 1};${cursorX + 1}H`);
  }

  private writeRaw(text: string): Promise<void> {
    if (!text) return Promise.resolve();
    return new Promise((resolve) => this.terminal.write(text, resolve));
  }
}
