import { spawn } from "node:child_process";

import type { CommandOpenResult } from "../../../types/command.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { configService } from "../../config/index.js";
import { assertTaskWorktreeExists, getTask } from "./inspect.js";

export const openTask = async (paths: CraigPaths, taskId: string): Promise<CommandOpenResult> => {
  const task = await getTask(paths, taskId);

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
};

const runOpenCommand = async (command: string[], cwd: string): Promise<void> => {
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
};
