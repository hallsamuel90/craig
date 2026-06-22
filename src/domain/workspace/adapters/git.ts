import { realpath } from "node:fs/promises";
import path from "node:path";

import { runCommand, runCommandAllowingFailure } from "../../../utils/exec.js";

export const isGitRepo = async (rootPath: string): Promise<boolean> => {
  try {
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: rootPath });
    const gitTopLevel = result.stdout.trim();
    const [resolvedGitTop, resolvedRoot] = await Promise.all([
      realpath(gitTopLevel).catch(() => path.resolve(gitTopLevel)),
      realpath(rootPath).catch(() => path.resolve(rootPath)),
    ]);
    return resolvedGitTop === resolvedRoot;
  } catch {
    return false;
  }
};

export const getDefaultBranch = async (rootPath: string): Promise<string> => {
  const originHead = await runCommandAllowingFailure(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: rootPath },
  );
  const originHeadBranch = originHead.stdout.trim().replace(/^origin\//, "");
  if (originHead.exitCode === 0 && originHeadBranch.length > 0) {
    return originHeadBranch;
  }

  for (const branchName of ["main", "master", "trunk"]) {
    const branchExists = await runCommandAllowingFailure(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      { cwd: rootPath },
    );
    if (branchExists.exitCode === 0) {
      return branchName;
    }
  }

  const result = await runCommand("git", ["branch", "--show-current"], { cwd: rootPath });
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : "HEAD";
};
