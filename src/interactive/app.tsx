import React, { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { render, useInput } from "ink";

import { executeCommand, type CommandContext } from "../commands/command-router.js";
import { parseReplCommand } from "../commands/parse-repl.js";
import { formatCommandResult } from "../main.js";
import { listRegisteredRepos } from "../services/repo-registry.js";
import { tmuxSessionManager } from "../services/session-manager.js";
import { listTasks } from "../services/list-tasks.js";
import { listWorkspaces } from "../services/workspace-registry.js";
import { readRepo } from "../state/repo-store.js";
import { readSession } from "../state/session-store.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import type { SessionTerminalSize } from "../types/session.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigContextTab, CraigPanelFocus, CraigUiRuntime } from "../types/workspace.js";
import { CraigScreen } from "./render-layout.js";
import { createNodePtyTerminalBridge, type TerminalBridge } from "./terminal-bridge.js";
import { canUseInteractiveTerminal, enterAlternateScreen, exitAlternateScreen, getTerminalSize } from "./terminal-io.js";

interface InteractiveAppOptions {
  terminalBridgeFactory?: () => TerminalBridge;
}

type InteractiveResolution =
  | { kind: "exit"; code: number; uiState: CraigUiRuntime }
  | { kind: "attach"; sessionId: string; uiState: CraigUiRuntime };

interface ControlData {
  repos: Awaited<ReturnType<typeof listRegisteredRepos>>["repos"];
  activeWorkspaces: Awaited<ReturnType<typeof listWorkspaces>>["workspaces"];
  archivedWorkspaces: Awaited<ReturnType<typeof listWorkspaces>>["workspaces"];
  tasks: TaskRecord[];
}

const OVERLAY_ITEM_COUNT = 3;
const RIGHT_TABS: CraigContextTab[] = ["summary", "logs", "diff", "files", "review"];

export async function startInteractiveApp(context: CommandContext, options?: InteractiveAppOptions): Promise<number> {
  if (!canUseInteractiveTerminal()) {
    throw new Error("Interactive terminal surface requires a TTY with TERM support.");
  }

  let uiState = await sanitizeUiState(context);
  const createTerminalBridge = options?.terminalBridgeFactory ?? createNodePtyTerminalBridge;

  enterAlternateScreen();

  try {
    while (true) {
      const resolution = await runControlSurface(context, uiState);
      uiState = resolution.uiState;

      if (resolution.kind === "exit") {
        return resolution.code;
      }

      try {
        uiState = await attachEmbeddedTerminal(context, resolution.sessionId, uiState, createTerminalBridge);
      } catch (error) {
        uiState = {
          ...uiState,
          inputMode: "control",
          centerSurface: "command",
          outputLines: [formatError(error)],
        };
        await writeUiState({ uiStateFile: context.paths.uiStateFile }, uiState);
      }
    }
  } finally {
    exitAlternateScreen();
  }
}

async function attachEmbeddedTerminal(
  context: CommandContext,
  sessionId: string,
  uiState: CraigUiRuntime,
  createTerminalBridge: () => TerminalBridge,
): Promise<CraigUiRuntime> {
  const session = await readSession(context.paths, sessionId);
  const repo = await readRepo(context.paths, session.repoId);
  const bridge = createTerminalBridge();
  const size = getTerminalSize();
  const nextUiState: CraigUiRuntime = {
    ...uiState,
    inputMode: "terminal",
    centerSurface: "terminal",
    lastAttachedSessionId: sessionId,
  };

  await writeUiState({ uiStateFile: context.paths.uiStateFile }, nextUiState);
  const resizedSession = await tmuxSessionManager.resize(context.paths, session, size, repo.rootPath);

  bridge.attach(resizedSession, size);

  const onResize = () => {
    const nextSize = getTerminalSize();
    bridge.resize(nextSize);
    void tmuxSessionManager.resize(context.paths, resizedSession, nextSize, repo.rootPath);
  };

  process.stdout.on("resize", onResize);

  try {
    await bridge.waitForDetach();
  } finally {
    process.stdout.off("resize", onResize);
    bridge.dispose();
  }

  const detachedUiState: CraigUiRuntime = {
    ...nextUiState,
    inputMode: "control",
    centerSurface: "command",
  };
  await writeUiState({ uiStateFile: context.paths.uiStateFile }, detachedUiState);
  return detachedUiState;
}

