import type { RunnerType } from "../domain/config/index.js";

export function encodeRunnerPrompt(runner: RunnerType, prompt: string): string {
  switch (runner) {
    case "codex":
    case "cursor":
    case "claude":
      return `\u001b[200~${prompt}\u001b[201~\r`;
    default:
      return assertNever(runner);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported prompt-delivery runner: ${String(value)}`);
}
