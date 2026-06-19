export type { CraigConfig, RunnerConfig, RunnerProfile, RunnerType, VersionCheckResult } from "./types.js";
export { RUNNER_IDS } from "./runners.js";

import { load, save } from "./config.js";
import * as runners from "./runners.js";
import * as version from "./version.js";

export const configService = {
  load,
  save,
  runners,
  version,
};
