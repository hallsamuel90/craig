import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

import type { CommandLogsResult } from "../../../commands/types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { getTask, resolveTaskLogPath } from "./inspect.js";

export const prepareTaskLogs = async (
  paths: CraigPaths,
  taskId: string,
): Promise<CommandLogsResult> => {
  const task = await getTask(paths, taskId);
  const logPath = resolveTaskLogPath(paths, task);

  if (!logPath) {
    throw new Error(`Task ${task.id} does not have a Craig-managed log path.`);
  }

  try {
    await access(logPath);
  } catch {
    throw new Error(`Task ${task.id} log file does not exist yet at ${logPath}.`);
  }

  return {
    kind: "streamTaskLogs",
    taskId: task.id,
    logPath,
  };
};

export const streamTaskLogs = async (logPath: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let interrupted = false;
    const child = spawn("tail", ["-n", "+1", "-f", logPath], {
      stdio: "inherit",
    });

    const handleSigint = () => {
      interrupted = true;
      child.kill("SIGINT");
    };

    process.on("SIGINT", handleSigint);

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("exit", (code, signal) => {
      cleanup();

      if (interrupted || signal === "SIGINT") {
        resolve();
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`tail -n +1 -f ${logPath} failed with exit code ${code ?? "unknown"}.`));
    });

    function cleanup() {
      process.off("SIGINT", handleSigint);
    }
  });
};
