import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { TaskRecord } from "../types/task.js";
import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { assertTaskWorktreeExists } from "./task-inspection.js";
import type { TaskWorktree } from "../types/task.js";

export const FILE_CONTENT_LIMIT_BYTES = 200 * 1024;
export const DIFF_CONTENT_LIMIT_BYTES = 500 * 1024;
const FULL_FILE_DIFF_CONTEXT_LINES = "100000";

export type InspectionTreeRow =
  | { kind: "directory"; path: string; depth: number; label: string }
  | { kind: "file"; path: string; depth: number; label: string };

export type InspectionDiffGroup = "staged" | "unstaged" | "untracked";

export interface InspectionDiffRow {
  group: InspectionDiffGroup;
  path: string;
  repoId?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface InspectionContent {
  path: string | null;
  status: "ready" | "empty" | "missing" | "binary" | "too_large" | "error";
  title: string;
  lines: string[];
  byteLength: number | null;
}

export interface TaskLocalInspection {
  taskId: string;
  fileRows: InspectionTreeRow[];
  filePaths: string[];
  diffRows: InspectionDiffRow[];
  diffPaths: string[];
  selectedFilePath: string | null;
  selectedDiffPath: string | null;
  selectedFile: InspectionContent;
  selectedDiff: InspectionContent;
  error: string | null;
}

export interface TaskLocalInspectionSelection {
  selectedFilePath?: string | null;
  selectedDiffPath?: string | null;
}

export async function loadTaskLocalInspection(
  task: TaskRecord,
  selection: TaskLocalInspectionSelection = {},
): Promise<TaskLocalInspection> {
  try {
    const isMultiRepo = task.worktrees.length > 1;
    const inspections = await Promise.all(task.worktrees.map(async (worktree) => {
      await assertTaskWorktreeExists(task, worktree.repoId);
      const [localFilePaths, localDiffRows] = await Promise.all([
        listGitVisibleFiles(worktree.worktreePath),
        listDiffRows(worktree.worktreePath),
      ]);
      return {
        worktree,
        localFilePaths,
        localDiffRows,
        filePaths: localFilePaths.map((filePath) => isMultiRepo ? encodeRepoPath(worktree.repoId, filePath) : filePath),
        diffRows: localDiffRows.map((row) => ({
          ...row,
          repoId: worktree.repoId,
          path: isMultiRepo ? encodeRepoPath(worktree.repoId, row.path) : row.path,
        })),
      };
    }));
    const filePaths = inspections.flatMap((entry) => entry.filePaths);
    const diffRows = inspections.flatMap((entry) => entry.diffRows);
    const diffPaths = [...new Set(diffRows.map((row) => row.path))];
    const selectedFilePath = resolveSelectedPath(selection.selectedFilePath ?? null, filePaths);
    const selectedDiffPath = resolveSelectedPath(selection.selectedDiffPath ?? null, diffPaths);
    const selectedFileTarget = selectedFilePath ? resolveInspectionTarget(task, selectedFilePath) : null;
    const selectedDiffTarget = selectedDiffPath ? resolveInspectionTarget(task, selectedDiffPath) : null;
    const [selectedFile, selectedDiff] = await Promise.all([
      selectedFileTarget
        ? readGuardedFile(selectedFileTarget.worktree.worktreePath, selectedFileTarget.path, selectedFilePath)
        : readGuardedFile(task.worktreePath, null),
      selectedDiffTarget
        ? readGuardedDiff(selectedDiffTarget.worktree.worktreePath, selectedDiffTarget.path, diffRows, selectedDiffPath)
        : readGuardedDiff(task.worktreePath, null, diffRows),
    ]);

    return {
      taskId: task.id,
      fileRows: buildMultiRepoTreeRows(inspections),
      filePaths,
      diffRows,
      diffPaths,
      selectedFilePath,
      selectedDiffPath,
      selectedFile,
      selectedDiff,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to inspect task worktree.";
    return {
      taskId: task.id,
      fileRows: [],
      filePaths: [],
      diffRows: [],
      diffPaths: [],
      selectedFilePath: null,
      selectedDiffPath: null,
      selectedFile: buildEmptyContent("Files unavailable", message, "error"),
      selectedDiff: buildEmptyContent("Diff unavailable", message, "error"),
      error: message,
    };
  }
}

async function listGitVisibleFiles(worktreePath: string): Promise<string[]> {
  const result = await runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: worktreePath });
  return uniqueSortedLines(result.stdout);
}

