import { readFile } from "node:fs/promises";

import { atomicWriteJson } from "./atomic-write.js";

export interface ManagedPageRecord {
  pageNumber: number;
  windowTarget: string;
  isPrimary: boolean;
}

export interface CraigUiRuntime {
  selectedTaskId: string | null;
  workSurfaceMode: "command";
  lastContextView: "summary";
  lastCommandBuffer: string;
  lastOutputLines: string[];
}

export interface CraigSessionRuntime {
  sessionName: string;
  controlPaneTarget: string;
  primaryWindowTarget: string;
  managedPages: ManagedPageRecord[];
  ui: CraigUiRuntime;
  updatedAt: string;
}

export async function readSessionRuntime(input: { sessionFile: string }): Promise<CraigSessionRuntime | null> {
  try {
    const raw = await readFile(input.sessionFile, "utf8");
    const parsed = normalizeSessionRuntime(JSON.parse(raw) as unknown);

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
  const normalized = normalizeSessionRuntime(runtime) as CraigSessionRuntime;

  await atomicWriteJson(input.sessionFile, {
    ...normalized,
    updatedAt: new Date().toISOString(),
  });
}

export function getDefaultUiRuntime(): CraigUiRuntime {
  return {
    selectedTaskId: null,
    workSurfaceMode: "command",
    lastContextView: "summary",
    lastCommandBuffer: "",
    lastOutputLines: [],
  };
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
    isCraigUiRuntime(candidate.ui) &&
    typeof candidate.updatedAt === "string"
  );
}

function normalizeSessionRuntime(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const candidate = value as Partial<CraigSessionRuntime>;

  return {
    ...candidate,
    ui: normalizeUiRuntime(candidate.ui),
  };
}

function isCraigUiRuntime(value: unknown): value is CraigUiRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    (((value as Partial<CraigUiRuntime>).selectedTaskId === null) ||
      typeof (value as Partial<CraigUiRuntime>).selectedTaskId === "string") &&
    (value as Partial<CraigUiRuntime>).workSurfaceMode === "command" &&
    (value as Partial<CraigUiRuntime>).lastContextView === "summary" &&
    typeof (value as Partial<CraigUiRuntime>).lastCommandBuffer === "string" &&
    Array.isArray((value as Partial<CraigUiRuntime>).lastOutputLines) &&
    ((value as Partial<CraigUiRuntime>).lastOutputLines ?? []).every((entry) => typeof entry === "string")
  );
}

function normalizeUiRuntime(value: CraigUiRuntime | undefined): CraigUiRuntime {
  const candidate = typeof value === "object" && value !== null ? value : undefined;

  return {
    selectedTaskId: candidate?.selectedTaskId ?? null,
    workSurfaceMode: "command",
    lastContextView: "summary",
    lastCommandBuffer: candidate?.lastCommandBuffer ?? "",
    lastOutputLines: Array.isArray(candidate?.lastOutputLines)
      ? candidate.lastOutputLines.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
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
