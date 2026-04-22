import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";

export function resolveArtifactPath(paths: CraigPaths, artifactPath: string | null): string | null {
  if (!artifactPath) {
    return null;
  }

  if (path.isAbsolute(artifactPath)) {
    return artifactPath;
  }

  return path.join(paths.repoRoot, artifactPath);
}
