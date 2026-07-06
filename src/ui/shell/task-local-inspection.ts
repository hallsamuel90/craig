import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { TaskRecord } from "../../types/task.js";
import { runCommand, runCommandAllowingFailure } from "../../shared/exec.js";
import { assertTaskWorktreeExists } from "../../domain/task/index.js";

export const FILE_CONTENT_LIMIT_BYTES = 200 * 1024;
export const DIFF_CONTENT_LIMIT_BYTES = 500 * 1024;
const FULL_FILE_DIFF_CONTEXT_LINES = "100000";

export type InspectionTreeRow =
  | { kind: "directory"; path: string; depth: number; label: string }
  | { kind: "file"; path: string; depth: number; label: string };

export type InspectionDiffGroup = "branch" | "staged" | "unstaged" | "untracked";

export interface InspectionDiffRow {
  group: InspectionDiffGroup;
  path: string;
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
  diffContents: Record<string, InspectionContent>;
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

export async function reloadSelectedContent(
  task: TaskRecord,
  prev: TaskLocalInspection,
  selection: TaskLocalInspectionSelection,
): Promise<TaskLocalInspection> {
  if (task.type === "project" && task.repoTargets?.length) {
    return reloadProjectSelectedContent(task, prev, selection);
  }

  try {
    const selectedFilePath = resolveSelectedPath(selection.selectedFilePath ?? null, prev.filePaths);
    const selectedDiffPath = resolveSelectedPath(selection.selectedDiffPath ?? null, prev.diffPaths);
    const baseRef = selectedDiffPath ? await resolveMainComparisonRef(task.worktreePath) : null;
    const [selectedFile, selectedDiff] = await Promise.all([
      readGuardedFile(task.worktreePath, selectedFilePath),
      selectedDiffPath
        ? readGuardedDiff(task.worktreePath, selectedDiffPath, prev.diffRows, baseRef)
        : Promise.resolve(buildEmptyContent("No diff selected", "No local changes found.", "empty")),
    ]);
    const diffContents = selectedDiffPath ? { [selectedDiffPath]: selectedDiff } : {};

    return { ...prev, selectedFilePath, selectedDiffPath, diffContents, selectedFile, selectedDiff, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to inspect task worktree.";
    return { ...prev, error: message };
  }
}

async function reloadProjectSelectedContent(
  task: TaskRecord,
  prev: TaskLocalInspection,
  selection: TaskLocalInspectionSelection,
): Promise<TaskLocalInspection> {
  const selectedFilePath = resolveSelectedPath(selection.selectedFilePath ?? null, prev.filePaths);
  const selectedDiffPath = resolveSelectedPath(selection.selectedDiffPath ?? null, prev.diffPaths);

  const [selectedFile, selectedDiff] = await Promise.all([
    readProjectGuardedFile(task, selectedFilePath),
    (async () => {
      if (!selectedDiffPath) {
        return buildEmptyContent("No diff selected", "No local changes found.", "empty");
      }
      const resolved = resolveProjectTargetPath(task, selectedDiffPath);
      const baseRef = resolved ? await resolveMainComparisonRef(resolved.target.worktreePath).catch(() => null) : null;
      return readProjectGuardedDiff(task, selectedDiffPath, prev.diffRows, baseRef);
    })(),
  ]);
  const diffContents = selectedDiffPath ? { [selectedDiffPath]: selectedDiff } : {};

  return { ...prev, selectedFilePath, selectedDiffPath, diffContents, selectedFile, selectedDiff };
}

export async function loadTaskLocalInspection(
  task: TaskRecord,
  selection: TaskLocalInspectionSelection = {},
): Promise<TaskLocalInspection> {
  if (task.type === "project" && task.repoTargets?.length) {
    return loadProjectTaskLocalInspection(task, selection);
  }

  try {
    await assertTaskWorktreeExists(task);
    const baseRef = await resolveMainComparisonRef(task.worktreePath);
    const [filePaths, diffRows] = await Promise.all([
      listGitVisibleFiles(task.worktreePath),
      listDiffRows(task.worktreePath, baseRef),
    ]);
    const diffPaths = [...new Set(diffRows.map((row) => row.path))];
    const selectedFilePath = resolveSelectedPath(selection.selectedFilePath ?? null, filePaths);
    const selectedDiffPath = resolveSelectedPath(selection.selectedDiffPath ?? null, diffPaths);
    const [selectedFile, selectedDiff] = await Promise.all([
      readGuardedFile(task.worktreePath, selectedFilePath),
      selectedDiffPath
        ? readGuardedDiff(task.worktreePath, selectedDiffPath, diffRows, baseRef)
        : Promise.resolve(buildEmptyContent("No diff selected", "No local changes found.", "empty")),
    ]);
    const diffContents = selectedDiffPath ? { [selectedDiffPath]: selectedDiff } : {};

    return {
      taskId: task.id,
      fileRows: buildTreeRows(filePaths),
      filePaths,
      diffRows,
      diffPaths,
      diffContents,
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
      diffContents: {},
      selectedFilePath: null,
      selectedDiffPath: null,
      selectedFile: buildEmptyContent("Files unavailable", message, "error"),
      selectedDiff: buildEmptyContent("Diff unavailable", message, "error"),
      error: message,
    };
  }
}

async function loadProjectTaskLocalInspection(
  task: TaskRecord,
  selection: TaskLocalInspectionSelection,
): Promise<TaskLocalInspection> {
  const readyTargets = (task.repoTargets ?? []).filter((target) => target.status === "ready");

  const targetResults = await Promise.all(
    readyTargets.map(async (target) => {
      const baseRef = await resolveMainComparisonRef(target.worktreePath).catch(() => null);
      const [targetFiles, targetDiffRows] = await Promise.all([
        listGitVisibleFiles(target.worktreePath).catch(() => [] as string[]),
        listDiffRows(target.worktreePath, baseRef).catch(() => [] as InspectionDiffRow[]),
      ]);
      return { target, baseRef, targetFiles, targetDiffRows };
    }),
  );

  const filePaths: string[] = [];
  const diffRows: InspectionDiffRow[] = [];

  for (const { target, targetFiles, targetDiffRows } of targetResults) {
    filePaths.push(...targetFiles.map((filePath) => `${target.repoId}/${filePath}`));
    diffRows.push(...targetDiffRows.map((row) => ({ ...row, path: `${target.repoId}/${row.path}` })));
  }

  const diffPaths = [...new Set(diffRows.map((row) => row.path))].sort();
  const selectedFilePath = resolveSelectedPath(selection.selectedFilePath ?? null, filePaths);
  const selectedDiffPath = resolveSelectedPath(selection.selectedDiffPath ?? null, diffPaths);

  const [selectedFile, selectedDiff] = await Promise.all([
    readProjectGuardedFile(task, selectedFilePath),
    (async () => {
      if (!selectedDiffPath) {
        return buildEmptyContent("No diff selected", "No local changes found.", "empty");
      }
      const resolved = resolveProjectTargetPath(task, selectedDiffPath);
      const targetResult = resolved
        ? targetResults.find((r) => r.target.repoId === resolved.target.repoId)
        : null;
      return readProjectGuardedDiff(task, selectedDiffPath, diffRows, targetResult?.baseRef ?? null);
    })(),
  ]);
  const diffContents = selectedDiffPath ? { [selectedDiffPath]: selectedDiff } : {};

  return {
    taskId: task.id,
    fileRows: buildTreeRows(filePaths),
    filePaths,
    diffRows,
    diffPaths,
    diffContents,
    selectedFilePath,
    selectedDiffPath,
    selectedFile,
    selectedDiff,
    error: null,
  };
}

async function readProjectGuardedFile(task: TaskRecord, prefixedPath: string | null): Promise<InspectionContent> {
  const resolved = resolveProjectTargetPath(task, prefixedPath);
  if (!resolved) {
    return buildEmptyContent("No file selected", "No Git-visible files found.", "empty");
  }

  const content = await readGuardedFile(resolved.target.worktreePath, resolved.relativePath);
  return {
    ...content,
    path: prefixedPath,
    title: prefixedPath ?? content.title,
  };
}

async function readProjectGuardedDiff(
  task: TaskRecord,
  prefixedPath: string,
  rows: InspectionDiffRow[],
  baseRef: string | null = null,
): Promise<InspectionContent> {
  const resolved = resolveProjectTargetPath(task, prefixedPath);
  if (!resolved) {
    return buildEmptyContent(prefixedPath, "Repo target is unavailable.", "error", prefixedPath);
  }

  const content = await readGuardedDiff(
    resolved.target.worktreePath,
    resolved.relativePath,
    rows
      .filter((row) => row.path.startsWith(`${resolved.target.repoId}/`))
      .map((row) => ({ ...row, path: row.path.slice(resolved.target.repoId.length + 1) })),
    baseRef,
  );
  return {
    ...content,
    path: prefixedPath,
    title: prefixedPath,
  };
}

function resolveProjectTargetPath(task: TaskRecord, prefixedPath: string | null) {
  if (!prefixedPath) {
    return null;
  }

  const [repoId, ...pathParts] = prefixedPath.split("/");
  const relativePath = pathParts.join("/");
  const target = (task.repoTargets ?? []).find((entry) => entry.repoId === repoId && entry.status === "ready") ?? null;

  if (!target || relativePath.length === 0) {
    return null;
  }

  return { target, relativePath };
}

async function listGitVisibleFiles(worktreePath: string): Promise<string[]> {
  const result = await runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: worktreePath });
  return uniqueSortedLines(result.stdout);
}

