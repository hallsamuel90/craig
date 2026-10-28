import type { RunnerType } from "../domain/config/index.js";

export interface RunnerPromptSubmission {
  paste: string;
  submit: string;
  submitDelayMs: number;
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function findRunnerStartupBlocker(runner: RunnerType, screen: string): string | null {
  if (runner === "codex" && /Trust this folder\?/i.test(screen) && /Trust and continue/i.test(screen)) {
    return "Codex requires folder trust before it can receive work.";
  }
  if (runner === "codex" && /Update available/i.test(screen) && /Update now|Install update/i.test(screen)) {
    return "Codex is displaying an update dialog instead of the agent input.";
  }
  if (runner === "cursor" && /Press any key to log in/i.test(screen)) {
    return "Cursor requires authentication before it can receive work.";
  }
  return null;
}

export function buildRunnerPromptSubmission(runner: RunnerType, prompt: string): RunnerPromptSubmission {
  switch (runner) {
    case "codex": return terminalSubmission(prompt, 50);
    case "cursor": return terminalSubmission(prompt, 50);
    case "claude": return terminalSubmission(prompt, 50);
    case "pi": return terminalSubmission(prompt, 50);
    default:
      return assertNever(runner);
  }
}

function terminalSubmission(prompt: string, submitDelayMs: number): RunnerPromptSubmission {
  return {
    paste: `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`,
    submit: "\r",
    submitDelayMs,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported prompt-delivery runner: ${String(value)}`);
}
