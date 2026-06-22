import { describe, expect, test } from "vitest";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { load } from "./load.js";

const paths = { configFile: "/mock/.craig/config.json" } as unknown as CraigPaths;

describe("load", () => {
  test("returns empty object when file does not exist", async () => {
    const deps = { readConfigFile: async () => null };
    expect(await load(paths, deps)).toEqual({});
  });

  test("returns parsed config for valid JSON", async () => {
    const config = { runners: { codex: { enabled: false } } };
    const deps = { readConfigFile: async () => JSON.stringify(config) };
    expect(await load(paths, deps)).toEqual(config);
  });

  test("throws on non-object JSON content", async () => {
    const deps = { readConfigFile: async () => `"just a string"` };
    await expect(load(paths, deps)).rejects.toThrow("malformed");
  });

  test("throws on malformed JSON", async () => {
    const deps = { readConfigFile: async () => `{ bad json` };
    await expect(load(paths, deps)).rejects.toThrow("malformed");
  });

  test("throws when config fails validation", async () => {
    const deps = { readConfigFile: async () => `{ "runners": "not-an-object" }` };
    await expect(load(paths, deps)).rejects.toThrow("invalid");
  });
});
