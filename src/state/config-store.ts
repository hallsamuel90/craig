import { readFile } from "node:fs/promises";

import type { CraigConfig } from "../types/config.js";
import type { CraigPaths } from "./craig-paths.js";

export async function readCraigConfig(paths: CraigPaths): Promise<CraigConfig> {
  try {
    const raw = await readFile(paths.configFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    return validateCraigConfig(parsed, paths.configFile);
  } catch (error) {
    if (isFileMissingError(error)) {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(
        `Craig config at ${paths.configFile} is malformed. Remove or repair the file before rerunning Craig.`,
      );
    }

    throw error;
  }
}

function validateCraigConfig(value: unknown, filePath: string): CraigConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Craig config at ${filePath} is invalid. Expected a JSON object.`);
  }

  const candidate = value as CraigConfig;

  if (candidate.checks !== undefined) {
    if (
      typeof candidate.checks !== "object" ||
      candidate.checks === null ||
      !Array.isArray(candidate.checks.commands) ||
      !candidate.checks.commands.every((command) => typeof command === "string")
    ) {
      throw new Error(
        `Craig config at ${filePath} is invalid. "checks.commands" must be an array of strings.`,
      );
    }
  }

  if (candidate.open !== undefined) {
    if (
      typeof candidate.open !== "object" ||
      candidate.open === null ||
      !Array.isArray(candidate.open.command) ||
      !candidate.open.command.every((entry) => typeof entry === "string")
    ) {
      throw new Error(
        `Craig config at ${filePath} is invalid. "open.command" must be an array of strings.`,
      );
    }
  }

  return candidate;
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
