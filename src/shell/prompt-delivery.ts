import type { RunnerType } from "../domain/config/index.js";

export interface RunnerPromptSubmission {
  paste: string;
  submit: string;
  submitDelayMs: number;
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function buildRunnerPromptSubmission(runner: RunnerType, prompt: string): RunnerPromptSubmission {
  switch (runner) {
    case "codex": return terminalSubmission(prompt, 50);
    case "cursor": return terminalSubmission(prompt, 50);
    case "claude": return terminalSubmission(prompt, 50);
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
