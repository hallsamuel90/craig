import type { AppCommand } from "./types.js";
import { executeCommand } from "./command-router.js";
import { formatCommandResult, formatEventLine } from "./format-result.js";
import { formatJsonError, formatJsonSuccess } from "./format-json.js";
import { hasJsonOutputFlag, parseArgv } from "./parse-argv.js";
import { CraigError, toCraigError } from "../domain/error/index.js";
import { resolveCliContext } from "../shell/context.js";

export interface RunCliOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  isInputTty: boolean;
  isOutputTty: boolean;
  /* eslint-disable-next-line no-unused-vars */
  writeStdout: (_value: string) => void;
  /* eslint-disable-next-line no-unused-vars */
  writeStderr: (_value: string) => void;
  /* eslint-disable-next-line no-unused-vars */
  runInteractive: (_workspaceRoot: string) => Promise<number>;
  readStdin?: () => Promise<string>;
  signal?: AbortSignal;
}

export async function runCli(options: RunCliOptions): Promise<number> {
  let commandName = "cli";
  let jsonOutput = hasJsonOutputFlag(options.argv);

  try {
    const parsed = parseArgv(options.argv);
    jsonOutput = parsed.options.json;

    if (parsed.mode === "interactive") {
      if (
        parsed.options.noInput ||
        parsed.options.json ||
        isCiEnvironment(options.env) ||
        !options.isInputTty ||
        !options.isOutputTty
      ) {
        throw new CraigError(
          "INPUT_REQUIRED",
          "Interactive Craig requires a TTY. Provide a command instead of starting the terminal application.",
          {},
        );
      }

      const context = await resolveCliContext({
        cwd: options.cwd,
        ...(parsed.options.workspaceRoot !== undefined
          ? { explicitWorkspaceRoot: parsed.options.workspaceRoot }
          : {}),
        ...(options.env.CRAIG_WORKSPACE_ROOT !== undefined
          ? { environmentWorkspaceRoot: options.env.CRAIG_WORKSPACE_ROOT }
          : {}),
        allowUninitializedWorkspace: true,
      });
      return options.runInteractive(context.workspace.workspaceRoot);
    }

    if (!parsed.command || !parsed.commandName) {
      throw new CraigError("CLI_USAGE", "Command mode requires a command.", {});
    }

    commandName = parsed.commandName;
    if (parsed.command.kind === "watchEvents" && parsed.options.json) {
      throw new CraigError("CLI_USAGE", "events watch streams output; use --format jsonl instead of --json.", {});
    }
    assertCompatibleTaskTargets(parsed.command, parsed.options.taskId);
    const command = bindGlobalTaskTarget(parsed.command, parsed.options.taskId);
    const taskResolution = getTaskResolution(command);
    assertTaskOptionApplies(command, parsed.options.taskId, taskResolution);
    const resolvesTaskContext = taskResolution !== "none";
    const context = await resolveCliContext({
      cwd: options.cwd,
      ...(parsed.options.workspaceRoot !== undefined
        ? { explicitWorkspaceRoot: parsed.options.workspaceRoot }
        : {}),
      ...(options.env.CRAIG_WORKSPACE_ROOT !== undefined
        ? { environmentWorkspaceRoot: options.env.CRAIG_WORKSPACE_ROOT }
        : {}),
      ...(resolvesTaskContext && parsed.options.taskId !== undefined
        ? { explicitTaskId: parsed.options.taskId }
        : {}),
      ...(resolvesTaskContext && options.env.CRAIG_TASK_ID !== undefined
        ? { environmentTaskId: options.env.CRAIG_TASK_ID }
        : {}),
      ...(resolvesTaskContext && options.env.CRAIG_AGENT_TAB_ID !== undefined
        ? { environmentAgentTabId: options.env.CRAIG_AGENT_TAB_ID }
        : {}),
      allowUninitializedWorkspace: allowsUninitializedWorkspace(command),
      resolveTask: taskResolution !== "none",
      requireTask: taskResolution === "required",
    });
    const cancellation = createCommandCancellation(command, options.signal);
    let result: Awaited<ReturnType<typeof executeCommand>>;
    try {
      result = await executeCommand(command, {
        paths: context.paths,
        workspaceContext: context.workspace,
        taskContext: context.task,
        ...(cancellation.signal ? { signal: cancellation.signal } : {}),
        ...(command.kind === "watchEvents" ? {
          emitEvent: (event) => options.writeStdout(`${command.format === "jsonl" ? JSON.stringify(event) : formatEventLine(event)}\n`),
        } : {}),
        ...(options.readStdin ? { readStdin: options.readStdin } : {}),
      });
    } finally {
      cancellation.dispose();
    }
    const output = jsonOutput
      ? formatJsonSuccess(commandName, result)
      : formatCommandResult(result);

    if (output.length > 0) {
      options.writeStdout(`${output}\n`);
    }
    return 0;
  } catch (error) {
    const craigError = toCraigError(error);
    const output = jsonOutput
      ? formatJsonError(commandName, craigError)
      : craigError.message;
    options.writeStderr(`${output}\n`);
    return craigError.exitCode;
  }
}

