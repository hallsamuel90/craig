import type { PreviewFeatureId } from "../types.js";

export const PREVIEW_FEATURE_IDS = [
  "agentOrchestration",
  "piRunner",
  "fileOpen",
  "ghosttyTerminal",
] as const satisfies readonly PreviewFeatureId[];
