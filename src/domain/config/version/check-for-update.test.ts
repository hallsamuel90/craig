import { afterEach, describe, expect, test, vi } from "vitest";
import { checkForUpdate } from "./check-for-update.js";

const mockFetch = (response: { ok: boolean; json: () => Promise<unknown> }) =>
  vi.fn(async () => response as Response);

const release = (version: string) => ({ tag_name: `craig-cli@${version}`, draft: false, prerelease: false });
const response = (data: unknown) => mockFetch({ ok: true, json: async () => data });
const deps = (fetchImpl: typeof globalThis.fetch, version = "1.0.0") => ({
  fetch: fetchImpl,
  getCurrent: () => version,
  cache: { value: null },
});

afterEach(() => vi.useRealTimers());

describe("checkForUpdate", () => {
  test("fails quietly when the network request throws", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("network error"); });
    const result = await checkForUpdate(deps(fetchFn));
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test.each([404, 403, 429, 500])("fails quietly on GitHub HTTP %s without falling back to npm", async (status) => {
    const fetchFn = mockFetch({ ok: false, json: async () => ({ status }) });
    const result = await checkForUpdate(deps(fetchFn));
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("checks the public latest GitHub release with a bounded unauthenticated request", async () => {
    const fetchFn = response(release("2.0.0"));
    const result = await checkForUpdate(deps(fetchFn));
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.github.com/repos/hallsamuel90/craig/releases/latest",
      { signal: expect.any(AbortSignal), headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "craig-cli",
      } },
    );
    expect(result).toEqual({ current: "1.0.0", latest: "2.0.0", updateAvailable: true });
  });

  test.each(["1.0.0", "0.9.0"])("does not offer an update for release %s", async (version) => {
    const result = await checkForUpdate(deps(response(release(version))));
    expect(result.latest).toBe(version);
    expect(result.updateAvailable).toBe(false);
  });

  test.each([
    null, [], "craig-cli@2.0.0", {}, { version: "2.0.0" },
    { ...release("2.0.0"), draft: true },
    { ...release("2.0.0"), prerelease: true },
    { tag_name: "craig-cli@2.0.0" },
    release("2.0.0-beta.1"), release("2.0.0; rm -rf"),
    { ...release("2.0.0"), tag_name: "v2.0.0" },
    { ...release("2.0.0"), tag_name: "other-package@2.0.0" },
    { ...release("2.0.0"), tag_name: 200 },
  ])("ignores unpublished, unrelated or malformed release payload %j", async (data) => {
    expect(await checkForUpdate(deps(response(data)))).toEqual({ current: "1.0.0", latest: null, updateAvailable: false });
  });

  test("fails quietly if GitHub returns invalid JSON", async () => {
    const fetchFn = mockFetch({ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } });
    expect((await checkForUpdate(deps(fetchFn))).latest).toBeNull();
  });

  test("caches release discovery for one hour and refreshes after expiry", async () => {
    vi.useFakeTimers();
    const fetchFn = response(release("2.0.0"));
    const sharedDeps = deps(fetchFn);
    await checkForUpdate(sharedDeps);
    await checkForUpdate(sharedDeps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    await checkForUpdate(sharedDeps);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("does not reuse a cached comparison for a different installed version", async () => {
    const fetchFn = response(release("2.0.0"));
    const sharedDeps = deps(fetchFn);
    await checkForUpdate(sharedDeps);
    sharedDeps.getCurrent = () => "2.0.0";
    expect(await checkForUpdate(sharedDeps)).toEqual({ current: "2.0.0", latest: "2.0.0", updateAvailable: false });
  });
});
