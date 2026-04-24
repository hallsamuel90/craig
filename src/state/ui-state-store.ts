import { readFile } from "node:fs/promises";

import type { CraigUiRuntime } from "../types/workspace.js";
import { atomicWriteJson } from "./atomic-write.js";

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
    activeSurface: "overlay",
    overlayMode: "start",
    inputMode: "control",
    centerSurface: "command",
    rightContextTab: "summary",
    panelFocus: "left",
    lastAttachedSessionId: null,
    commandBuffer: "",
    outputLines: [],
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
    !["overlay", "shell"].includes((value as Partial<CraigUiRuntime>).activeSurface ?? "") ||
    ((value as Partial<CraigUiRuntime>).overlayMode !== "start" &&
      (value as Partial<CraigUiRuntime>).overlayMode !== "archives") ||
    ((value as Partial<CraigUiRuntime>).inputMode !== "control" &&
      (value as Partial<CraigUiRuntime>).inputMode !== "terminal") ||
    ((value as Partial<CraigUiRuntime>).centerSurface !== "command" &&
      (value as Partial<CraigUiRuntime>).centerSurface !== "terminal") ||
    !["summary", "logs", "diff", "files", "review"].includes((value as Partial<CraigUiRuntime>).rightContextTab ?? "") ||
    !["left", "center", "right"].includes((value as Partial<CraigUiRuntime>).panelFocus ?? "") ||
    !(
      (value as Partial<CraigUiRuntime>).lastAttachedSessionId === null ||
      typeof (value as Partial<CraigUiRuntime>).lastAttachedSessionId === "string"
    ) ||
    typeof (value as Partial<CraigUiRuntime>).commandBuffer !== "string" ||
    !Array.isArray((value as Partial<CraigUiRuntime>).outputLines) ||
    !((value as Partial<CraigUiRuntime>).outputLines ?? []).every((entry) => typeof entry === "string") ||
    typeof (value as Partial<CraigUiRuntime>).updatedAt !== "string"
  ) {
    throw new Error(`Craig UI state at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`);
  }

  return value as CraigUiRuntime;
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
