import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCraigPaths } from "../src/state/craig-paths.js";

export async function createRepoRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createCraigState(repoRoot: string, taskIds: string[] = []) {
  const paths = getCraigPaths(repoRoot);

  await mkdir(paths.craigDir, { recursive: true });
  await Promise.all([
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

export async function createStubCommands(root: string): Promise<string> {
  const stubDir = path.join(root, "stubs");
  await mkdir(stubDir, { recursive: true });

  const gitScript = path.join(stubDir, "git-stub.sh");
  const tmuxScript = path.join(stubDir, "tmux-stub.sh");
  const cursorScript = path.join(stubDir, "cursor-stub.sh");
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
      echo "$window_target"
    fi
    exit 0
    ;;
  list-windows)
    echo "$window_target"
    exit 0
    ;;
  split-window)
    echo "%42"
    exit 0
    ;;
  pipe-pane)
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

  await chmod(gitScript, 0o755);
  await chmod(tmuxScript, 0o755);
  await chmod(cursorScript, 0o755);
  await chmod(scriptLog, 0o755);

  await symlink("git-stub.sh", path.join(stubDir, "git"));
  await symlink("tmux-stub.sh", path.join(stubDir, "tmux"));
  await symlink("cursor-stub.sh", path.join(stubDir, "cursor"));

  return stubDir;
}

export function getDateSegment(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}
