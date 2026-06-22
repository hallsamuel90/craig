import { describe, expect, test } from "vitest";
import { getEnabled } from "./get-enabled.js";

describe("getEnabled", () => {
  test("returns all runners when no config", () => {
    expect(getEnabled()).toEqual(["codex", "cursor", "claude"]);
  });

  test("excludes runners explicitly disabled", () => {
    const result = getEnabled({ runners: { codex: { enabled: false } } });
    expect(result).not.toContain("codex");
    expect(result).toContain("cursor");
    expect(result).toContain("claude");
  });

  test("includes runners explicitly enabled", () => {
    expect(getEnabled({ runners: { codex: { enabled: true } } })).toContain("codex");
  });
});
