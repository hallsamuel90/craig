import { executeCommand, type CommandContext } from "../commands/command-router.js";
import { parseReplCommand } from "../commands/parse-repl.js";
import { renderInteractiveLayout } from "./render-layout.js";
import {
  canUseInteractiveTerminal,
  createTerminalSession,
  type TerminalEvent,
  type TerminalSession,
} from "./terminal-io.js";
import { formatCommandResult } from "../main.js";
import { listTasks } from "../services/list-tasks.js";
import { resolveSelectedTaskId, sortTasksForDisplay } from "../services/task-selection.js";
import { streamTaskLogs } from "../services/stream-task-logs.js";
import {
  getDefaultUiRuntime,
  readSessionRuntime,
  writeSessionRuntime,
  type CraigSessionRuntime,
  type CraigUiRuntime,
} from "../state/runtime-store.js";
import type { TaskRecord } from "../types/task.js";

interface InteractiveAppOptions {
  terminal?: TerminalSession;
}

interface InteractiveState {
  commandBuffer: string;
  outputLines: string[];
  recentEvent: string | null;
  selectedTaskId: string | null;
  sigintCount: number;
}

export async function startInteractiveApp(
  context: CommandContext,
  options?: InteractiveAppOptions,
): Promise<number> {
  if (!options?.terminal && !canUseInteractiveTerminal()) {
    throw new Error("Interactive terminal surface unavailable.");
  }

  const terminal = options?.terminal ?? createTerminalSession();
  let { runtime, tasks, ui } = await loadInteractiveState(context, null);
  const initialUi = ui ?? getDefaultUiRuntime();
  const state: InteractiveState = {
    commandBuffer: initialUi.lastCommandBuffer,
    outputLines: initialUi.lastOutputLines,
    recentEvent: initialUi.lastOutputLines[0] ?? null,
    selectedTaskId: resolveSelectedTaskId(tasks, initialUi.selectedTaskId),
    sigintCount: 0,
  };

  try {
    await persistUiRuntime(context, runtime, state);
    terminal.render(renderFrame(context, tasks, state, terminal));

    while (true) {
      const event = await terminal.readEvent();

      if (event.kind === "resize") {
        terminal.render(renderFrame(context, tasks, state, terminal));
        continue;
      }

      const outcome = await handleEvent(context, terminal, runtime, tasks, state, event);
      runtime = outcome.runtime;
      tasks = outcome.tasks;

      if (outcome.exitCode !== null) {
        return outcome.exitCode;
      }

      terminal.render(renderFrame(context, tasks, state, terminal));
    }
  } finally {
    terminal.dispose();
  }
}

async function handleEvent(
  context: CommandContext,
  terminal: TerminalSession,
  runtime: CraigSessionRuntime | null,
  currentTasks: TaskRecord[],
  state: InteractiveState,
  event: Extract<TerminalEvent, { kind: "keypress" }>,
): Promise<{ exitCode: number | null; tasks: TaskRecord[]; runtime: CraigSessionRuntime | null }> {
  if (event.ctrl && event.name === "c") {
    state.sigintCount += 1;

    if (state.sigintCount >= 2) {
      return { exitCode: 0, tasks: currentTasks, runtime };
    }

    setOutput(state, ["Press Ctrl-C again to exit."]);
    return persistAndReturn(context, runtime, currentTasks, state);
  }

  state.sigintCount = 0;

  if (event.ctrl && event.name === "l") {
    return persistAndReturn(context, runtime, currentTasks, state);
  }

  if (!event.ctrl && !event.meta && event.text === "r" && state.commandBuffer.length === 0) {
    return refreshState(context, state);
  }

  if (event.name === "return") {
    return runCommandBuffer(context, terminal, runtime, state);
  }

  if (event.name === "backspace" || event.name === "delete") {
    state.commandBuffer = state.commandBuffer.slice(0, -1);
    return persistAndReturn(context, runtime, currentTasks, state);
  }

  if (shouldAppendText(event)) {
    state.commandBuffer += event.text;
    return persistAndReturn(context, runtime, currentTasks, state);
  }

  return persistAndReturn(context, runtime, currentTasks, state);
}

