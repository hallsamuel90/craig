import { spawn } from "node:child_process";

import type { CommandOpenResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { configService } from "../domain/config/index.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";

export async function openTask(paths: CraigPaths, taskId: string): Promise<CommandOpenResult> {
  const task = await getTaskOrThrow(paths, taskId);

  await assertTaskWorktreeExists(task);

  const config = await configService.load(paths);
  const openCommand = config.open?.command ?? [];

  if (openCommand.length === 0) {
    return {
      kind: "openTask",
      taskId: task.id,
      worktreePath: task.worktreePath,
      launched: false,
      command: null,
    };
  }

  const command = [...openCommand, task.worktreePath];
  await runOpenCommand(command, paths.repoRoot);

  return {
    kind: "openTask",
    taskId: task.id,
    worktreePath: task.worktreePath,
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
