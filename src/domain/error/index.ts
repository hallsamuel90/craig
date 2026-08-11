export type {
  CraigErrorLogEntry,
  CraigErrorLogSnapshot,
  CraigLogEntry,
  CraigLogLevel,
  CraigLogRecord,
  CraigLogSnapshot,
} from "./adapters/error-store.js";
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
  appendLog,
  appendLogBestEffort,
  readLog,
  readErrorLog,
  readRecentErrorLines,
} from "./adapters/error-store.js";

export const errorService = {
  appendErrorLog,
  appendErrorLogBestEffort,
  appendLog,
  appendLogBestEffort,
  readLog,
  readErrorLog,
  readRecentErrorLines,
};