async function listDiffRows(worktreePath: string): Promise<InspectionDiffRow[]> {
  const [staged, unstaged, untracked] = await Promise.all([
    listChangedRows(worktreePath, "staged"),
    listChangedRows(worktreePath, "unstaged"),
    listUntrackedRows(worktreePath),
  ]);

  return [...staged, ...unstaged, ...untracked];
}

async function listChangedRows(worktreePath: string, group: "staged" | "unstaged"): Promise<InspectionDiffRow[]> {
  const args = group === "staged" ? ["diff", "--cached", "--name-status"] : ["diff", "--name-status"];
  const result = await runCommand("git", args, { cwd: worktreePath });
  const changedFiles = parseNameStatus(result.stdout);
  const rows = await Promise.all(
    changedFiles.map(async (entry) => {
      const numstat = await readNumstat(worktreePath, group, entry.path);
      return {
        group,
        path: entry.path,
        status: entry.status,
        additions: numstat.additions,
        deletions: numstat.deletions,
      };
    }),
  );

  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function listUntrackedRows(worktreePath: string): Promise<InspectionDiffRow[]> {
  const result = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath });
  const paths = uniqueSortedLines(result.stdout);
  const rows = await Promise.all(
    paths.map(async (filePath) => {
      const content = await readGuardedFile(worktreePath, filePath);
      const additions = content.status === "ready" ? countTextFileLines(content.lines) : null;
      return {
        group: "untracked" as const,
        path: filePath,
        status: "A",
        additions,
        deletions: 0,
      };
    }),
  );
  return rows;
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status = "M", ...pathParts] = line.split("\t");
      return {
        status,
        path: pathParts.at(-1) ?? "",
      };
    })
    .filter((entry) => entry.path.length > 0);
}

async function readNumstat(
  worktreePath: string,
  group: "staged" | "unstaged",
  filePath: string,
): Promise<{ additions: number | null; deletions: number | null }> {
  const args =
    group === "staged"
      ? ["diff", "--cached", "--numstat", "--", filePath]
      : ["diff", "--numstat", "--", filePath];
  const result = await runCommand("git", args, { cwd: worktreePath });
  const [additionsRaw = "-", deletionsRaw = "-"] = (result.stdout.split("\n")[0] ?? "").split("\t");
  return {
    additions: additionsRaw === "-" ? null : Number(additionsRaw),
    deletions: deletionsRaw === "-" ? null : Number(deletionsRaw),
  };
}

async function readGuardedFile(worktreePath: string, filePath: string | null, displayPath = filePath): Promise<InspectionContent> {
  if (!filePath) {
    return buildEmptyContent("No file selected", "No Git-visible files found.", "empty");
  }

  const absolutePath = resolveWorktreePath(worktreePath, filePath);
  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.size > FILE_CONTENT_LIMIT_BYTES) {
      return buildEmptyContent(displayPath ?? filePath, `File is ${fileStat.size} bytes, above the 200 KB inline preview limit.`, "too_large", displayPath ?? filePath, fileStat.size);
    }

    const buffer = await readFile(absolutePath);
    if (isBinaryBuffer(buffer)) {
      return buildEmptyContent(displayPath ?? filePath, "Binary file preview is not available in Craig.", "binary", displayPath ?? filePath, buffer.byteLength);
    }

    return {
      path: displayPath,
      status: "ready",
      title: displayPath ?? filePath,
      lines: buffer.toString("utf8").split("\n"),
      byteLength: buffer.byteLength,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read file.";
    return buildEmptyContent(displayPath ?? filePath, message, "missing", displayPath ?? filePath, null);
  }
}

