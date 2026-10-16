import type { RunnerType } from "../domain/config/index.js";

export function buildEmbeddedAgentCommand(command: string[], runner: RunnerType): string[] {
  if (runner !== "codex") return command;
  const [executable = "codex", ...args] = command;
  const flags = ["--no-alt-screen", "--no-daemon"].filter((flag) => !args.includes(flag));
  return [executable, ...flags, ...args];
}
