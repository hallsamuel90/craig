import type { VersionCheckResult } from "./types.js";

declare const __CRAIG_VERSION__: string | undefined;

const REGISTRY_URL = "https://registry.npmjs.org/craig-cli/latest";
const CACHE_TTL_MS = 60 * 60 * 1000;

interface VersionCheckCache {
  result: VersionCheckResult;
  cachedAt: number;
}

let cache: VersionCheckCache | null = null;

export function getCurrent(): string {
  try {
    return typeof __CRAIG_VERSION__ !== "undefined" ? __CRAIG_VERSION__ : "unknown";
  } catch {
    return "unknown";
  }
}

export async function checkForUpdate(): Promise<VersionCheckResult> {
  const current = getCurrent();
  const now = Date.now();

  if (cache && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.result;
  }

  let latest: string | null = null;
  try {
    const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = await response.json() as { version?: string };
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

  cache = { result, cachedAt: now };
  return result;
}

function isNewer(latest: string, current: string): boolean {
  const parseSemver = (v: string) => v.split(".").map(Number);
  const [lMaj = 0, lMin = 0, lPat = 0] = parseSemver(latest);
  const [cMaj = 0, cMin = 0, cPat = 0] = parseSemver(current);

  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}
