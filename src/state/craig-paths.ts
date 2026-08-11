import path from "node:path";

export interface CraigPaths {
  workspaceRoot: string;
  // Kept as a compatibility alias for deferred repo-scoped services.
  repoRoot: string;
  craigDir: string;
  indexFile: string;
  reposDir: string;
  workspacesDir: string;
  sessionsDir: string;
  runtimeDir: string;
  uiStateFile: string;
  tasksDir: string;
  jobsDir: string;
  commandsDir: string;
  eventsDir: string;
  orchestrationDir: string;
  logsDir: string;
  logFile: string;
  artifactsDir: string;
  worktreesDir: string;
  configFile: string;
}

export function getCraigPaths(workspaceRoot: string): CraigPaths {
  const craigDir = path.join(workspaceRoot, ".craig");

  return {
    workspaceRoot,
    repoRoot: workspaceRoot,
    craigDir,
    indexFile: path.join(craigDir, "index.json"),
    reposDir: path.join(craigDir, "repos"),
    workspacesDir: path.join(craigDir, "workspaces"),
    sessionsDir: path.join(craigDir, "sessions"),
    runtimeDir: path.join(craigDir, "runtime"),
    uiStateFile: path.join(craigDir, "runtime", "ui-state.json"),
    tasksDir: path.join(craigDir, "tasks"),
    jobsDir: path.join(craigDir, "jobs"),
    commandsDir: path.join(craigDir, "commands"),
    eventsDir: path.join(craigDir, "events"),
    orchestrationDir: path.join(craigDir, "orchestration"),
    logsDir: path.join(craigDir, "logs"),
    logFile: path.join(craigDir, "logs", "craig.jsonl"),
    artifactsDir: path.join(craigDir, "artifacts"),
    worktreesDir: path.join(craigDir, "worktrees"),
    configFile: path.join(craigDir, "config.json"),
  };
}
