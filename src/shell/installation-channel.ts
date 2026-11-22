import { isSea } from "node:sea";

export type InstallationChannel = "npm" | "standalone";

// Runtime-owned detection cannot be changed by workspace configuration or PATH.
export function getInstallationChannel(): InstallationChannel {
  return isSea() ? "standalone" : "npm";
}

export function getCraigUpdateNotice(latest: string, channel = getInstallationChannel()): string {
  return channel === "standalone"
    ? `→ v${latest} available · replace the binary; if installed with Homebrew, run brew upgrade craig`
    : `→ v${latest} available`;
}

export function assertAutomaticUpdatesSupported(channel = getInstallationChannel()): void {
  if (channel === "standalone") {
    throw new Error("Standalone Craig updates are manual. Replace the binary; if installed with Homebrew, run brew upgrade craig.");
  }
}
