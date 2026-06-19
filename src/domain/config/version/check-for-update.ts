import type { VersionCheckResult } from "../types.js";
import { getCurrent } from "./get-current.js";

const REGISTRY_URL = "https://registry.npmjs.org/craig-cli/latest";
const CACHE_TTL_MS = 60 * 60 * 1000;

interface VersionCheckCache {
  result: VersionCheckResult;
  cachedAt: number;
}

interface Deps {
  fetch: typeof globalThis.fetch;
  getCurrent: () => string;
  cache: { value: VersionCheckCache | null };
}

const moduleCache: { value: VersionCheckCache | null } = { value: null };

const isNewer = (latest: string, current: string): boolean => {
  const parseSemver = (v: string) => v.split(".").map(Number);
  const [lMaj = 0, lMin = 0, lPat = 0] = parseSemver(latest);
  const [cMaj = 0, cMin = 0, cPat = 0] = parseSemver(current);

  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
};

export const checkForUpdate = async (
  deps: Deps = { fetch: globalThis.fetch, getCurrent, cache: moduleCache },
): Promise<VersionCheckResult> => {
  const current = deps.getCurrent();
  const now = Date.now();

  if (deps.cache.value && now - deps.cache.value.cachedAt < CACHE_TTL_MS) {
    return deps.cache.value.result;
  }

  let latest: string | null = null;
  try {
    const response = await deps.fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = (await response.json()) as { version?: string };
      latest = data.version ?? null;
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
