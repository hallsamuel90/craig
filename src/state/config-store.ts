import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigConfig } from "../types/config.js";
import type { CraigPaths } from "./craig-paths.js";
import { RUNNER_IDS } from "../services/runner-profiles.js";

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

export async function writeCraigConfig(paths: CraigPaths, config: CraigConfig): Promise<void> {
  validateCraigConfig(config, paths.configFile);
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function validateCraigConfig(value: unknown, filePath: string): CraigConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Craig config at ${filePath} is invalid. Expected a JSON object.`);
  }

  const candidate = value as CraigConfig;

  if (candidate.runners !== undefined) {
    if (typeof candidate.runners !== "object" || candidate.runners === null || Array.isArray(candidate.runners)) {
      throw new Error(`Craig config at ${filePath} is invalid. "runners" must be an object.`);
    }

    for (const [runner, runnerConfig] of Object.entries(candidate.runners)) {
      if (!(RUNNER_IDS as readonly string[]).includes(runner)) {
        throw new Error(
          `Craig config at ${filePath} is invalid. "runners.${runner}" is not supported. Expected one of: ${RUNNER_IDS.join(", ")}.`,
        );
      }

      if (typeof runnerConfig !== "object" || runnerConfig === null || Array.isArray(runnerConfig)) {
        throw new Error(`Craig config at ${filePath} is invalid. "runners.${runner}" must be an object.`);
      }

      const settings = runnerConfig as { enabled?: unknown; path?: unknown };
      if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
        throw new Error(`Craig config at ${filePath} is invalid. "runners.${runner}.enabled" must be a boolean.`);
      }

      if (settings.path !== undefined && (typeof settings.path !== "string" || settings.path.trim().length === 0)) {
        throw new Error(`Craig config at ${filePath} is invalid. "runners.${runner}.path" must be a non-empty string.`);
      }
    }
  }

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

  if (candidate.github !== undefined) {
    if (typeof candidate.github !== "object" || candidate.github === null) {
      throw new Error(`Craig config at ${filePath} is invalid. "github" must be an object.`);
    }

    if (
      candidate.github.mergeMethod !== undefined &&
      candidate.github.mergeMethod !== "merge" &&
      candidate.github.mergeMethod !== "rebase" &&
      candidate.github.mergeMethod !== "squash"
    ) {
      throw new Error(
        `Craig config at ${filePath} is invalid. "github.mergeMethod" must be "merge", "rebase", or "squash".`,
      );
    }

    if (
      candidate.github.watchIntervalSeconds !== undefined &&
      (!Number.isInteger(candidate.github.watchIntervalSeconds) ||
        candidate.github.watchIntervalSeconds <= 0)
    ) {
      throw new Error(
        `Craig config at ${filePath} is invalid. "github.watchIntervalSeconds" must be a positive integer.`,
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
