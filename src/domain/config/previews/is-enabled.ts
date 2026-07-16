import type { CraigConfig, PreviewFeatureId } from "../types.js";

export function isEnabled(config: CraigConfig, feature: PreviewFeatureId): boolean {
  return config.previews?.[feature] === true;
}
