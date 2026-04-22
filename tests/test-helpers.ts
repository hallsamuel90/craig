import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCraigPaths } from "../src/state/craig-paths.js";
import type { TaskRecord } from "../src/types/task.js";
import { runCommand } from "../src/utils/exec.js";

export async function createRepoRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createCraigState(repoRoot: string, taskIds: string[] = []) {
  const paths = getCraigPaths(repoRoot);

  await mkdir(paths.craigDir, { recursive: true });
  await Promise.all([
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.tasksDir, { recursive: true }),
    mkdir(paths.jobsDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.worktreesDir, { recursive: true }),
  ]);

  await writeFile(
    paths.indexFile,
    JSON.stringify(
      {
        version: 1,
        repoRoot,
        taskIds,
        jobIds: [],
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
      null,
      2,
    ),
  );

  return paths;
}

export async function createGitRepo(repoRoot: string): Promise<void> {
  await runCommand("git", ["init", "-b", "main"], { cwd: repoRoot });
  await runCommand("git", ["config", "user.name", "Craig Tests"], { cwd: repoRoot });
  await runCommand("git", ["config", "user.email", "craig@example.com"], { cwd: repoRoot });
}

export async function writeTaskRecord(repoRoot: string, task: Partial<TaskRecord> & { id: string }) {
  const paths = getCraigPaths(repoRoot);
  const record = buildTaskRecord(repoRoot, task);

  await writeFile(`${paths.tasksDir}/${record.id}.json`, JSON.stringify(record, null, 2), "utf8");

  return record;
}

export function buildTaskRecord(
  repoRoot: string,
  task: Partial<TaskRecord> & { id: string },
): TaskRecord {
  const paths = getCraigPaths(repoRoot);
  const now = "2026-04-21T00:00:00.000Z";

  return {
    id: task.id,
    title: task.title ?? "test task",
    slug: task.slug ?? "test-task",
    type: "repo",
    status: task.status ?? "running",
    runner: task.runner ?? "cursor",
    repoRoot,
    worktreePath: task.worktreePath ?? path.join(paths.worktreesDir, task.id),
    branch: task.branch ?? `craig/${task.id}`,
    tmuxTarget: task.tmuxTarget ?? "%42",
    tmuxWindowTarget: task.tmuxWindowTarget ?? "@1",
    tmuxPage: task.tmuxPage ?? 1,
    layoutSlot: task.layoutSlot ?? 1,
    runnerSession: task.runnerSession ?? {
      command: ["cursor", "agent", task.title ?? "test task"],
      tmuxTarget: task.tmuxTarget ?? "%42",
      pid: null,
      startedAt: now,
      lastKnownState: "running",
      exitCode: null,
      exitedAt: null,
    },
    prompt: task.prompt ?? {
      source: "inline",
      value: task.title ?? "test task",
    },
    checks: task.checks ?? {
      source: {
        type: "repo_config",
        path: ".craig/config.json",
      },
      lastRunAt: null,
      status: "not_run",
      commands: [],
      results: [],
    },
    lastCommit: task.lastCommit ?? null,
    pullRequest: task.pullRequest ?? {
      provider: "github",
      number: null,
      url: null,
      baseBranch: null,
      headBranch: null,
      status: null,
      mergeable: false,
      mergeStateStatus: null,
      requiredChecks: [],
      lastSyncedAt: null,
    },
    artifacts: task.artifacts ?? {
      logPath: `.craig/logs/${task.id}.log`,
      checkSummaryPath: `.craig/artifacts/${task.id}/check-summary.json`,
      prDraftPath: null,
      prStatusPath: `.craig/artifacts/${task.id}/pr-status.json`,
    },
    cleanup: task.cleanup ?? {
      paneClosedAt: null,
      worktreeRemovedAt: null,
      preservedWorktree: false,
      warning: null,
    },
    lastFailureReason: task.lastFailureReason ?? null,
    createdAt: task.createdAt ?? now,
    updatedAt: task.updatedAt ?? now,
  };
}

