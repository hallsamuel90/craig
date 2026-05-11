import { spawn } from "node:child_process";

import type { CommandOpenResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readCraigConfig } from "../state/config-store.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";
import { getTaskBundlePath } from "./task-worktrees.js";

export async function openTask(paths: CraigPaths, taskId: string): Promise<CommandOpenResult> {
  const task = await getTaskOrThrow(paths, taskId);

  await assertTaskWorktreeExists(task);
  const openPath = getTaskBundlePath(task);

  const config = await readCraigConfig(paths);
  const openCommand = config.open?.command ?? [];

  if (openCommand.length === 0) {
    return {
      kind: "openTask",
      taskId: task.id,
      worktreePath: openPath,
      launched: false,
      command: null,
    };
  }

  const command = [...openCommand, openPath];
  await runOpenCommand(command, paths.repoRoot);

  return {
    kind: "openTask",
    taskId: task.id,
    worktreePath: openPath,
    launched: true,
    command,
  };
}

async function runOpenCommand(command: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const [file, ...args] = command;
    const child = spawn(file!, args, {
      cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}
