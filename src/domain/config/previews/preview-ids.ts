import type { PreviewFeatureId } from "../types.js";

export const PREVIEW_FEATURE_IDS = [
  "agentActivityIndicators",
  "agentOrchestration",
] as const satisfies readonly PreviewFeatureId[];