export async function createStubCommands(root: string): Promise<string> {
  const stubDir = path.join(root, "stubs");
  await mkdir(stubDir, { recursive: true });

  const gitScript = path.join(stubDir, "git-stub.sh");
  const tmuxScript = path.join(stubDir, "tmux-stub.sh");
  const cursorScript = path.join(stubDir, "cursor-stub.sh");
  const ghScript = path.join(stubDir, "gh-stub.sh");
  const scriptLog = path.join(stubDir, "script-log.sh");

  await writeFile(
    gitScript,
    `#!/bin/sh
set -eu
if [ "$1" = "show-ref" ] && [ "$2" = "--verify" ] && [ "$3" = "--quiet" ]; then
  ref="$4"
  if [ "$ref" = "refs/heads/main" ]; then
    exit 0
  fi
  case ",\${CRAIG_TEST_GIT_EXISTING_BRANCHES:-}," in
    *,"$ref",*) exit 0 ;;
    *) exit 1 ;;
  esac
fi
if [ "$1" = "worktree" ] && [ "$2" = "add" ] && [ "$3" = "-b" ]; then
  if [ "\${CRAIG_TEST_GIT_WORKTREE_FAIL:-0}" = "1" ]; then
    echo "worktree failure" >&2
    exit 1
  fi
  mkdir -p "$5"
  exit 0
fi
echo "unsupported git stub invocation: $*" >&2
exit 1
`,
    "utf8",
  );

  await writeFile(
    tmuxScript,
    `#!/bin/sh
set -eu
state_file="\${CRAIG_TEST_TMUX_STATE_FILE:-}"
command_log="\${CRAIG_TEST_TMUX_COMMAND_LOG:-}"
window_target="\${CRAIG_TEST_TMUX_WINDOW_TARGET:-@0}"
control_pane_id="\${CRAIG_TEST_TMUX_CONTROL_PANE_ID:-%1}"
split_fail="\${CRAIG_TEST_TMUX_SPLIT_FAIL:-0}"
new_window_pane_id="\${CRAIG_TEST_TMUX_NEW_WINDOW_PANE_ID:-%84}"
new_window_target="\${CRAIG_TEST_TMUX_NEW_WINDOW_TARGET:-@1}"
if [ "\${CRAIG_TEST_TMUX_FAIL:-0}" = "1" ]; then
  echo "tmux failure" >&2
  exit 1
fi
if [ -n "$command_log" ]; then
  printf "%s\\n" "$*" >> "$command_log"
fi
case "$1" in
  has-session)
    [ -n "$state_file" ] && [ -f "$state_file" ] && exit 0
    exit 1
    ;;
  new-session)
    [ -n "$state_file" ] && : > "$state_file"
    if [ "$4" = "-F" ]; then
      echo "$window_target $control_pane_id"
    fi
    exit 0
    ;;
  list-windows)
    echo "$window_target"
    exit 0
    ;;
  list-panes)
    if [ "$4" = "-t" ] && [ "$5" = "$window_target" ]; then
      echo "$control_pane_id"
      echo "%42"
      exit 0
    fi
    echo "$new_window_pane_id"
    exit 0
    ;;
  split-window)
    if [ "$split_fail" = "1" ]; then
      echo "no space for new pane" >&2
      exit 1
    fi
    echo "%42"
    exit 0
    ;;
  new-window)
    echo "$new_window_target $new_window_pane_id"
    exit 0
    ;;
  pipe-pane)
    exit 0
    ;;
  select-layout)
    exit 0
    ;;
  resize-pane)
    exit 0
    ;;
  select-window)
    exit 0
    ;;
  select-pane)
    exit 0
    ;;
  switch-client)
    exit 0
    ;;
  attach-session)
    exit 0
    ;;
  kill-pane)
    exit 0
    ;;
  send-keys)
    exit 0
    ;;
esac
echo "unsupported tmux stub invocation: $*" >&2
exit 1
`,
    "utf8",
  );

  await writeFile(
    scriptLog,
    `#!/bin/sh
set -eu
log_file="$1"
shift
printf "%s\\n" "$*" >> "$log_file"
`,
    "utf8",
  );

  await writeFile(
    cursorScript,
    `#!/bin/sh
set -eu
if [ "$1" = "agent" ] && [ "$2" = "--help" ]; then
  exit 0
fi
echo "unsupported cursor stub invocation: $*" >&2
exit 1
`,
    "utf8",
  );

  await writeFile(
    ghScript,
    `#!/bin/sh
set -eu
mode="\${CRAIG_TEST_GH_MODE:-success}"
pr_number="\${CRAIG_TEST_GH_PR_NUMBER:-17}"
pr_url="\${CRAIG_TEST_GH_PR_URL:-https://github.com/example/repo/pull/17}"
view_file="\${CRAIG_TEST_GH_VIEW_FILE:-}"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "$mode" = "auth-fail" ]; then
    echo "gh auth failed" >&2
    exit 1
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "$pr_url"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -n "$view_file" ]; then
    cat "$view_file"
    exit 0
  fi
  cat <<EOF
{"number":$pr_number,"url":"$pr_url","baseRefName":"main","headRefName":"craig/task_1","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[]}
EOF
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  exit 0
fi
echo "unsupported gh stub invocation: $*" >&2
exit 1
`,
    "utf8",
  );

  await chmod(gitScript, 0o755);
  await chmod(tmuxScript, 0o755);
  await chmod(cursorScript, 0o755);
  await chmod(ghScript, 0o755);
  await chmod(scriptLog, 0o755);

  await symlink("git-stub.sh", path.join(stubDir, "git"));
  await symlink("tmux-stub.sh", path.join(stubDir, "tmux"));
  await symlink("cursor-stub.sh", path.join(stubDir, "cursor"));
  await symlink("gh-stub.sh", path.join(stubDir, "gh"));

  return stubDir;
}

export function getDateSegment(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}