async function runCommandBuffer(
  context: CommandContext,
  terminal: TerminalSession,
  runtime: CraigSessionRuntime | null,
  state: InteractiveState,
): Promise<{ exitCode: number | null; tasks: TaskRecord[]; runtime: CraigSessionRuntime | null }> {
  const commandText = state.commandBuffer.trim();
  state.commandBuffer = "";

  if (commandText.length === 0) {
    const defaultCommand = await resolveDefaultWorkSurfaceCommand(context, state.selectedTaskId);

    if (!defaultCommand) {
      setOutput(state, ["Type a Craig command and press Enter.", "Create a task with: new <task>"]);
      return persistAndReturn(context, runtime, sortTasksForDisplay((await listTasks(context.paths)).tasks), state);
    }

    return runParsedCommand(defaultCommand, context, terminal, runtime, state);
  }

  try {
    const command = parseReplCommand(commandText);
    return runParsedCommand(command, context, terminal, runtime, state);
  } catch (error) {
    setOutput(state, [formatError(error)]);
    return persistAndReturn(context, runtime, sortTasksForDisplay((await listTasks(context.paths)).tasks), state);
  }
}

async function persistAndReturn(
  context: CommandContext,
  runtime: CraigSessionRuntime | null,
  tasks: TaskRecord[],
  state: InteractiveState,
): Promise<{ exitCode: number | null; tasks: TaskRecord[]; runtime: CraigSessionRuntime | null }> {
  state.selectedTaskId = resolveSelectedTaskId(tasks, state.selectedTaskId);
  await persistUiRuntime(context, runtime, state);
  return { exitCode: null, tasks, runtime };
}

async function persistUiRuntime(
  context: CommandContext,
  runtime: CraigSessionRuntime | null,
  state: InteractiveState,
): Promise<void> {
  if (!runtime) {
    return;
  }

  await writeSessionRuntime(
    { sessionFile: context.paths.sessionFile },
    {
      ...runtime,
      ui: buildUiRuntime(state),
    },
  );
}

function buildUiRuntime(state: InteractiveState): CraigUiRuntime {
  return {
    selectedTaskId: state.selectedTaskId,
    workSurfaceMode: "command",
    lastContextView: "summary",
    lastCommandBuffer: state.commandBuffer,
    lastOutputLines: state.outputLines.slice(0, 8),
  };
}

function renderFrame(
  context: CommandContext,
  tasks: TaskRecord[],
  state: InteractiveState,
  terminal: TerminalSession,
): string {
  return renderInteractiveLayout({
    repoRoot: context.paths.repoRoot,
    tasks,
    selectedTaskId: state.selectedTaskId,
    commandBuffer: state.commandBuffer,
    outputLines: state.outputLines.slice(0, 8),
    recentEvent: state.recentEvent,
    hasSelectedTask: state.selectedTaskId !== null,
    terminalSize: terminal.getSize(),
  });
}

function setOutput(state: InteractiveState, lines: string[]): void {
  state.outputLines = lines.filter((line) => line.length > 0).slice(0, 8);
  state.recentEvent = state.outputLines[0] ?? null;
}

function shouldAppendText(event: Extract<TerminalEvent, { kind: "keypress" }>): boolean {
  return !event.ctrl && !event.meta && event.text.length > 0;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown Craig error";
}

async function refreshState(
  context: CommandContext,
  state: InteractiveState,
): Promise<{ exitCode: number | null; tasks: TaskRecord[]; runtime: CraigSessionRuntime | null }> {
  const refreshed = await loadInteractiveState(context, state.selectedTaskId);
  state.selectedTaskId = resolveSelectedTaskId(refreshed.tasks, refreshed.ui?.selectedTaskId ?? state.selectedTaskId);
  setOutput(state, ["Refreshed Craig state."]);
  await persistUiRuntime(context, refreshed.runtime, state);

  return { exitCode: null, tasks: refreshed.tasks, runtime: refreshed.runtime };
}

