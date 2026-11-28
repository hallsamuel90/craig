import type { VersionCheckResult } from "../types.js";
import { getCurrent } from "./get-current.js";

const LATEST_RELEASE_URL = "https://api.github.com/repos/hallsamuel90/craig/releases/latest";
const CACHE_TTL_MS = 60 * 60 * 1000;

interface VersionCheckCache {
  result: VersionCheckResult;
  cachedAt: number;
}

const moduleCache: { value: VersionCheckCache | null } = { value: null };

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RELEASE_TAG_PATTERN = /^craig-cli@(\d+\.\d+\.\d+)$/;

function getReleaseVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const release = data as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return null;
  return RELEASE_TAG_PATTERN.exec(release.tag_name)?.[1] ?? null;
}

export const isNewer = (latest: string, current: string): boolean => {
  if (!STABLE_VERSION_PATTERN.test(latest) || !STABLE_VERSION_PATTERN.test(current)) {
    return false;
  }

  const parseSemver = (v: string) => v.split(".").map(Number);
  const [lMaj = 0, lMin = 0, lPat = 0] = parseSemver(latest);
  const [cMaj = 0, cMin = 0, cPat = 0] = parseSemver(current);

  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
};

export const checkForUpdate = async (
  deps: {
    fetch: typeof globalThis.fetch;
    getCurrent: () => string;
    cache: { value: VersionCheckCache | null };
  } = { fetch: globalThis.fetch, getCurrent, cache: moduleCache },
): Promise<VersionCheckResult> => {
  const current = deps.getCurrent();
  const now = Date.now();

  if (deps.cache.value && deps.cache.value.result.current === current && now - deps.cache.value.cachedAt < CACHE_TTL_MS) {
    return deps.cache.value.result;
  }

  let latest: string | null = null;
  try {
    const response = await deps.fetch(LATEST_RELEASE_URL, {
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "craig-cli",
      },
    });
    if (response.ok) {
      latest = getReleaseVersion(await response.json());
    }
  } catch {
    // Fail silently — version check is non-blocking best-effort
  }

  const result: VersionCheckResult = {
    current,
    latest,
    updateAvailable: latest !== null && latest !== current && isNewer(latest, current),
  };

  deps.cache.value = { result, cachedAt: now };
  return result;
};
