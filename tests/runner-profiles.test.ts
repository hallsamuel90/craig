import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  assertRunnerEnabled,
  buildRunnerCommand,
  getDefaultRunner,
  getEnabledRunnerIds,
  getRunnerProfile,
  parseRunnerType,
} from "../src/services/runner-profiles.js";
import { requireExecutablePath, withDefaultCommandPath } from "../src/utils/command-path.js";

describe("runner profiles", () => {
  test.each([
    ["codex", "Codex", "codex"],
    ["cursor", "Cursor", "cursor-agent"],
    ["claude", "Claude", "claude"],
  ] as const)("resolves the %s runner profile", (runner, displayName, executable) => {
    expect(getRunnerProfile(runner)).toMatchObject({
      id: runner,
      displayName,
      executable,
    });
  });

  test("builds runner launch commands with the prompt as the first argument", () => {
    expect(buildRunnerCommand("codex", "ship it")).toEqual(["codex", "ship it"]);
    expect(buildRunnerCommand("cursor", "ship it")).toEqual(["cursor-agent", "ship it"]);
    expect(buildRunnerCommand("claude", "ship it")).toEqual(["claude", "ship it"]);
    expect(buildRunnerCommand("cursor", "ship it", { runners: { cursor: { path: "/opt/cursor-agent" } } })).toEqual([
      "/opt/cursor-agent",
      "ship it",
    ]);
  });

  test("filters disabled runners and defaults to the first enabled runner", () => {
    const config = {
      runners: {
        codex: { enabled: false },
        cursor: { enabled: true },
        claude: { enabled: false },
      },
    };

    expect(getEnabledRunnerIds(config)).toEqual(["cursor"]);
    expect(getDefaultRunner(config)).toBe("cursor");
    expect(() => assertRunnerEnabled("codex", config)).toThrow(/disabled/);
    expect(() => assertRunnerEnabled("cursor", config)).not.toThrow();
  });

  test("validates runner ids and defaults empty values to codex", () => {
    expect(parseRunnerType(undefined)).toBe("codex");
    expect(parseRunnerType("claude")).toBe("claude");
    expect(() => parseRunnerType("vim")).toThrow(/Unsupported runner/);
  });

  test("resolves executables from the configured command path before shell launch", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "craig-runner-path-"));
    const executable = path.join(tempRoot, "cursor-agent");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    const env = withDefaultCommandPath({ PATH: tempRoot });

    expect(requireExecutablePath("cursor-agent", { env })).toBe(executable);
    expect(() => requireExecutablePath("missing-agent", { env: { PATH: tempRoot } })).toThrow(/Command not found: missing-agent/);
  });
});