async function loadInteractiveState(
  context: CommandContext,
  fallbackSelectedTaskId: string | null,
): Promise<{
  runtime: CraigSessionRuntime | null;
  tasks: TaskRecord[];
  ui: CraigUiRuntime;
}> {
  const runtime = await readSessionRuntime({ sessionFile: context.paths.sessionFile });
  const tasks = sortTasksForDisplay((await listTasks(context.paths)).tasks);
  const ui = runtime?.ui ?? getDefaultUiRuntime();

  return {
    runtime,
    tasks,
    ui: {
      ...ui,
      selectedTaskId: resolveSelectedTaskId(tasks, ui.selectedTaskId ?? fallbackSelectedTaskId),
    },
  };
}

async function runParsedCommand(
  command: ReturnType<typeof parseReplCommand>,
  context: CommandContext,
  terminal: TerminalSession,
  runtime: CraigSessionRuntime | null,
  state: InteractiveState,
): Promise<{ exitCode: number | null; tasks: TaskRecord[]; runtime: CraigSessionRuntime | null }> {
  if (command.kind === "refreshInteractiveState") {
    return refreshState(context, state);
  }

  const shouldSuspendTerminal = isTerminalHandoffCommand(command);
  let result;

  if (shouldSuspendTerminal) {
    terminal.suspend();
  }

  try {
    result = await executeCommand(command, {
      ...context,
      selectedTaskId: state.selectedTaskId,
    });
  } finally {
    if (shouldSuspendTerminal) {
      terminal.resume();
    }
  }

  if (result.kind === "exit") {
    return { exitCode: 0, tasks: sortTasksForDisplay((await listTasks(context.paths)).tasks), runtime };
  }

  if (result.kind === "streamTaskLogs") {
    terminal.suspend();

    try {
      await streamTaskLogs(result.logPath);
    } finally {
      terminal.resume();
    }

    setOutput(state, [formatCommandResult(result), "Returned to Craig control surface."]);
  } else if (result.kind === "createTask") {
    setOutput(state, [
      ...formatCommandResult(result).split("\n"),
      `Selected task ${result.taskId}.`,
      "Try: show, logs, focus, open, diff, check",
      "Press Enter for the default selected-task action.",
    ]);
  } else {
    setOutput(state, formatCommandResult(result).split("\n"));
  }

  const tasks = sortTasksForDisplay((await listTasks(context.paths)).tasks);
  state.selectedTaskId =
    result.kind === "createTask"
      ? result.taskId
      : resolveSelectedTaskId(tasks, state.selectedTaskId);

  const nextRuntime = await readSessionRuntime({ sessionFile: context.paths.sessionFile });
  await persistUiRuntime(context, nextRuntime, state);

  return { exitCode: null, tasks, runtime: nextRuntime };
}

async function resolveDefaultWorkSurfaceCommand(
  context: CommandContext,
  selectedTaskId: string | null,
): Promise<ReturnType<typeof parseReplCommand> | null> {
  if (!selectedTaskId) {
    return null;
  }

  const tasks = sortTasksForDisplay((await listTasks(context.paths)).tasks);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);

  if (!selectedTask) {
    return null;
  }

  switch (selectedTask.status) {
    case "draft":
    case "running":
      return { kind: "streamSelectedTaskLogs" };
    case "review":
    case "checked":
    case "pr_open":
    case "merge_ready":
    case "merged":
      return { kind: "showSelectedTaskDiff" };
    default:
      return { kind: "showSelectedTask" };
  }
}

function isTerminalHandoffCommand(command: ReturnType<typeof parseReplCommand>): boolean {
  switch (command.kind) {
    case "focusTask":
    case "focusSelectedTask":
    case "openTask":
    case "openSelectedTask":
      return true;
    default:
      return false;
  }
}