function allowsUninitializedWorkspace(command: AppCommand): boolean {
  return [
    "addWorkspace",
    "addRepo",
    "listRepos",
    "listWorkspaces",
    "help",
  ].includes(command.kind);
}

function getTaskResolution(command: AppCommand): "none" | "optional" | "required" {
  if (command.kind === "showContext") {
    return "optional";
  }
  if (command.kind === "currentTask" || command.kind === "showCurrentTask") {
    return "required";
  }
  if (isTaskPrCommand(command)) {
    return command.taskId ? "none" : "required";
  }
  if (command.kind === "listAgents" || command.kind === "showAgentStatus") {
    return "none";
  }
  if (command.kind === "listEvents" || command.kind === "watchEvents") {
    return "none";
  }
  if (command.kind === "sendAgentPrompt") {
    return command.taskId ? "none" : "required";
  }
  if (command.kind === "listPromptCommands") return "none";
  if (command.kind === "waitTask") {
    return command.taskId ? "none" : "required";
  }
  return "none";
}

function assertCompatibleTaskTargets(command: AppCommand, globalTaskId: string | undefined): void {
  const positionalTaskId = getPositionalTaskId(command);
  if (positionalTaskId === undefined || globalTaskId === undefined || globalTaskId === positionalTaskId) {
    return;
  }

  throw new CraigError(
    "CLI_USAGE",
    `Task ${positionalTaskId} conflicts with --task ${globalTaskId}. Provide only one task target.`,
    { details: { positionalTaskId, globalTaskId } },
  );
}

function assertTaskOptionApplies(
  command: AppCommand,
  globalTaskId: string | undefined,
  resolution: ReturnType<typeof getTaskResolution>,
): void {
  if (
    globalTaskId === undefined ||
    resolution !== "none" ||
    getPositionalTaskId(command) === globalTaskId
  ) {
    return;
  }

  throw new CraigError(
    "CLI_USAGE",
    `--task is not supported by ${command.kind}. Use it with context show, task current, or task show without an id.`,
    { details: { commandKind: command.kind, globalTaskId } },
  );
}

function getPositionalTaskId(command: AppCommand): string | undefined {
  switch (command.kind) {
    case "showTask":
    case "attachTask":
    case "listTaskLinks":
    case "streamTaskLogs":
    case "showTaskDiff":
    case "focusTask":
    case "openTask":
    case "runChecks":
    case "commitTask":
    case "waitTask":
    case "listAgents":
    case "showAgentStatus":
    case "listEvents":
    case "watchEvents":
    case "sendAgentPrompt":
    case "listPromptCommands":
      return command.taskId;
    case "showTaskPr":
    case "discoverTaskPr":
    case "linkTaskPr":
    case "refreshTaskPr":
    case "unlinkTaskPr":
      return command.taskId;
    case "addTaskLink":
      return command.taskId;
    default:
      return undefined;
  }
}

function bindGlobalTaskTarget(command: AppCommand, globalTaskId: string | undefined): AppCommand {
  if (!globalTaskId) return command;
  if (
    command.kind === "listAgents" || command.kind === "showAgentStatus" || command.kind === "waitTask" ||
    command.kind === "listEvents" || command.kind === "watchEvents"
    || command.kind === "sendAgentPrompt" || command.kind === "listPromptCommands"
  ) {
    return { ...command, taskId: command.taskId ?? globalTaskId };
  }
  return command;
}

function createCommandCancellation(
  command: AppCommand,
  providedSignal: AbortSignal | undefined,
): { signal?: AbortSignal; dispose(): void } {
  if (command.kind !== "waitTask" && command.kind !== "watchEvents" && command.kind !== "waitPromptCommand") {
    return { dispose: () => undefined };
  }
  if (providedSignal) return { signal: providedSignal, dispose: () => undefined };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  return {
    signal: controller.signal,
    dispose: () => process.removeListener("SIGINT", cancel),
  };
}

function isTaskPrCommand(
  command: AppCommand,
): command is Extract<AppCommand, {
  kind: "showTaskPr" | "discoverTaskPr" | "linkTaskPr" | "refreshTaskPr" | "unlinkTaskPr";
}> {
  return [
    "showTaskPr",
    "discoverTaskPr",
    "linkTaskPr",
    "refreshTaskPr",
    "unlinkTaskPr",
  ].includes(command.kind);
}

function isCiEnvironment(env: Record<string, string | undefined>): boolean {
  const value = env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}
