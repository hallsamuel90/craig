import { describe, expect, test } from "vitest";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { save } from "./save.js";
import { load } from "./load.js";
import { setEnabled } from "../previews/set-enabled.js";

const paths = { configFile: "/mock/.craig/config.json" } as unknown as CraigPaths;

describe("save", () => {
  test("preserves newer preview flags when an older CLI updates a known preview", async () => {
    const original = { previews: { futureThing: true, futureDisabled: false, fileOpen: false } };
    const config = await load(paths, { readConfigFile: async () => JSON.stringify(original) });
    let written = "";

    await save(paths, setEnabled(config, "fileOpen", true), {
      writeConfigFile: async (_path, content) => { written = content; },
    });

    expect(JSON.parse(written)).toEqual({
      previews: { futureThing: true, futureDisabled: false, fileOpen: true },
    });
  });

  test("writes serialized config to the adapter", async () => {
    const written: Array<[string, string]> = [];
    const deps = { writeConfigFile: async (p: string, c: string) => { written.push([p, c]); } };
    const config = { runners: { codex: { enabled: false } } };

    await save(paths, config, deps);

    expect(written).toHaveLength(1);
    expect(written[0]![0]).toBe(paths.configFile);
    expect(JSON.parse(written[0]![1])).toEqual(config);
  });

  test("throws before writing when config fails validation", async () => {
    const written: string[] = [];
    const deps = { writeConfigFile: async (_p: string, c: string) => { written.push(c); } };
    const invalid = { runners: "not-an-object" } as unknown;

    await expect(save(paths, invalid as never, deps)).rejects.toThrow("invalid");
    expect(written).toHaveLength(0);
  });
});
