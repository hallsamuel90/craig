import { describe, expect, test } from "vitest";
import { getConfiguredProfile } from "./get-configured-profile.js";

describe("getConfiguredProfile", () => {
  test("returns default profile when no config override", () => {
    expect(getConfiguredProfile("codex").executable).toBe("codex");
  });

  test("uses configured path when provided", () => {
    const profile = getConfiguredProfile("codex", { runners: { codex: { path: "/usr/local/bin/codex" } } });
    expect(profile.executable).toBe("/usr/local/bin/codex");
  });

  test("falls back to default when configured path is whitespace", () => {
    const profile = getConfiguredProfile("codex", { runners: { codex: { path: "   " } } });
    expect(profile.executable).toBe("codex");
  });
});
