import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runCommandAllowingFailure(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );

  if (result.exitCode === 0) {
    return true;
  }

  if (result.exitCode === 1) {
    return false;
  }

  throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to check git branch state.");
}

export async function createWorktree(
  repoRoot: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  const baseBranchExists = await runCommandAllowingFailure(
    "git",
    ["show-ref", "--verify", "--quiet", "refs/heads/main"],
    { cwd: repoRoot },
  );

  if (baseBranchExists.exitCode !== 0) {
    throw new Error("Base branch 'main' does not exist locally.");
  }

  await runCommand("git", ["worktree", "add", "-b", branch, worktreePath, "main"], {
    cwd: repoRoot,
  });
}
