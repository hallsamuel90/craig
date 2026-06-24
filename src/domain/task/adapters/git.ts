import { runCommand, runCommandAllowingFailure } from "../../../shared/exec.js";

export const branchExists = async (repoRoot: string, branch: string): Promise<boolean> => {
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
};

export const createWorktree = async (
  repoRoot: string,
  branch: string,
  worktreePath: string,
  baseBranch = "main",
): Promise<void> => {
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
};

const resolveWorktreeBaseRef = async (repoRoot: string, baseBranch: string): Promise<string> => {
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
};

export const hasUncommittedDiff = async (worktreePath: string): Promise<boolean> => {
  const result = await runCommandAllowingFailure("git", ["status", "--short"], {
    cwd: worktreePath,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to inspect git status.");
  }

  return result.stdout.trim().length > 0;
};

export const stageAllChanges = async (worktreePath: string): Promise<void> => {
  await runCommand("git", ["add", "-A"], { cwd: worktreePath });
};

export const commitAllChanges = async (worktreePath: string, message: string): Promise<void> => {
  await runCommand("git", ["commit", "-m", message], { cwd: worktreePath });
};

export const getHeadCommit = async (worktreePath: string): Promise<{ sha: string; message: string }> => {
  const result = await runCommand("git", ["show", "-s", "--format=%H%n%s", "HEAD"], { cwd: worktreePath });
  const [sha = "", message = ""] = result.stdout.trim().split("\n");

  if (!sha || !message) {
    throw new Error("Unable to read git HEAD commit metadata.");
  }

  return { sha, message };
};

export const isWorktreeClean = async (worktreePath: string): Promise<boolean> => {
  return !(await hasUncommittedDiff(worktreePath));
};

export const ensureOriginRemote = async (worktreePath: string): Promise<void> => {
  await runCommand("git", ["remote", "get-url", "origin"], { cwd: worktreePath });
};

export const pushBranch = async (worktreePath: string, branch: string): Promise<void> => {
  await runCommand("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
};

export const removeWorktree = async (repoRoot: string, worktreePath: string): Promise<void> => {
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
};
