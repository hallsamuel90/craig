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
  baseBranch = "main",
): Promise<void> {
  const normalizedBaseBranch = baseBranch.trim() || "main";
  const baseBranchExists = await runCommandAllowingFailure(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${normalizedBaseBranch}`],
    { cwd: repoRoot },
  );

  if (baseBranchExists.exitCode !== 0) {
    throw new Error(`Base branch '${normalizedBaseBranch}' does not exist locally.`);
  }

  const baseRef = await resolveWorktreeBaseRef(repoRoot, normalizedBaseBranch);

  await runCommand("git", ["worktree", "add", "-b", branch, worktreePath, baseRef], {
    cwd: repoRoot,
  });
}

async function resolveWorktreeBaseRef(repoRoot: string, baseBranch: string): Promise<string> {
  const hasOrigin = await runCommandAllowingFailure("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
  });

  if (hasOrigin.exitCode !== 0) {
    return baseBranch;
  }

  const fetchOriginBranch = await runCommandAllowingFailure("git", ["fetch", "origin", baseBranch], {
    cwd: repoRoot,
  });

  if (fetchOriginBranch.exitCode !== 0) {
    return baseBranch;
  }

  const hasRemoteBaseBranch = await runCommandAllowingFailure(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`],
    { cwd: repoRoot },
  );

  return hasRemoteBaseBranch.exitCode === 0 ? `refs/remotes/origin/${baseBranch}` : baseBranch;
}

export async function hasUncommittedDiff(worktreePath: string): Promise<boolean> {
  const result = await runCommandAllowingFailure("git", ["status", "--short"], {
    cwd: worktreePath,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to inspect git status.");
  }

  return result.stdout.trim().length > 0;
}

export async function stageAllChanges(worktreePath: string): Promise<void> {
  await runCommand("git", ["add", "-A"], { cwd: worktreePath });
}

export async function commitAllChanges(worktreePath: string, message: string): Promise<void> {
  await runCommand("git", ["commit", "-m", message], { cwd: worktreePath });
}

export async function getHeadCommit(worktreePath: string): Promise<{ sha: string; message: string }> {
  const result = await runCommand("git", ["show", "-s", "--format=%H%n%s", "HEAD"], { cwd: worktreePath });
  const [sha = "", message = ""] = result.stdout.trim().split("\n");

  if (!sha || !message) {
    throw new Error("Unable to read git HEAD commit metadata.");
  }

  return { sha, message };
}

export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  return !(await hasUncommittedDiff(worktreePath));
}

export async function ensureOriginRemote(worktreePath: string): Promise<void> {
  await runCommand("git", ["remote", "get-url", "origin"], { cwd: worktreePath });
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await runCommand("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
}
