import { describe, expect, test } from "vitest";
import { getProfile } from "./get-profile.js";

describe("getProfile", () => {
  test.each([
    ["codex", "codex", "Codex"],
    ["cursor", "cursor-agent", "Cursor"],
    ["claude", "claude", "Claude"],
    ["pi", "pi", "Pi"],
  ] as const)("%s has correct executable and displayName", (runner, executable, displayName) => {
    const profile = getProfile(runner);
    expect(profile.id).toBe(runner);
    expect(profile.executable).toBe(executable);
    expect(profile.displayName).toBe(displayName);
  });
});
