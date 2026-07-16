import type { CraigConfig, PreviewFeatureId } from "../types.js";

export function setEnabled(config: CraigConfig, feature: PreviewFeatureId, enabled: boolean): CraigConfig {
  return {
    ...config,
    previews: {
      ...config.previews,
      [feature]: enabled,
    },
  };
}
