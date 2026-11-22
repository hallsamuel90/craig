import { describe, expect, test, vi } from "vitest";
import { getCraigUpdateNotice, getInstallationChannel } from "./installation-channel.js";
import { installCraigUpdate, restartCraig } from "./craig-update.js";
import { daemonSpawnCommand } from "./pty-daemon-process.js";

describe("installation channels", () => {
  test("normal Node remains an npm/source installation", () => {
    expect(getInstallationChannel()).toBe("npm");
    expect(getCraigUpdateNotice("1.2.3", "npm")).toBe("→ v1.2.3 available");
  });
  test("standalone guidance is manual and does not guess Homebrew ownership", () => {
    expect(getCraigUpdateNotice("1.2.3", "standalone")).toContain("if installed with Homebrew");
  });
  test("standalone update and restart never invoke npm or spawn an npm bundle", async () => {
    const deps = { runCommand: vi.fn(), access: vi.fn(), spawn: vi.fn(), getInstallationChannel: () => "standalone" as const };
    await expect(installCraigUpdate("1.2.3", deps)).rejects.toThrow("updates are manual");
    await expect(restartCraig({ argv: ["--help"], cwd: "/task", env: {} }, deps)).rejects.toThrow("updates are manual");
    expect(deps.runCommand).not.toHaveBeenCalled();
    expect(deps.access).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  test("standalone daemon reexec does not pass the extracted JS entrypoint or Node flags", () => {
    expect(daemonSpawnCommand("/task", { channel: "standalone", execPath: "/bin/craig", argv: ["craig", "/cache/cli.js"], execArgv: ["--inspect"] }))
      .toEqual({ command: "/bin/craig", args: ["__craig-daemon", "/task"] });
  });
  test("npm daemon keeps its Node flags and JS entrypoint", () => {
    expect(daemonSpawnCommand("/task", { channel: "npm", execPath: "/bin/node", argv: ["node", "/npm/cli.js"], execArgv: ["--no-warnings"] }))
      .toEqual({ command: "/bin/node", args: ["--no-warnings", "/npm/cli.js", "__craig-daemon", "/task"] });
  });
});
