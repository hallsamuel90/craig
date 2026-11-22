import { spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../shared/exec.js";
import { assertAutomaticUpdatesSupported, getInstallationChannel } from "./installation-channel.js";

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const CRAIG_RESTART_EXIT_CODE = 75;

export async function installCraigUpdate(
  version: string,
  deps: { runCommand: typeof runCommand; getInstallationChannel?: typeof getInstallationChannel } = { runCommand },
): Promise<void> {
  assertAutomaticUpdatesSupported((deps.getInstallationChannel ?? getInstallationChannel)());
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`Cannot install invalid Craig version: ${version}`);
  }

  await deps.runCommand("npm", ["install", "--global", `craig-cli@${version}`]);
}

export interface RestartCraigOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  nodePath?: string;
}

// eslint-disable-next-line no-unused-vars
type SpawnCraigProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export async function restartCraig(
  options: RestartCraigOptions,
  deps: { runCommand: typeof runCommand; access: typeof access; spawn: SpawnCraigProcess; getInstallationChannel?: typeof getInstallationChannel } = {
    runCommand,
    access,
    spawn: spawnChildProcess,
  },
): Promise<number> {
  assertAutomaticUpdatesSupported((deps.getInstallationChannel ?? getInstallationChannel)());
  const { stdout } = await deps.runCommand("npm", ["root", "--global"], {
    cwd: options.cwd,
    env: options.env,
  });
  const globalModulesRoot = stdout.trim();
  if (!globalModulesRoot) {
    throw new Error("npm did not report its global package directory");
  }

  const cliBundle = path.join(globalModulesRoot, "craig-cli", "dist", "cli.js");
  await deps.access(cliBundle);
  const child = deps.spawn(options.nodePath ?? process.execPath, [cliBundle, ...options.argv], {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });

  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
