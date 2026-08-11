import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";

export type CraigLogLevel = "debug" | "info" | "warn" | "error";

export interface CraigLogEntry {
  level: CraigLogLevel;
  component: string;
  event: string;
  message: string;
  taskId?: string;
  tabId?: string;
  details?: string | Record<string, unknown> | null;
}

export interface CraigLogRecord extends CraigLogEntry {
  timestamp: string;
}

export interface CraigLogSnapshot {
  path: string;
  lines: string[];
  empty: boolean;
}

export interface CraigErrorLogEntry {
  context: string;
  message: string;
  details?: string | null;
}

export type CraigErrorLogSnapshot = CraigLogSnapshot;

const DEFAULT_RECENT_LINE_COUNT = 80;

export const appendLog = async (paths: CraigPaths, entry: CraigLogEntry): Promise<void> => {
  await mkdir(path.dirname(paths.logFile), { recursive: true });
  const record: CraigLogRecord = { timestamp: new Date().toISOString(), ...entry };
  await appendFile(paths.logFile, `${JSON.stringify(record)}\n`, "utf8");
};

export const appendLogBestEffort = async (paths: CraigPaths, entry: CraigLogEntry): Promise<void> => {
  try {
    await appendLog(paths, entry);
  } catch {
    // Logging must never break the operation being observed.
  }
};

export const readLog = async (
  paths: CraigPaths,
  lineCount = DEFAULT_RECENT_LINE_COUNT,
): Promise<CraigLogSnapshot> => {
  try {
    const contents = await readFile(paths.logFile, "utf8");
    const records = contents.trimEnd().split("\n").filter((line) => line.length > 0);
    const lines = records.map(formatLogLine);
    return {
      path: paths.logFile,
      lines: lines.slice(Math.max(0, lines.length - lineCount)),
      empty: lines.length === 0,
    };
  } catch (error) {
    if (isFileMissingError(error)) {
      return {
        path: paths.logFile,
        lines: [],
        empty: true,
      };
    }

    throw error;
  }
};

export const appendErrorLog = async (paths: CraigPaths, entry: CraigErrorLogEntry): Promise<void> =>
  appendLog(paths, {
    level: "error",
    component: "application",
    event: normalizeEvent(entry.context),
    message: entry.message,
    ...(entry.details ? { details: entry.details } : {}),
  });

export const appendErrorLogBestEffort = async (paths: CraigPaths, entry: CraigErrorLogEntry): Promise<void> => {
  try {
    await appendErrorLog(paths, entry);
  } catch {
    // Error logging must never break the TUI recovery path.
  }
};

export const readErrorLog = readLog;

export const readRecentErrorLines = async (
  paths: CraigPaths,
  lineCount = DEFAULT_RECENT_LINE_COUNT,
): Promise<CraigErrorLogSnapshot> => readLog(paths, lineCount);

function formatLogLine(line: string): string {
  try {
    const record = JSON.parse(line) as Partial<CraigLogRecord>;
    if (!record.timestamp || !record.level || !record.component || !record.event || !record.message) return line;
    const target = [record.taskId, record.tabId].filter(Boolean).join("/");
    return `[${record.timestamp}] ${record.level.toUpperCase().padEnd(5)} ${record.component}.${record.event}${target ? ` ${target}` : ""} — ${record.message}`;
  } catch {
    return line;
  }
}

function normalizeEvent(context: string): string {
  return context.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "error";
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code === "ENOENT"
  );
}