async function runControlSurface(context: CommandContext, initialUiState: CraigUiRuntime): Promise<InteractiveResolution> {
  return new Promise<InteractiveResolution>((resolve, reject) => {
    const instance = render(
      <CraigInteractiveApp
        context={context}
        initialUiState={initialUiState}
        onResolve={(value) => {
          resolve(value);
          instance.unmount();
        }}
      />,
      {
        exitOnCtrlC: false,
      },
    );

    instance.waitUntilExit().catch(reject);
  });
}

function CraigInteractiveApp(props: {
  context: CommandContext;
  initialUiState: CraigUiRuntime;
  onResolve: (resolution: InteractiveResolution) => void;
}): React.ReactElement {
  const [uiState, setUiState] = useState<CraigUiRuntime>(props.initialUiState);
  const [overlayMenuIndex, setOverlayMenuIndex] = useState(props.initialUiState.overlayMode === "archives" ? 1 : 0);
  const [data, setData] = useState<ControlData>({
    repos: [],
    activeWorkspaces: [],
    archivedWorkspaces: [],
    tasks: [],
  });
  const [commandMode, setCommandMode] = useState(false);
  const busyRef = useRef(false);

  const selectedTask = useMemo(
    () => data.tasks.find((task) => task.id === uiState.selectedTaskId) ?? null,
    [data.tasks, uiState.selectedTaskId],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [reposResult, activeWorkspaces, archivedWorkspaces, tasksResult] = await Promise.all([
        listRegisteredRepos(props.context.paths),
        listWorkspaces(props.context.paths, { archived: false }),
        listWorkspaces(props.context.paths, { archived: true }),
        listTasks(props.context.paths),
      ]);

      if (cancelled) {
        return;
      }

      startTransition(() => {
        setData({
          repos: reposResult.repos,
          activeWorkspaces: activeWorkspaces.workspaces,
          archivedWorkspaces: archivedWorkspaces.workspaces,
          tasks: tasksResult.tasks,
        });
      });

      if (!uiState.selectedTaskId && tasksResult.tasks.length > 0) {
        const firstTask = tasksResult.tasks[0]!;
        const nextUiState = {
          ...uiState,
          selectedTaskId: firstTask.id,
          selectedRepoId: firstTask.repoId,
        };
        setUiState(nextUiState);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [props.context.paths, uiState.selectedTaskId, uiState.selectedRepoId]);

  useEffect(() => {
    void writeUiState({ uiStateFile: props.context.paths.uiStateFile }, uiState);
  }, [props.context.paths.uiStateFile, uiState]);

  useInput((input, key) => {
    if (busyRef.current) {
      return;
    }

    if (key.ctrl && input === "c") {
      props.onResolve({ kind: "exit", code: 0, uiState });
      return;
    }

    if (commandMode) {
      handleCommandInput(input, key, uiState, setUiState, setCommandMode, props.context, busyRef, () => refreshData(props.context, setData), props.onResolve);
      return;
    }

    if (uiState.activeSurface === "overlay") {
      handleOverlayInput(input, key, overlayMenuIndex, setOverlayMenuIndex, uiState, setUiState, props.onResolve);
      return;
    }

    handleShellInput({
      input,
      key,
      uiState,
      setUiState,
      selectedTask,
      tasks: data.tasks,
      setCommandMode,
      onAttach: (sessionId) => props.onResolve({ kind: "attach", sessionId, uiState }),
    });
  });

  return (
    <CraigScreen
      workspaceRoot={props.context.paths.workspaceRoot}
      repos={data.repos}
      workspaces={data.activeWorkspaces}
      archivedWorkspaces={data.archivedWorkspaces}
      tasks={data.tasks}
      selectedTask={selectedTask}
      uiState={uiState}
      overlayMenuIndex={overlayMenuIndex}
      viewport={getTerminalSize()}
    />
  );
}

function handleOverlayInput(
  input: string,
  key: { upArrow?: boolean; downArrow?: boolean; escape?: boolean; return?: boolean },
  overlayMenuIndex: number,
  setOverlayMenuIndex: (index: number) => void,
  uiState: CraigUiRuntime,
  setUiState: (value: CraigUiRuntime) => void,
  onResolve: (resolution: InteractiveResolution) => void,
): void {
  if (key.upArrow || input === "k") {
    setOverlayMenuIndex(Math.max(0, overlayMenuIndex - 1));
    return;
  }

  if (key.downArrow || input === "j") {
    setOverlayMenuIndex(Math.min(OVERLAY_ITEM_COUNT - 1, overlayMenuIndex + 1));
    return;
  }

  if (key.escape) {
    setOverlayMenuIndex(0);
    if (uiState.overlayMode === "archives") {
      setUiState({ ...uiState, overlayMode: "start" });
      return;
    }

    setUiState({ ...uiState, activeSurface: "shell", overlayMode: "start" });
    return;
  }

  if (!key.return) {
    return;
  }

  if (overlayMenuIndex === 0) {
    setUiState({ ...uiState, activeSurface: "shell", overlayMode: "start" });
    return;
  }

  if (overlayMenuIndex === 1) {
    setUiState({ ...uiState, overlayMode: "archives" });
    return;
  }

  onResolve({ kind: "exit", code: 0, uiState });
}

function handleShellInput(input: {
  input: string;
  key: { tab?: boolean; shift?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean };
  uiState: CraigUiRuntime;
  setUiState: (value: CraigUiRuntime) => void;
  selectedTask: TaskRecord | null;
  tasks: TaskRecord[];
  setCommandMode: (value: boolean) => void;
  onAttach: (sessionId: string) => void;
}): void {
  const { uiState, setUiState, tasks, selectedTask } = input;

  if (input.key.escape) {
    setUiState({ ...uiState, activeSurface: "overlay", overlayMode: "start", inputMode: "control" });
    return;
  }

  if (input.key.tab) {
    setUiState({
      ...uiState,
      panelFocus: cyclePanelFocus(uiState.panelFocus, Boolean(input.key.shift)),
    });
    return;
  }

  if (input.input === ":") {
    input.setCommandMode(true);
    return;
  }

  if (input.input === "d") {
    setUiState({ ...uiState, rightContextTab: "diff" });
    return;
  }

  if (input.input === "f") {
    setUiState({ ...uiState, rightContextTab: "files" });
    return;
  }

  if (input.input === "r") {
    setUiState({ ...uiState, rightContextTab: "review" });
    return;
  }

  if (input.input === "a") {
    setUiState({ ...uiState, panelFocus: "center", centerSurface: "command" });
    return;
  }

  if (input.input === "t" && selectedTask?.sessionId) {
    input.onAttach(selectedTask.sessionId);
    return;
  }

  if (uiState.panelFocus === "left" && (input.input === "j" || input.key.downArrow || input.input === "k" || input.key.upArrow)) {
    const currentIndex = Math.max(0, tasks.findIndex((task) => task.id === uiState.selectedTaskId));
    const nextIndex =
      input.input === "k" || input.key.upArrow
        ? Math.max(0, currentIndex - 1)
        : Math.min(tasks.length - 1, currentIndex + 1);
    const nextTask = tasks[nextIndex] ?? null;

    if (nextTask) {
      setUiState({
        ...uiState,
        selectedTaskId: nextTask.id,
        selectedRepoId: nextTask.repoId,
      });
    }

    return;
  }

  if (uiState.panelFocus === "right" && (input.input === "j" || input.key.downArrow || input.input === "k" || input.key.upArrow)) {
    const currentIndex = RIGHT_TABS.indexOf(uiState.rightContextTab);
    const nextIndex =
      input.input === "k" || input.key.upArrow
        ? Math.max(0, currentIndex - 1)
        : Math.min(RIGHT_TABS.length - 1, currentIndex + 1);
    setUiState({ ...uiState, rightContextTab: RIGHT_TABS[nextIndex]! });
  }
}

function handleCommandInput(
  input: string,
  key: { escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean },
  uiState: CraigUiRuntime,
  setUiState: (value: CraigUiRuntime) => void,
  setCommandMode: (value: boolean) => void,
  context: CommandContext,
  busyRef: React.MutableRefObject<boolean>,
  refresh: () => Promise<void>,
  onResolve: (resolution: InteractiveResolution) => void,
): void {
  if (key.escape) {
    setCommandMode(false);
    setUiState({ ...uiState, commandBuffer: "" });
    return;
  }

  if (key.backspace || key.delete) {
    setUiState({ ...uiState, commandBuffer: uiState.commandBuffer.slice(0, -1) });
    return;
  }

  if (!key.return) {
    if (input.length > 0) {
      setUiState({ ...uiState, commandBuffer: `${uiState.commandBuffer}${input}` });
    }
    return;
  }

  busyRef.current = true;
  const commandText = uiState.commandBuffer.trim();
  const currentUiState = { ...uiState, commandBuffer: "" };

  void (async () => {
    try {
      const command = parseReplCommand(commandText);

      if (command.kind === "refreshInteractiveState") {
        await refresh();
        setUiState(currentUiState);
        setCommandMode(false);
        return;
      }

      const result = await executeCommand(command, { ...context, selectedTaskId: currentUiState.selectedTaskId });

      if (result.kind === "exit") {
        onResolve({ kind: "exit", code: 0, uiState: currentUiState });
        return;
      }

      const output = formatCommandResult(result);
      setUiState(
        await resolveCommandUiState(context, currentUiState, output.length > 0 ? output.split("\n") : ["Command completed."]),
      );
      setCommandMode(false);
      await refresh();
    } catch (error) {
      setUiState({
        ...currentUiState,
        outputLines: [formatError(error)],
      });
      setCommandMode(false);
    } finally {
      busyRef.current = false;
    }
  })();
}

export async function resolveCommandUiState(
  context: CommandContext,
  fallbackUiState: CraigUiRuntime,
  outputLines: string[],
): Promise<CraigUiRuntime> {
  const persistedUiState = (await readUiState({ uiStateFile: context.paths.uiStateFile })) ?? fallbackUiState;

  return {
    ...persistedUiState,
    inputMode: "control",
    centerSurface: "command",
    commandBuffer: "",
    outputLines,
  };
}

async function refreshData(
  context: CommandContext,
  setData: (value: ControlData) => void,
): Promise<void> {
  const [reposResult, activeWorkspaces, archivedWorkspaces, tasksResult] = await Promise.all([
    listRegisteredRepos(context.paths),
    listWorkspaces(context.paths, { archived: false }),
    listWorkspaces(context.paths, { archived: true }),
    listTasks(context.paths),
  ]);

  startTransition(() => {
    setData({
      repos: reposResult.repos,
      activeWorkspaces: activeWorkspaces.workspaces,
      archivedWorkspaces: archivedWorkspaces.workspaces,
      tasks: tasksResult.tasks,
    });
  });
}

async function sanitizeUiState(context: CommandContext): Promise<CraigUiRuntime> {
  const current = (await readUiState({ uiStateFile: context.paths.uiStateFile })) ?? getDefaultUiState();
  const bootState: CraigUiRuntime = {
    ...current,
    activeSurface: "overlay",
    overlayMode: "start",
    inputMode: "control",
    centerSurface: "command",
  };

  if (!bootState.selectedTaskId) {
    return bootState;
  }

  try {
    const task = (await listTasks(context.paths)).tasks.find((entry) => entry.id === bootState.selectedTaskId);
    if (!task) {
      throw new Error("Missing selected task");
    }

    return bootState;
  } catch {
    const sanitized = {
      ...bootState,
      selectedTaskId: null,
    };
    await writeUiState({ uiStateFile: context.paths.uiStateFile }, sanitized);
    return sanitized;
  }
}

function cyclePanelFocus(current: CraigPanelFocus, reverse: boolean): CraigPanelFocus {
  const order: CraigPanelFocus[] = ["left", "center", "right"];
  const index = order.indexOf(current);
  const nextIndex = reverse
    ? (index - 1 + order.length) % order.length
    : (index + 1) % order.length;
  return order[nextIndex]!;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Craig error";
}
