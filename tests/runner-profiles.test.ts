import { describe, expect, test } from "vitest";

import { buildRunnerCommand, getRunnerProfile, parseRunnerType } from "../src/services/runner-profiles.js";

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
  });

  test("validates runner ids and defaults empty values to codex", () => {
    expect(parseRunnerType(undefined)).toBe("codex");
    expect(parseRunnerType("claude")).toBe("claude");
    expect(() => parseRunnerType("vim")).toThrow(/Unsupported runner/);
  });
});
