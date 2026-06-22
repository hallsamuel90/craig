export type { CraigErrorLogEntry, CraigErrorLogSnapshot } from "./adapters/error-store.js";

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
