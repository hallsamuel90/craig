import type { AppCommand } from "../types/command.js";

export interface ParsedArgvCommand {
  mode: "interactive" | "command";
  command?: AppCommand;
}

export function parseArgv(argv: string[]): ParsedArgvCommand {
  const trimmedArgv = [...argv];

  while (trimmedArgv[0] === "--") {
    trimmedArgv.shift();
  }

  if (trimmedArgv.length === 0) {
    return { mode: "interactive" };
  }

  if (trimmedArgv.length === 2 && trimmedArgv[0] === "task" && trimmedArgv[1] === "list") {
    return { mode: "command", command: { kind: "listTasks" } };
  }

  throw new Error(`Unsupported command: ${trimmedArgv.join(" ")}\n\n${getHelpText()}`);
}

export function getHelpText(): string {
  return [
    "Craig commands:",
    "  craig              Start the Craig REPL",
    "  craig task list    List known Craig tasks",
    "",
    "REPL commands:",
    "  list",
    "  help",
    "  exit",
  ].join("\n");
}