async function listDiffRows(worktreePath: string, baseRef: string | null): Promise<InspectionDiffRow[]> {
  const [branch, staged, unstaged, untracked] = await Promise.all([
    listBranchRows(worktreePath, baseRef),
    listChangedRows(worktreePath, "staged"),
    listChangedRows(worktreePath, "unstaged"),
    listUntrackedRows(worktreePath),
  ]);

  return [...branch, ...staged, ...unstaged, ...untracked];
}

async function listBranchRows(worktreePath: string, baseRef: string | null): Promise<InspectionDiffRow[]> {
  if (!baseRef) {
    return [];
  }

  const [nameStatusResult, numstatResult] = await Promise.all([
    runCommand("git", ["diff", "--name-status", `${baseRef}...HEAD`], { cwd: worktreePath }),
    runCommand("git", ["diff", "--numstat", `${baseRef}...HEAD`], { cwd: worktreePath }),
  ]);
  const changedFiles = parseNameStatus(nameStatusResult.stdout);
  const numstatMap = parseNumstat(numstatResult.stdout);

  return changedFiles
    .map((entry) => {
      const stats = numstatMap.get(entry.path) ?? { additions: null, deletions: null };
      return {
        group: "branch" as const,
        path: entry.path,
        status: entry.status,
        additions: stats.additions,
        deletions: stats.deletions,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function listChangedRows(worktreePath: string, group: "staged" | "unstaged"): Promise<InspectionDiffRow[]> {
  const baseArgs = group === "staged" ? ["diff", "--cached"] : ["diff"];
  const [nameStatusResult, numstatResult] = await Promise.all([
    runCommand("git", [...baseArgs, "--name-status"], { cwd: worktreePath }),
    runCommand("git", [...baseArgs, "--numstat"], { cwd: worktreePath }),
  ]);
  const changedFiles = parseNameStatus(nameStatusResult.stdout);
  const numstatMap = parseNumstat(numstatResult.stdout);

  return changedFiles
    .map((entry) => {
      const stats = numstatMap.get(entry.path) ?? { additions: null, deletions: null };
      return {
        group,
        path: entry.path,
        status: entry.status,
        additions: stats.additions,
        deletions: stats.deletions,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
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

function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [addStr = "-", delStr = "-", ...pathParts] = trimmed.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    map.set(filePath, {
      additions: addStr === "-" ? null : Number(addStr),
      deletions: delStr === "-" ? null : Number(delStr),
    });
  }
  return map;
}

async function resolveMainComparisonRef(worktreePath: string): Promise<string | null> {
  const remoteMain = await runCommandAllowingFailure("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], {
    cwd: worktreePath,
  });
  if (remoteMain.exitCode === 0) {
    return "origin/main";
  }

  const localMain = await runCommandAllowingFailure("git", ["show-ref", "--verify", "--quiet", "refs/heads/main"], {
    cwd: worktreePath,
  });
  if (localMain.exitCode === 0) {
    return "main";
  }

  return null;
}

async function readGuardedFile(worktreePath: string, filePath: string | null): Promise<InspectionContent> {
  if (!filePath) {
    return buildEmptyContent("No file selected", "No Git-visible files found.", "empty");
  }

  const absolutePath = resolveWorktreePath(worktreePath, filePath);
  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.size > FILE_CONTENT_LIMIT_BYTES) {
      return buildEmptyContent(filePath, `File is ${fileStat.size} bytes, above the 200 KB inline preview limit.`, "too_large", filePath, fileStat.size);
    }

    const buffer = await readFile(absolutePath);
    if (isBinaryBuffer(buffer)) {
      return buildEmptyContent(filePath, "Binary file preview is not available in Craig.", "binary", filePath, buffer.byteLength);
    }

    return {
      path: filePath,
      status: "ready",
      title: filePath,
      lines: buffer.toString("utf8").split("\n"),
      byteLength: buffer.byteLength,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read file.";
    return buildEmptyContent(filePath, message, "missing", filePath, null);
  }
}

async function readGuardedDiff(
  worktreePath: string,
  filePath: string | null,
  rows: InspectionDiffRow[],
  baseRef: string | null = null,
): Promise<InspectionContent> {
  if (!filePath) {
    return buildEmptyContent("No diff selected", "No local changes found.", "empty");
  }

  const parts: string[] = [];
  const matchingGroups = rows.filter((row) => row.path === filePath).map((row) => row.group);

  if (matchingGroups.includes("branch")) {
    const resolvedBaseRef = baseRef ?? (await resolveMainComparisonRef(worktreePath));
    if (resolvedBaseRef) {
      const branch = await runCommand(
        "git",
        ["diff", "--stat", "--patch", `--unified=${FULL_FILE_DIFF_CONTEXT_LINES}`, `${resolvedBaseRef}...HEAD`, "--", filePath],
        { cwd: worktreePath },
      );
      if (branch.stdout.trim().length > 0) {
        parts.push(`branch\n${branch.stdout.trimEnd()}`);
      }
    }
  }

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
    return buildEmptyContent(filePath, "Diff is above the 500 KB inline preview limit.", "too_large", filePath, diffText.length);
  }

  if (diffText.includes("\0")) {
    return buildEmptyContent(filePath, "Binary diff preview is not available in Craig.", "binary", filePath, diffText.length);
  }

  return {
    path: filePath,
    status: diffText.length > 0 ? "ready" : "empty",
    title: filePath,
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
