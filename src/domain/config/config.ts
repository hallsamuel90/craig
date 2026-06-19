import type { CraigPaths } from "../../state/craig-paths.js";
import { RUNNER_IDS } from "./runners.js";
import type { CraigConfig } from "./types.js";
import { readConfigFile, writeConfigFile } from "./adapters/config-store.js";

export async function load(paths: CraigPaths): Promise<CraigConfig> {
  const raw = await readConfigFile(paths.configFile);

  if (!raw) {
    return {};
  }

  if (raw.trimStart()[0] !== "{") {
    throw new Error(
      `Craig config at ${paths.configFile} is malformed. Remove or repair the file before rerunning Craig.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Craig config at ${paths.configFile} is malformed. Remove or repair the file before rerunning Craig.`,
    );
  }

  return validate(parsed, paths.configFile);
}

export async function save(paths: CraigPaths, config: CraigConfig): Promise<void> {
  validate(config, paths.configFile);
  await writeConfigFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

function validate(value: unknown, filePath: string): CraigConfig {
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
