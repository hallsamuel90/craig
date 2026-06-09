import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";

export interface CraigErrorLogEntry {
  context: string;
  message: string;
  details?: string | null;
}

export interface CraigErrorLogSnapshot {
  path: string;
  lines: string[];
  empty: boolean;
}

const DEFAULT_RECENT_LINE_COUNT = 80;

export async function appendCraigErrorLog(paths: CraigPaths, entry: CraigErrorLogEntry): Promise<void> {
  await mkdir(path.dirname(paths.errorLogFile), { recursive: true });
  await appendFile(paths.errorLogFile, formatErrorLogEntry(entry), "utf8");
}

export async function appendCraigErrorLogBestEffort(paths: CraigPaths, entry: CraigErrorLogEntry): Promise<void> {
  try {
    await appendCraigErrorLog(paths, entry);
  } catch {
    // Error logging must never break the TUI recovery path.
  }
}

export async function readRecentCraigErrorLog(
  paths: CraigPaths,
  lineCount = DEFAULT_RECENT_LINE_COUNT,
): Promise<CraigErrorLogSnapshot> {
  try {
    const contents = await readFile(paths.errorLogFile, "utf8");
    const lines = contents.trimEnd().split("\n").filter((line) => line.length > 0);
    return {
      path: paths.errorLogFile,
      lines: lines.slice(Math.max(0, lines.length - lineCount)),
      empty: lines.length === 0,
    };
  } catch (error) {
    if (isFileMissingError(error)) {
      return {
        path: paths.errorLogFile,
        lines: [],
        empty: true,
      };
    }

    throw error;
  }
}

function formatErrorLogEntry(entry: CraigErrorLogEntry): string {
  const timestamp = new Date().toISOString();
  const lines = [
    `[${timestamp}] ${entry.context}`,
    `message: ${entry.message}`,
  ];

  if (entry.details && entry.details.trim().length > 0) {
    lines.push("details:");
    lines.push(...entry.details.trimEnd().split("\n").map((line) => `  ${line}`));
  }

  return `${lines.join("\n")}\n\n`;
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
