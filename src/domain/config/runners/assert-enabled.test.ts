import { describe, expect, test } from "vitest";
import { assertEnabled } from "./assert-enabled.js";

describe("assertEnabled", () => {
  test("does not throw when runner has no explicit config", () => {
    expect(() => assertEnabled("codex")).not.toThrow();
  });

  test("does not throw when runner is explicitly enabled", () => {
    expect(() => assertEnabled("codex", { runners: { codex: { enabled: true } } })).not.toThrow();
  });

  test("throws when runner is explicitly disabled", () => {
    expect(() => assertEnabled("codex", { runners: { codex: { enabled: false } } })).toThrow('"codex" is disabled');
  });

  test("requires the Pi runner feature preview", () => {
    expect(() => assertEnabled("pi", { runners: { pi: { enabled: true } } })).toThrow("Enable the piRunner feature preview");
    expect(() => assertEnabled("pi", { previews: { piRunner: true } })).not.toThrow();
  });
});
