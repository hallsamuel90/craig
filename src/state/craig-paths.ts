import path from "node:path";

export interface CraigPaths {
  repoRoot: string;
  craigDir: string;
  indexFile: string;
  runtimeDir: string;
  sessionFile: string;
  tasksDir: string;
  jobsDir: string;
  logsDir: string;
  artifactsDir: string;
  worktreesDir: string;
  configFile: string;
}

export function getCraigPaths(repoRoot: string): CraigPaths {
  const craigDir = path.join(repoRoot, ".craig");

  return {
    repoRoot,
    craigDir,
    indexFile: path.join(craigDir, "index.json"),
    runtimeDir: path.join(craigDir, "runtime"),
    sessionFile: path.join(craigDir, "runtime", "session.json"),
    tasksDir: path.join(craigDir, "tasks"),
    jobsDir: path.join(craigDir, "jobs"),
    logsDir: path.join(craigDir, "logs"),
    artifactsDir: path.join(craigDir, "artifacts"),
    worktreesDir: path.join(craigDir, "worktrees"),
    configFile: path.join(craigDir, "config.json"),
  };
}
