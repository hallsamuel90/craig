import { describe, expect, test } from "vitest";
import { checkForUpdate } from "./check-for-update.js";

const mockFetch = (response: { ok: boolean; json: () => Promise<unknown> }) =>
  async () => response as Response;

const deps = (fetchImpl: typeof globalThis.fetch, version = "1.0.0") => ({
  fetch: fetchImpl,
  getCurrent: () => version,
  cache: { value: null },
});

describe("checkForUpdate", () => {
  test("returns latest=null and updateAvailable=false when fetch throws", async () => {
    const fetchFn = async () => { throw new Error("network error"); };
    const result = await checkForUpdate(deps(fetchFn as typeof globalThis.fetch));
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  test("returns latest=null when registry returns non-ok response", async () => {
    const result = await checkForUpdate(deps(mockFetch({ ok: false, json: async () => ({}) })));
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  test("returns latest version from registry", async () => {
    const result = await checkForUpdate(deps(mockFetch({ ok: true, json: async () => ({ version: "2.0.0" }) })));
    expect(result.latest).toBe("2.0.0");
    expect(result.current).toBe("1.0.0");
    expect(result.updateAvailable).toBe(true);
  });

  test("returns updateAvailable=false when already on latest", async () => {
    const result = await checkForUpdate(deps(mockFetch({ ok: true, json: async () => ({ version: "1.0.0" }) })));
    expect(result.updateAvailable).toBe(false);
  });

  test("returns updateAvailable=false when registry returns older version", async () => {
    const result = await checkForUpdate(deps(mockFetch({ ok: true, json: async () => ({ version: "0.9.0" }) }), "1.0.0"));
    expect(result.updateAvailable).toBe(false);
  });

  test("returns cached result on second call within TTL", async () => {
    let calls = 0;
    const fetchFn = mockFetch({ ok: true, json: async () => { calls++; return { version: "2.0.0" }; } });
    const sharedDeps = deps(fetchFn);
    await checkForUpdate(sharedDeps);
    await checkForUpdate(sharedDeps);
    expect(calls).toBe(1);
  });
});
