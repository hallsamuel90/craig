export type { CraigConfig, RunnerConfig, RunnerProfile, RunnerType, VersionCheckResult } from "./types.js";
export { RUNNER_IDS } from "./runners/index.js";

import { load, save } from "./config/index.js";
import * as runners from "./runners/index.js";
import * as version from "./version/index.js";

export const configService = { load, save, runners, version };
