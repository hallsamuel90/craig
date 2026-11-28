import type { CraigPaths } from "../../state/craig-paths.js";
import type { CraigConfig } from "../../domain/config/index.js";
import type { CommandCreateTaskResult, TaskCreationOptions } from "../../domain/task/index.js";
import type { taskService } from "../../domain/task/index.js";
import type { workspaceService } from "../../domain/workspace/index.js";

export type ActionContext = {
  paths: CraigPaths;
  config: CraigConfig;
  taskService: typeof taskService;
  workspaceService: typeof workspaceService;
  // eslint-disable-next-line no-unused-vars
  createRuntimeTask?: (targetId: string, prompt: string, options: TaskCreationOptions) => Promise<CommandCreateTaskResult>;
  queueTaskMutation: <T>(fn: () => Promise<T>) => Promise<T>; // eslint-disable-line no-unused-vars
};
