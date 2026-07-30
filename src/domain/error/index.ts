export type { CraigErrorLogEntry, CraigErrorLogSnapshot } from "./adapters/error-store.js";
export type {
  CraigErrorCode,
  CraigExitCode,
  CraigErrorDetails,
  CraigErrorOptions,
} from "./types.js";
export { CRAIG_EXIT_CODE_BY_ERROR, CraigError, toCraigError } from "./types.js";

import {
  appendErrorLog,
  appendErrorLogBestEffort,
  readErrorLog,
  readRecentErrorLines,
} from "./adapters/error-store.js";

export const errorService = {
  appendErrorLog,
  appendErrorLogBestEffort,
  readErrorLog,
  readRecentErrorLines,
};
