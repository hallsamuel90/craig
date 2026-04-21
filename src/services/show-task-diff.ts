import type { CommandDiffResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";

export async function showTaskDiff(paths: CraigPaths, taskId: string): Promise<CommandDiffResult> {
  const task = await getTaskOrThrow(paths, taskId);

  await assertTaskWorktreeExists(task);

  const status = await runCommand("git", ["status", "--short"], { cwd: task.worktreePath });

  if (status.stdout.trim().length === 0) {
    return {
      kind: "showTaskDiff",
      taskId: task.id,
      diffText: "",
      isEmpty: true,
    };
  }

  const diffText = await buildWorktreeDiff(task.worktreePath);

  return {
    kind: "showTaskDiff",
    taskId: task.id,
    diffText,
    isEmpty: false,
  };
}

async function buildWorktreeDiff(worktreePath: string): Promise<string> {
  const parts: string[] = [];
  const trackedDiff = await runCommand("git", ["diff", "--stat", "--patch", "HEAD"], {
    cwd: worktreePath,
  });

  if (trackedDiff.stdout.trim().length > 0) {
    parts.push(trackedDiff.stdout.trimEnd());
  }

  const untrackedFiles = await listUntrackedFiles(worktreePath);

  for (const filePath of untrackedFiles) {
    const untrackedDiff = await runCommandAllowingFailure(
      "git",
      ["diff", "--no-index", "--stat", "--patch", "--", "/dev/null", filePath],
      { cwd: worktreePath },
    );
    parts.push(untrackedDiff.stdout.trimEnd());
  }

  return parts.join("\n\n");
}

async function listUntrackedFiles(worktreePath: string): Promise<string[]> {
  const result = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: worktreePath,
  });

  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
