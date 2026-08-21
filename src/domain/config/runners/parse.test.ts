import { describe, expect, test } from "vitest";
import { parse } from "./parse.js";

describe("parse", () => {
  test("returns codex for empty string", () => {
    expect(parse("")).toBe("codex");
  });

  test("returns codex for null", () => {
    expect(parse(null)).toBe("codex");
  });

  test("returns codex for undefined", () => {
    expect(parse(undefined)).toBe("codex");
  });

  test.each(["codex", "cursor", "claude", "pi"])("parses valid runner %s", (runner) => {
    expect(parse(runner)).toBe(runner);
  });

  test("throws for unknown runner", () => {
    expect(() => parse("gpt")).toThrow('Unsupported runner "gpt"');
  });
});
