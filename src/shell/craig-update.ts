import { runCommand } from "../shared/exec.js";

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export async function installCraigUpdate(
  version: string,
  deps: { runCommand: typeof runCommand } = { runCommand },
): Promise<void> {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`Cannot install invalid Craig version: ${version}`);
  }

  await deps.runCommand("npm", ["install", "--global", `craig-cli@${version}`]);
}
