export interface TerminalSize {
  columns: number;
  rows: number;
}

export function canUseInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");
}

export function getTerminalSize(): TerminalSize {
  return {
    columns: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 40,
  };
}

export function enterAlternateScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
}

export function exitAlternateScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}
