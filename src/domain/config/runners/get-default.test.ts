import { describe, expect, test } from "vitest";
import { getDefault } from "./get-default.js";

describe("getDefault", () => {
  test("returns codex when enabled", () => {
    expect(getDefault()).toBe("codex");
  });

  test("returns first enabled runner when codex is disabled", () => {
    expect(getDefault({ runners: { codex: { enabled: false } } })).toBe("cursor");
  });

  test("throws when all runners are disabled", () => {
    const config = { runners: { codex: { enabled: false }, cursor: { enabled: false }, claude: { enabled: false } } };
    expect(() => getDefault(config)).toThrow("No runners are enabled");
  });
});
