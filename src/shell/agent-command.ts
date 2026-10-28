import type { RunnerType } from "../domain/config/index.js";

export function buildEmbeddedAgentCommand(command: string[], runner: RunnerType): string[] {
  if (runner !== "codex") return command;
  const [executable = "codex", ...args] = command;
  const flags = ["--no-alt-screen", "--no-daemon"].filter((flag) => !args.includes(flag));
  // A startup update dialog can consume a durably dispatched task prompt as a
  // menu selection. Embedded sessions must reach the agent input directly.
  const updateSetting = "check_for_update_on_startup=false";
  const configuration = args.includes(updateSetting) ? [] : ["-c", updateSetting];
  return [executable, ...flags, ...args, ...configuration];
}
