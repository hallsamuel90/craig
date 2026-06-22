import { describe, expect, test } from "vitest";
import { isRunnerType } from "./is-runner-type.js";

describe("isRunnerType", () => {
  test.each(["codex", "cursor", "claude"])("returns true for %s", (runner) => {
    expect(isRunnerType(runner)).toBe(true);
  });

  test.each(["gpt", "", "CODEX"])("returns false for %s", (value) => {
    expect(isRunnerType(value)).toBe(false);
  });
});
