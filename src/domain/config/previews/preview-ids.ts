import type { PreviewFeatureId } from "../types.js";

export const PREVIEW_FEATURE_IDS = [
  "incrementalCenterPane",
  "agentActivityIndicators",
] as const satisfies readonly PreviewFeatureId[];
