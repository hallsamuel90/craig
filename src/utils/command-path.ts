import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const COMMON_COMMAND_DIRS = [
  path.join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export function getCommandSearchPath(env: Record<string, string | undefined> = process.env): string[] {
  return unique([
    ...(env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0),
    ...COMMON_COMMAND_DIRS,
  ]);
}

export function withDefaultCommandPath(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return {
    ...env,
    PATH: getCommandSearchPath(env).join(path.delimiter),
  };
}

export function resolveExecutablePath(
  command: string,
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string | null {
  if (command.includes(path.sep)) {
    const resolved = path.isAbsolute(command) ? command : path.resolve(options.cwd ?? process.cwd(), command);
    return isExecutable(resolved) ? resolved : null;
  }

  for (const dir of getCommandSearchPath(options.env)) {
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function requireExecutablePath(
  command: string,
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string {
  const resolved = resolveExecutablePath(command, options);
  if (resolved) {
    return resolved;
  }

  throw new Error(
    `Command not found: ${command}. Install it or add its directory to PATH. Craig also checks ~/.local/bin, /opt/homebrew/bin, and /usr/local/bin.`,
  );
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
