import { describe, expect, test } from "vitest";
import { validate } from "./validate.js";

const FILE = "/mock/config.json";

describe("validate", () => {
  test("accepts an empty object", () => {
    expect(validate({}, FILE)).toEqual({});
  });

  test("accepts current previews and retired preview config keys", () => {
    expect(validate({ previews: { incrementalCenterPane: true, agentActivityIndicators: true, agentOrchestration: true, piRunner: true } }, FILE)).toEqual({
      previews: { incrementalCenterPane: true, agentActivityIndicators: true, agentOrchestration: true, piRunner: true },
    });
  });

  test("rejects unknown or non-boolean feature previews", () => {
    expect(() => validate({ previews: { futureThing: true } }, FILE)).toThrow('"previews.futureThing" is not supported');
    expect(() => validate({ previews: { incrementalCenterPane: "yes" } }, FILE)).toThrow(
      '"previews.incrementalCenterPane" must be a boolean',
    );
    expect(() => validate({ previews: { agentActivityIndicators: "yes" } }, FILE)).toThrow(
      '"previews.agentActivityIndicators" must be a boolean',
    );
  });

  test("accepts a valid full config", () => {
    const config = {
      runners: { codex: { enabled: true, path: "/usr/bin/codex" }, pi: { enabled: true, path: "/usr/bin/pi" } },
      checks: { commands: ["npm test"] },
      open: { command: ["code", "."] },
      github: { mergeMethod: "squash", watchIntervalSeconds: 30 },
    };
    expect(validate(config, FILE)).toEqual(config);
  });

  test("throws when value is not an object", () => {
    expect(() => validate("string", FILE)).toThrow("Expected a JSON object");
    expect(() => validate(null, FILE)).toThrow("Expected a JSON object");
    expect(() => validate(42, FILE)).toThrow("Expected a JSON object");
  });

  test("throws when runners is not an object", () => {
    expect(() => validate({ runners: "bad" }, FILE)).toThrow('"runners" must be an object');
    expect(() => validate({ runners: [] }, FILE)).toThrow('"runners" must be an object');
  });

  test("throws for unknown runner keys", () => {
    expect(() => validate({ runners: { unknown: {} } }, FILE)).toThrow('"runners.unknown" is not supported');
  });

  test("throws when runner config is not an object", () => {
    expect(() => validate({ runners: { codex: true } }, FILE)).toThrow('"runners.codex" must be an object');
  });

  test("throws when runner enabled is not a boolean", () => {
    expect(() => validate({ runners: { codex: { enabled: "yes" } } }, FILE)).toThrow('"runners.codex.enabled" must be a boolean');
  });

  test("throws when runner path is empty string", () => {
    expect(() => validate({ runners: { codex: { path: "  " } } }, FILE)).toThrow('"runners.codex.path" must be a non-empty string');
  });

  test("throws when checks.commands is not an array of strings", () => {
    expect(() => validate({ checks: { commands: [1, 2] } }, FILE)).toThrow('"checks.commands" must be an array of strings');
  });

  test("throws when open.command is not an array of strings", () => {
    expect(() => validate({ open: { command: "code ." } }, FILE)).toThrow('"open.command" must be an array of strings');
  });

  test("throws when github.mergeMethod is invalid", () => {
    expect(() => validate({ github: { mergeMethod: "fast-forward" } }, FILE)).toThrow('"github.mergeMethod" must be');
  });

  test("throws when github.watchIntervalSeconds is not a positive integer", () => {
    expect(() => validate({ github: { watchIntervalSeconds: 0 } }, FILE)).toThrow('"github.watchIntervalSeconds" must be a positive integer');
    expect(() => validate({ github: { watchIntervalSeconds: -5 } }, FILE)).toThrow('"github.watchIntervalSeconds" must be a positive integer');
    expect(() => validate({ github: { watchIntervalSeconds: 1.5 } }, FILE)).toThrow('"github.watchIntervalSeconds" must be a positive integer');
  });
});
