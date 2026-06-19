import { describe, expect, test } from "vitest";
import { getDisplayName } from "./get-display-name.js";

describe("getDisplayName", () => {
  test.each([
    ["codex", "Codex"],
    ["cursor", "Cursor"],
    ["claude", "Claude"],
  ] as const)("%s returns %s", (runner, name) => {
    expect(getDisplayName(runner)).toBe(name);
  });
});
