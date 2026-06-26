import { readFile } from "node:fs/promises";

import type { CraigUiRuntime } from "../types/workspace.js";
import { atomicWriteJson } from "../shared/atomic-write.js";

export async function readUiState(input: { uiStateFile: string }): Promise<CraigUiRuntime | null> {
  try {
    const raw = await readFile(input.uiStateFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    return validateUiState(parsed, input.uiStateFile);
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writeUiState(input: { uiStateFile: string }, state: CraigUiRuntime): Promise<void> {
  await atomicWriteJson(input.uiStateFile, {
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

export function getDefaultUiState(): CraigUiRuntime {
  return {
    version: 1,
    selectedRepoId: null,
    selectedWorkspaceId: null,
    selectedTaskId: null,
    selectedPtyTabId: null,
    inputMode: "control",
    focusedRegion: "tasks",
    activeTab: "agent",
    inspectorSection: "task",
    inspectionMode: "files",
    openInspectionKind: null,
    selectedFileTreePath: null,
    selectedFilePath: null,
    selectedDiffPath: null,
    collapsedFileTreePaths: [],
    selectedActionId: "commit",
    updatedAt: new Date().toISOString(),
  };
}

function validateUiState(value: unknown, filePath: string): CraigUiRuntime {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<CraigUiRuntime>).version !== 1 ||
    !(
      (value as Partial<CraigUiRuntime>).selectedRepoId === null ||
      typeof (value as Partial<CraigUiRuntime>).selectedRepoId === "string"
    ) ||
    !(
      (value as Partial<CraigUiRuntime>).selectedWorkspaceId === null ||
      typeof (value as Partial<CraigUiRuntime>).selectedWorkspaceId === "string"
    ) ||
    !(
      (value as Partial<CraigUiRuntime>).selectedTaskId === null ||
      typeof (value as Partial<CraigUiRuntime>).selectedTaskId === "string"
    ) ||
    !(
      (value as Partial<CraigUiRuntime>).selectedPtyTabId === undefined ||
      (value as Partial<CraigUiRuntime>).selectedPtyTabId === null ||
      typeof (value as Partial<CraigUiRuntime>).selectedPtyTabId === "string"
    ) ||
    !optionalString(value, "inputMode") ||
    !optionalString(value, "focusedRegion") ||
    !optionalString(value, "activeTab") ||
    !optionalString(value, "inspectorSection") ||
    !optionalString(value, "inspectionMode") ||
    !optionalNullableString(value, "openInspectionKind") ||
    !optionalNullableString(value, "selectedFileTreePath") ||
    !optionalNullableString(value, "selectedFilePath") ||
    !optionalNullableString(value, "selectedDiffPath") ||
    !optionalStringArray(value, "collapsedFileTreePaths") ||
    !optionalString(value, "selectedActionId") ||
    typeof (value as Partial<CraigUiRuntime>).updatedAt !== "string"
  ) {
    throw new Error(`Craig UI state at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`);
  }

  return value as CraigUiRuntime;
}

function optionalString(value: unknown, key: keyof CraigUiRuntime): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (!(key in value) || typeof (value as Record<string, unknown>)[key] === "string")
  );
}

function optionalNullableString(value: unknown, key: keyof CraigUiRuntime): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (!(key in value) ||
      (value as Record<string, unknown>)[key] === null ||
      typeof (value as Record<string, unknown>)[key] === "string")
  );
}

function optionalStringArray(value: unknown, key: keyof CraigUiRuntime): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (!(key in value) ||
      (Array.isArray((value as Record<string, unknown>)[key]) &&
        ((value as Record<string, unknown>)[key] as unknown[]).every((entry) => typeof entry === "string")))
  );
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