async function readGuardedDiff(
  worktreePath: string,
  filePath: string | null,
  rows: InspectionDiffRow[],
  displayPath = filePath,
): Promise<InspectionContent> {
  if (!filePath) {
    return buildEmptyContent("No diff selected", "No local changes found.", "empty");
  }

  const parts: string[] = [];
  const matchingGroups = rows.filter((row) => row.path === (displayPath ?? filePath)).map((row) => row.group);

  if (matchingGroups.includes("staged")) {
    const staged = await runCommand(
      "git",
      ["diff", "--cached", "--stat", "--patch", `--unified=${FULL_FILE_DIFF_CONTEXT_LINES}`, "--", filePath],
      { cwd: worktreePath },
    );
    if (staged.stdout.trim().length > 0) {
      parts.push(`staged\n${staged.stdout.trimEnd()}`);
    }
  }

  if (matchingGroups.includes("unstaged")) {
    const unstaged = await runCommand(
      "git",
      ["diff", "--stat", "--patch", `--unified=${FULL_FILE_DIFF_CONTEXT_LINES}`, "--", filePath],
      { cwd: worktreePath },
    );
    if (unstaged.stdout.trim().length > 0) {
      parts.push(`unstaged\n${unstaged.stdout.trimEnd()}`);
    }
  }

  if (matchingGroups.includes("untracked")) {
    const untracked = await runCommandAllowingFailure(
      "git",
      ["diff", "--no-index", "--stat", "--patch", `--unified=${FULL_FILE_DIFF_CONTEXT_LINES}`, "--", "/dev/null", filePath],
      { cwd: worktreePath },
    );
    if (untracked.stdout.trim().length > 0) {
      parts.push(`untracked\n${untracked.stdout.trimEnd()}`);
    }
  }

  const diffText = parts.join("\n\n");
  if (diffText.length > DIFF_CONTENT_LIMIT_BYTES) {
    return buildEmptyContent(displayPath ?? filePath, "Diff is above the 500 KB inline preview limit.", "too_large", displayPath ?? filePath, diffText.length);
  }

  if (diffText.includes("\0")) {
    return buildEmptyContent(displayPath ?? filePath, "Binary diff preview is not available in Craig.", "binary", displayPath ?? filePath, diffText.length);
  }

  return {
    path: displayPath,
    status: diffText.length > 0 ? "ready" : "empty",
    title: displayPath ?? filePath,
    lines: diffText.length > 0 ? diffText.split("\n") : ["No diff for this file."],
    byteLength: diffText.length,
  };
}

function buildTreeRows(filePaths: string[]): InspectionTreeRow[] {
  const rows: InspectionTreeRow[] = [];
  const seenDirectories = new Set<string>();

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    for (let index = 0; index < parts.length - 1; index += 1) {
      const directoryPath = parts.slice(0, index + 1).join("/");
      if (seenDirectories.has(directoryPath)) {
        continue;
      }
      seenDirectories.add(directoryPath);
      rows.push({
        kind: "directory",
        path: directoryPath,
        depth: index,
        label: parts[index] ?? directoryPath,
      });
    }

    rows.push({
      kind: "file",
      path: filePath,
      depth: parts.length - 1,
      label: parts.at(-1) ?? filePath,
    });
  }

  return rows;
}

function buildMultiRepoTreeRows(
  inspections: Array<{ worktree: TaskWorktree; filePaths: string[]; localFilePaths: string[] }>,
): InspectionTreeRow[] {
  if (inspections.length === 1) {
    return buildTreeRows(inspections[0]?.filePaths ?? []);
  }

  return inspections.flatMap((inspection) => [
    {
      kind: "directory" as const,
      path: inspection.worktree.repoId,
      depth: 0,
      label: inspection.worktree.repoId,
    },
    ...buildTreeRows(inspection.localFilePaths).map((row) => ({
      ...row,
      path: encodeRepoPath(inspection.worktree.repoId, row.path),
      depth: row.depth + 1,
    })),
  ]);
}

function encodeRepoPath(repoId: string, filePath: string): string {
  return `${repoId}:${filePath}`;
}

function decodeRepoPath(value: string): { repoId: string; path: string } {
  const separator = value.indexOf(":");
  if (separator === -1) {
    return { repoId: "", path: value };
  }

  return {
    repoId: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
}

function resolveInspectionTarget(task: TaskRecord, value: string): { worktree: TaskWorktree; path: string } {
  const decoded = decodeRepoPath(value);
  const worktree =
    decoded.repoId.length > 0
      ? task.worktrees.find((entry) => entry.repoId === decoded.repoId)
      : task.worktrees[0];

  if (!worktree) {
    throw new Error(`Task ${task.id} does not include repo ${decoded.repoId}.`);
  }

  return {
    worktree,
    path: decoded.repoId.length > 0 ? decoded.path : value,
  };
}

function resolveSelectedPath(requestedPath: string | null, validPaths: string[]): string | null {
  if (requestedPath && validPaths.includes(requestedPath)) {
    return requestedPath;
  }

  return validPaths[0] ?? null;
}

function countTextFileLines(lines: string[]): number {
  if (lines.length === 1 && lines[0] === "") {
    return 0;
  }

  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function uniqueSortedLines(value: string): string[] {
  return [...new Set(value.split("\n").map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function resolveWorktreePath(worktreePath: string, filePath: string): string {
  const resolved = path.resolve(worktreePath, filePath);
  const root = path.resolve(worktreePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`File path escapes task worktree: ${filePath}`);
  }

  return resolved;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.byteLength, 8000)).includes(0);
}

function buildEmptyContent(
  title: string,
  message: string,
  status: InspectionContent["status"],
  filePath: string | null = null,
  byteLength: number | null = null,
): InspectionContent {
  return {
    path: filePath,
    status,
    title,
    lines: [message],
    byteLength,
  };
}
