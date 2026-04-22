import { readFile } from "node:fs/promises";

import { atomicWriteJson } from "./atomic-write.js";

export interface ManagedPageRecord {
  pageNumber: number;
  windowTarget: string;
  isPrimary: boolean;
}

export interface CraigSessionRuntime {
  sessionName: string;
  controlPaneTarget: string;
  primaryWindowTarget: string;
  managedPages: ManagedPageRecord[];
  updatedAt: string;
}

export async function readSessionRuntime(input: { sessionFile: string }): Promise<CraigSessionRuntime | null> {
  try {
    const raw = await readFile(input.sessionFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isCraigSessionRuntime(parsed)) {
      throw new Error(`Craig session runtime at ${input.sessionFile} is invalid.`);
    }

    return parsed;
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writeSessionRuntime(input: { sessionFile: string }, runtime: CraigSessionRuntime): Promise<void> {
  await atomicWriteJson(input.sessionFile, {
    ...runtime,
    updatedAt: new Date().toISOString(),
  });
}

function isCraigSessionRuntime(value: unknown): value is CraigSessionRuntime {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CraigSessionRuntime>;

  return (
    typeof candidate.sessionName === "string" &&
    typeof candidate.controlPaneTarget === "string" &&
    typeof candidate.primaryWindowTarget === "string" &&
    Array.isArray(candidate.managedPages) &&
    candidate.managedPages.every(isManagedPageRecord) &&
    typeof candidate.updatedAt === "string"
  );
}

function isManagedPageRecord(value: unknown): value is ManagedPageRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<ManagedPageRecord>).pageNumber === "number" &&
    typeof (value as Partial<ManagedPageRecord>).windowTarget === "string" &&
    typeof (value as Partial<ManagedPageRecord>).isPrimary === "boolean"
  );
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
