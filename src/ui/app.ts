import { createRequire } from "node:module";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type * as TerminalKitModule from "terminal-kit";

import { listRepos } from "../state/repo-store.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import { readTask, writeTask } from "../state/task-store.js";
import { getCraigPaths } from "../state/craig-paths.js";
import { ensureCraigState } from "../state/ensure-state.js";
import type { TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import { listTasks } from "../services/list-tasks.js";
import { provisionTask } from "../services/task-provisioning.js";
import { addRepo } from "../services/repo-registry.js";
import { buildShellData, type WorkspaceShellModel } from "./shell-data.js";
import { getViewport, SHELL_LAYOUT, type Viewport } from "./layout.js";
import { PtyRuntime, type PtyRuntimeOptions, type PtySize } from "./pty-runtime.js";
import { CENTER_TERMINAL_GUTTER, renderBootOverlayFrame, renderMainShellFrame, renderPauseOverlayFrame } from "./render.js";
import {
  createInitialShellState,
  buildCenterTabIds,
  isEnterKey,
  isPrintableKey,
  markTerminalAttachFailed,
  reduceMainKey,
  restoreShellState,
  toPersistedUiState,
  updateTerminalViewState,
  type ControlShellState,
  type WorkspaceBrowserEntry,
  type WorkspaceBrowserState,
} from "./state.js";

type OverlayVariant = "boot" | "pause";
type AppState =
  | { mode: "overlay"; variant: OverlayVariant; menuIndex: number; optionsMessage: string | null; shell: ControlShellState }
  | { mode: "main"; shell: ControlShellState };

/* eslint-disable no-unused-vars */
type TerminalEventListener = (...args: unknown[]) => void;

export interface TerminalAppOptions {
  uiStateFile?: string;
  workspaceRoot?: string;
  terminal?: TerminalRuntime;
  ptyRuntime?: PtyRuntimePort;
}

const require = createRequire(import.meta.url);
const terminalKit = require("terminal-kit") as typeof TerminalKitModule;
const terminal = terminalKit.terminal;

export interface TerminalRuntime {
  width: number | undefined;
  height: number | undefined;
  moveTo(...args: [number, number]): void;
  eraseDisplayBelow(): void;
  noFormat(...args: [string]): void;
  grabInput(...args: [boolean | { mouse: "button" }]): void;
  hideCursor(...args: [boolean?]): void;
  fullscreen(...args: [boolean]): void;
  on(...args: ["key" | "unknown" | "mouse", TerminalEventListener]): void;
  removeListener(...args: ["key" | "unknown" | "mouse", TerminalEventListener]): void;
}

export interface PtyRuntimePort {
  ensureSession(...args: [string, string, PtySize]): ControlShellState["terminal"];
  write(...args: [string]): void;
  writeKey(...args: [string]): void;
  scrollViewport(...args: [number]): void;
  resize(...args: [PtySize]): void;
  detach(): void;
  disposeSession(...args: [string]): void;
  disposeAll(): void;
  getViewState(...args: [string | null]): ControlShellState["terminal"];
}
/* eslint-enable no-unused-vars */

export async function startTerminalApp(options: TerminalAppOptions = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Craig terminal shell requires a TTY.");
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const paths = getCraigPaths(workspaceRoot);
  await ensureCraigState(workspaceRoot);
  let runtimeState = options.uiStateFile ? await readUiState({ uiStateFile: options.uiStateFile }) : null;
  let persistQueue = Promise.resolve();
  let taskMutationQueue = Promise.resolve();
  let model = await loadWorkspaceShellModel(workspaceRoot);

  const persistShellState = (shell: ControlShellState) => {
    if (!options.uiStateFile) {
      return;
    }

    runtimeState = toPersistedUiState(runtimeState, shell);
    const nextRuntimeState = runtimeState;
    persistQueue = persistQueue.then(
      () => writeUiState({ uiStateFile: options.uiStateFile! }, nextRuntimeState),
      () => writeUiState({ uiStateFile: options.uiStateFile! }, nextRuntimeState),
    );
    void persistQueue.catch(() => undefined);
  };

  return new Promise<number>((resolve) => {
    const activeTerminal = options.terminal ?? terminal;
    let state: AppState = {
      mode: "overlay",
      variant: "boot",
      menuIndex: 0,
      optionsMessage: null,
      shell: restoreShellState(createInitialShellState(runtimeState), model, { resetInputMode: true }),
    };
    let creatingTask = false;
    let suppressTerminalEnterOnAttach = false;
    let lastTerminalKey: { key: string; at: number } | null = null;
    let pendingScrollLines = 0;
    let scrollRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let ptyRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingClear = true;
    const ptyOptions: PtyRuntimeOptions = {
      workspaceRoot,
      onUpdate: () => {
        if (state.mode !== "main") {
          return;
        }

        state = { mode: "main", shell: withTerminalView(state.shell) };

        if (!ptyRenderTimer) {
          ptyRenderTimer = setTimeout(() => {
            ptyRenderTimer = null;
            if (state.mode === "main") {
              render();
            }
          }, 50);
        }
      },
      resolveSessionSpec: (_taskId, tabId) => resolvePtySessionSpec(model, tabId, workspaceRoot),
    };
    const ptyRuntime: PtyRuntimePort = options.ptyRuntime ?? new PtyRuntime(ptyOptions);

    function withTerminalView(shell: ControlShellState): ControlShellState {
      return updateTerminalViewState(shell, ptyRuntime.getViewState(shell.selectedPtyTabId));
    }

    function syncShell(nextShell: ControlShellState): ControlShellState {
      return withTerminalView(resolveShellState(nextShell, model));
    }

    function getSelectedTask(shell: ControlShellState): TaskRecord | null {
      return model.tasks.find((task) => task.id === shell.selectedTaskId) ?? null;
    }

    function queueTaskMutation<T>(mutation: () => Promise<T>): Promise<T> {
      const next = taskMutationQueue.then(mutation, mutation);
      taskMutationQueue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }

    function getShellKeyOptions(shell: ControlShellState) {
      const selectedTask = getSelectedTask(shell);
      return {
        leftItemIds: getLeftItemIds(model),
        centerTabIds: buildCenterTabIds(selectedTask),
        ptyTabIds: selectedTask?.ptyTabs.map((tab) => tab.id) ?? [],
      };
    }

    async function persistTaskPtySelection(shell: ControlShellState): Promise<void> {
      const taskId = shell.selectedTaskId;
      if (!taskId) {
        return;
      }

      await queueTaskMutation(async () => {
        const latestTask = await readTask(paths, taskId);
        if (
          !latestTask.ptyTabs.some((tab) => tab.id === shell.activeTab) ||
          latestTask.selectedPtyTabId === shell.activeTab
        ) {
          return;
        }

        await writeTask(paths, {
          ...latestTask,
          selectedPtyTabId: shell.activeTab,
        });
      });
    }

    async function reloadModel(): Promise<void> {
      model = await loadWorkspaceShellModel(workspaceRoot);
      if (state.mode === "main") {
        state = { mode: "main", shell: syncShell(state.shell) };
      } else {
        state = { ...state, shell: syncShell(state.shell) };
      }
    }

    async function openWorkspaceBrowser(rootPath: string): Promise<void> {
      const browser = await loadWorkspaceBrowser(rootPath);
      if (state.mode !== "main") {
        return;
      }

      state = {
        mode: "main",
        shell: syncShell({
          ...state.shell,
          workspaceBrowser: browser,
          activeTab: "files",
          actionMessage: null,
        }),
      };
      render();
    }

    async function attachPtyFromShell(shell: ControlShellState): Promise<void> {
      try {
        const syncedShell = syncShell(shell);
        let selectedTask = getSelectedTask(syncedShell);
        let tabId = syncedShell.selectedPtyTabId;

        if (selectedTask && syncedShell.focusedRegion === "tasks") {
          const agentTab = selectedTask.ptyTabs.find((tab) => tab.kind === "agent") ?? null;
          if (agentTab) {
            tabId = agentTab.id;
          } else {
            selectedTask = await ensureDefaultAgentTab(selectedTask);
            await reloadModel();
            tabId = selectedTask.selectedPtyTabId;
          }
        }

        if (selectedTask && !tabId) {
          selectedTask = await ensureDefaultAgentTab(selectedTask);
          await reloadModel();
          tabId = selectedTask.selectedPtyTabId;
        }

        const nextShell = syncShell({
          ...syncedShell,
          activeTab: tabId ?? syncedShell.activeTab,
          selectedPtyTabId: tabId,
        });

        if (!nextShell.selectedTaskId || !tabId) {
          state = { mode: "main", shell: nextShell };
          render();
          return;
        }

        const view = ptyRuntime.ensureSession(
          nextShell.selectedTaskId,
          tabId,
          getPtySize(getViewport(activeTerminal.width, activeTerminal.height)),
        );
        suppressTerminalEnterOnAttach = isAgentTabId(tabId);
        lastTerminalKey = null;
        state = { mode: "main", shell: updateTerminalViewState({ ...nextShell, inputMode: "terminal" }, view) };
        persistShellState(state.shell);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start PTY.";
        state = { mode: "main", shell: markTerminalAttachFailed(syncShell(shell), message) };
        persistShellState(state.shell);
      }
      render();
    }

    async function createPtyTabFromShell(shell: ControlShellState): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before creating a tab.");
      }

      const updatedTask = await queueTaskMutation(async () => {
        const task = await readTask(paths, syncedShell.selectedTaskId!);
        const kind = resolveNewPtyTabKind(task, syncedShell.activeTab);
        const tab = createNextPtyTab(task, kind);
        const nextTask: TaskRecord = {
          ...task,
          ptyTabs: [...task.ptyTabs, tab],
          selectedPtyTabId: tab.id,
        };
        await writeTask(paths, nextTask);
        return nextTask;
      });
      await reloadModel();

      return syncShell({
        ...syncedShell,
        activeTab: updatedTask.selectedPtyTabId ?? syncedShell.activeTab,
        selectedPtyTabId: updatedTask.selectedPtyTabId,
        focusedRegion: "center",
        actionMessage: `Created tab: ${updatedTask.ptyTabs.at(-1)?.title ?? "tab"}`,
      });
    }

    async function closePtyTabFromShell(shell: ControlShellState): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before closing a tab.");
      }

      const { closedTab, nextSelectedTab } = await queueTaskMutation(async () => {
        const task = await readTask(paths, syncedShell.selectedTaskId!);
        const closedIndex = task.ptyTabs.findIndex((tab) => tab.id === syncedShell.activeTab);
        if (closedIndex === -1) {
          throw new Error("Only PTY tabs can be closed.");
        }

        const closedTab = task.ptyTabs[closedIndex]!;
        const remainingTabs = task.ptyTabs.filter((tab) => tab.id !== closedTab.id);
        const nextSelectedTab =
          remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)] ?? remainingTabs[closedIndex - 1] ?? null;
        await writeTask(paths, {
          ...task,
          ptyTabs: remainingTabs,
          selectedPtyTabId: nextSelectedTab?.id ?? null,
        });
        return { closedTab, nextSelectedTab };
      });
      ptyRuntime.disposeSession(closedTab.id);
      await reloadModel();

      return syncShell({
        ...syncedShell,
        activeTab: nextSelectedTab?.id ?? "files",
        selectedPtyTabId: nextSelectedTab?.id ?? null,
        focusedRegion: "center",
        actionMessage: `Closed tab: ${closedTab.title}`,
      });
    }

    async function ensureDefaultAgentTab(task: TaskRecord): Promise<TaskRecord> {
      const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent") ?? null;
      if (agentTab) {
        const updatedTask = {
          ...task,
          selectedPtyTabId: agentTab.id,
        };
        await queueTaskMutation(async () => {
          const latestTask = await readTask(paths, task.id);
          const latestAgentTab = latestTask.ptyTabs.find((tab) => tab.kind === "agent") ?? null;
          if (!latestAgentTab) {
            return;
          }

          await writeTask(paths, {
            ...latestTask,
            selectedPtyTabId: latestAgentTab.id,
          });
        });
        return updatedTask;
      }

      const tab = createNextPtyTab(task, "agent");
      const updatedTask = {
        ...task,
        ptyTabs: [...task.ptyTabs, tab],
        selectedPtyTabId: tab.id,
      };
      await queueTaskMutation(async () => {
        const latestTask = await readTask(paths, task.id);
        const latestAgentTab = latestTask.ptyTabs.find((entry) => entry.kind === "agent") ?? null;
        if (latestAgentTab) {
          await writeTask(paths, {
            ...latestTask,
            selectedPtyTabId: latestAgentTab.id,
          });
          return;
        }

        await writeTask(paths, {
          ...latestTask,
          ptyTabs: [...latestTask.ptyTabs, tab],
          selectedPtyTabId: tab.id,
        });
      });
      return updatedTask;
    }

    const render = () => {
      const viewport = getViewport(activeTerminal.width, activeTerminal.height);
      const frame =
        state.mode === "main"
          ? renderMainShellFrame(viewport, buildShellData(syncShell(state.shell), model))
          : state.variant === "boot"
            ? renderBootOverlayFrame(viewport, {
                menuIndex: state.menuIndex,
                optionsMessage: state.optionsMessage,
              })
            : renderPauseOverlayFrame(viewport, {
                menuIndex: state.menuIndex,
                optionsMessage: state.optionsMessage,
              });

      activeTerminal.moveTo(1, 1);
      if (pendingClear) {
        activeTerminal.eraseDisplayBelow();
        pendingClear = false;
      }
      activeTerminal.noFormat(frame);
    };

    const cleanup = () => {
      process.stdout.off("resize", handleResize);
      activeTerminal.removeListener("key", onKey);
      activeTerminal.removeListener("unknown", onUnknown);
      activeTerminal.removeListener("mouse", onMouse);
      if (scrollRenderTimer) {
        clearTimeout(scrollRenderTimer);
        scrollRenderTimer = null;
      }
      if (ptyRenderTimer) {
        clearTimeout(ptyRenderTimer);
        ptyRenderTimer = null;
      }
      ptyRuntime.disposeAll();
      activeTerminal.grabInput(false);
      activeTerminal.hideCursor(false);
      activeTerminal.fullscreen(false);
    };

    const exit = (code: number) => {
      cleanup();
      resolve(code);
    };

    const submitTaskPrompt = async () => {
      if (state.mode !== "main" || creatingTask) {
        return;
      }

      const shell = state.shell;
      const prompt = shell.taskPromptInput?.trim() ?? "";

      if (!shell.selectedRepoId) {
        state = { mode: "main", shell: syncShell({ ...shell, taskPromptError: "Select a repo first." }) };
        render();
        return;
      }

      if (prompt.length === 0) {
        state = { mode: "main", shell: syncShell({ ...shell, taskPromptError: "Task prompt cannot be empty." }) };
        render();
        return;
      }

      creatingTask = true;
      state = {
        mode: "main",
        shell: syncShell({
          ...shell,
          actionMessage: `Creating task in ${shell.selectedRepoId}...`,
        }),
      };
      render();

      try {
        const createdTask = await createInteractiveTask(paths, shell.selectedRepoId, prompt);
        await reloadModel();
        const nextShell = syncShell({
          ...state.shell,
          selectedRepoId: createdTask.repoId,
          selectedTaskId: createdTask.id,
          selectedPtyTabId: createdTask.selectedPtyTabId,
          selectedLeftItemId: `task:${createdTask.id}`,
          activeTab: createdTask.selectedPtyTabId ?? "files",
          inputMode: "terminal",
          taskPromptInput: null,
          taskPromptError: null,
          actionMessage: null,
        });
        const view = ptyRuntime.ensureSession(
          createdTask.id,
          nextShell.selectedPtyTabId ?? getRequiredPtyTabId(createdTask, "agent"),
          getPtySize(getViewport(activeTerminal.width, activeTerminal.height)),
        );
        suppressTerminalEnterOnAttach = isAgentTabId(nextShell.selectedPtyTabId);
        state = { mode: "main", shell: updateTerminalViewState(nextShell, view) };
        persistShellState(state.shell);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create task.";
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            inputMode: "control",
            taskPromptInput: "",
            taskPromptError: message,
            actionMessage: null,
          }),
        };
      } finally {
        creatingTask = false;
        render();
      }
    };

    const handlePromptKey = (key: string) => {
      if (state.mode !== "main") {
        return;
      }

      const shell = state.shell;
      if (shell.taskPromptInput === null) {
        return;
      }

      if (key === "ESCAPE") {
        state = {
          mode: "main",
          shell: syncShell({ ...shell, taskPromptInput: null, taskPromptError: null, actionMessage: null }),
        };
        render();
        return;
      }

      if (isEnterKey(key)) {
        void submitTaskPrompt();
        return;
      }

      if (key === "BACKSPACE") {
        state = {
          mode: "main",
          shell: syncShell({
            ...shell,
            taskPromptInput: shell.taskPromptInput.slice(0, -1),
            taskPromptError: null,
          }),
        };
        render();
        return;
      }

      if (isPrintableKey(key)) {
        state = {
          mode: "main",
          shell: syncShell({
            ...shell,
            taskPromptInput: `${shell.taskPromptInput}${key}`,
            taskPromptError: null,
          }),
        };
        render();
      }
    };

    const handleWorkspaceBrowserKey = (key: string) => {
      if (state.mode !== "main") {
        return;
      }

      const browser = state.shell.workspaceBrowser;
      if (!browser) {
        return;
      }

      if (key === "ESCAPE") {
        state = {
          mode: "main",
          shell: syncShell({ ...state.shell, workspaceBrowser: null, actionMessage: null }),
        };
        render();
        return;
      }

      if (key === "UP" || key === "k") {
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            workspaceBrowser: {
              ...browser,
              selectedIndex: Math.max(0, browser.selectedIndex - 1),
              error: null,
            },
          }),
        };
        render();
        return;
      }

      if (key === "DOWN" || key === "j") {
        const maxIndex = Math.max(0, browser.entries.length - 1);
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            workspaceBrowser: {
              ...browser,
              selectedIndex: Math.min(maxIndex, browser.selectedIndex + 1),
              error: null,
            },
          }),
        };
        render();
        return;
      }

      if (key === "LEFT" || key === "h") {
        void openWorkspaceBrowser(path.dirname(browser.cwd)).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Failed to open parent directory.";
          state = {
            mode: "main",
            shell: syncShell({
              ...state.shell,
              workspaceBrowser: {
                ...browser,
                error: message,
              },
            }),
          };
          render();
        });
        return;
      }

      if (key === "RIGHT" || key === "l" || isEnterKey(key)) {
        const selectedEntry = browser.entries[browser.selectedIndex] ?? null;

        if (!selectedEntry) {
          return;
        }

        if (selectedEntry.kind === "directory" || ((key === "RIGHT" || key === "l") && selectedEntry.kind === "repo")) {
          void openWorkspaceBrowser(selectedEntry.path).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to open directory.";
            state = {
              mode: "main",
              shell: syncShell({
                ...state.shell,
                workspaceBrowser: {
                  ...browser,
                  error: message,
                },
              }),
            };
            render();
          });
          return;
        }

        void addRepo(paths, selectedEntry.path)
          .then(async (result) => {
            await reloadModel();
            const nextShell = syncShell({
              ...state.shell,
              workspaceBrowser: null,
              selectedLeftItemId: `repo:${result.repo.id}`,
              selectedRepoId: result.repo.id,
              selectedTaskId: null,
              selectedPtyTabId: null,
              actionMessage: `Registered workspace: ${result.repo.name}`,
            });
            state = { mode: "main", shell: nextShell };
            persistShellState(state.shell);
            render();
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to add workspace.";
            state = {
              mode: "main",
              shell: syncShell({
                ...state.shell,
                workspaceBrowser: {
                  ...browser,
                  error: message,
                },
              }),
            };
            render();
          });
      }
    };

    const onKey = (name: unknown) => {
      const key = typeof name === "string" ? name : "";

      if (state.mode === "main" && state.shell.taskPromptInput !== null) {
        handlePromptKey(key);
        return;
      }

      if (state.mode === "main" && state.shell.workspaceBrowser !== null) {
        handleWorkspaceBrowserKey(key);
        return;
      }

      if (state.mode === "main") {
        const result = reduceMainKey(state.shell, key, getShellKeyOptions(state.shell));

        if (result.exit) {
          exit(0);
          return;
        }

        if (result.detachTerminal) {
          ptyRuntime.detach();
          state = { mode: "main", shell: syncShell(result.state) };
          render();
          return;
        }

        if (state.shell.inputMode === "terminal") {
          if (suppressTerminalEnterOnAttach && isEnterKey(key)) {
            suppressTerminalEnterOnAttach = false;
            return;
          }

          if (suppressTerminalEnterOnAttach) {
            suppressTerminalEnterOnAttach = false;
          }

          if (isDuplicateTerminalKey(lastTerminalKey, key)) {
            return;
          }

          lastTerminalKey = shouldTrackTerminalKey(key) ? { key, at: Date.now() } : null;

          const scrollLines = getTerminalScrollLinesForKey(key);
          if (scrollLines !== 0) {
            scheduleTerminalViewportScroll(scrollLines);
            return;
          }

          ptyRuntime.writeKey(key);
          return;
        }

        if (key === "CTRL_C") {
          exit(0);
          return;
        }

        if (result.pause) {
          state = { mode: "overlay", variant: "pause", menuIndex: 0, optionsMessage: null, shell: syncShell(result.state) };
          render();
          return;
        }

        if (result.beginTaskPrompt) {
          state = { mode: "main", shell: syncShell(result.state) };
          persistShellState(state.shell);
          render();
          return;
        }

        if (result.openWorkspaceBrowser) {
          void openWorkspaceBrowser(workspaceRoot).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to browse workspaces.";
            state = {
              mode: "main",
              shell: syncShell({
                ...result.state,
                workspaceBrowser: {
                  cwd: workspaceRoot,
                  entries: [],
                  selectedIndex: 0,
                  error: message,
                },
              }),
            };
            render();
          });
          return;
        }

        if (result.createPtyTab) {
          void createPtyTabFromShell(result.state)
            .then((nextShell) => {
              state = { mode: "main", shell: nextShell };
              persistShellState(state.shell);
              render();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to create tab.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.closePtyTab) {
          void closePtyTabFromShell(result.state)
            .then((nextShell) => {
              state = { mode: "main", shell: nextShell };
              persistShellState(state.shell);
              render();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to close tab.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.attachTerminal) {
          void attachPtyFromShell(result.state);
          return;
        }

        if (result.changed) {
          state = { mode: "main", shell: syncShell(result.state) };
          void persistTaskPtySelection(state.shell).catch(() => undefined);
          persistShellState(state.shell);
          render();
        }
        return;
      }

      if (state.optionsMessage) {
        if (key === "ESCAPE" || isEnterKey(key)) {
          state = { ...state, optionsMessage: null };
          render();
        }
        return;
      }

      if (key === "UP" || key === "k") {
        state = {
          ...state,
          menuIndex: Math.max(0, state.menuIndex - 1),
        };
        render();
        return;
      }

      if (key === "DOWN" || key === "j") {
        state = {
          ...state,
          menuIndex: Math.min(2, state.menuIndex + 1),
        };
        render();
        return;
      }

      if (key === "ESCAPE") {
        if (state.variant === "pause") {
          state = { mode: "main", shell: syncShell(state.shell) };
          render();
        }
        return;
      }

      if (!isEnterKey(key)) {
        return;
      }

      if (state.menuIndex === 0) {
        state = { mode: "main", shell: syncShell(state.shell) };
        render();
        return;
      }

      if (state.menuIndex === 1) {
        state = {
          ...state,
          optionsMessage: "Options are not available in phase 3.1.",
        };
        render();
        return;
      }

      exit(0);
    };

    const onUnknown = (input: unknown) => {
      const raw = inputToString(input);
      if (state.mode !== "main" || state.shell.inputMode !== "terminal" || raw.length === 0) {
        return;
      }

      if (raw.includes("\u001D")) {
        ptyRuntime.detach();
        suppressTerminalEnterOnAttach = false;
        lastTerminalKey = null;
        state = { mode: "main", shell: syncShell({ ...state.shell, inputMode: "control", actionMessage: null }) };
        render();
        return;
      }

      const scrollLines = getTerminalScrollLinesForRawInput(raw);
      if (scrollLines !== 0) {
        scheduleTerminalViewportScroll(scrollLines);
        return;
      }

      if (suppressTerminalEnterOnAttach && raw !== "\r" && raw !== "\n" && raw !== "\r\n") {
        suppressTerminalEnterOnAttach = false;
      }

      if (shouldSuppressRawTerminalInput(suppressTerminalEnterOnAttach, lastTerminalKey, raw)) {
        suppressTerminalEnterOnAttach = false;
        return;
      }

      ptyRuntime.write(raw);
    };

    const onMouse = (name: unknown) => {
      if (state.mode !== "main" || state.shell.inputMode !== "terminal") {
        return;
      }

      const scrollLines = getTerminalScrollLinesForMouseEvent(name);
      if (scrollLines === 0) {
        return;
      }

      scheduleTerminalViewportScroll(scrollLines);
    };

    function scheduleTerminalViewportScroll(lines: number): void {
      pendingScrollLines += lines;

      if (scrollRenderTimer) {
        return;
      }

      scrollRenderTimer = setTimeout(() => {
        scrollRenderTimer = null;
        const linesToScroll = pendingScrollLines;
        pendingScrollLines = 0;

        if (linesToScroll === 0) {
          return;
        }

        scrollTerminalViewport(linesToScroll);
        render();
      }, 16);
    }

    function scrollTerminalViewport(lines: number): void {
      ptyRuntime.scrollViewport(lines);
      state = { mode: "main", shell: withTerminalView(state.shell) };
    }

    const handleResize = () => {
      pendingClear = true;

      if (state.mode === "main" && state.shell.inputMode === "terminal") {
        ptyRuntime.resize(getPtySize(getViewport(activeTerminal.width, activeTerminal.height)));
        state = { mode: "main", shell: withTerminalView(state.shell) };
      }

      render();
    };

    process.stdout.on("resize", handleResize);
    activeTerminal.grabInput({ mouse: "button" });
    activeTerminal.hideCursor(true);
    activeTerminal.fullscreen(true);
    activeTerminal.on("key", onKey);
    activeTerminal.on("unknown", onUnknown);
    activeTerminal.on("mouse", onMouse);
    render();
  });
}

async function loadWorkspaceShellModel(workspaceRoot: string): Promise<WorkspaceShellModel> {
  const paths = getCraigPaths(workspaceRoot);
  const [repos, taskResult] = await Promise.all([listRepos(paths), listTasks(paths)]);
  return {
    workspaceRoot,
    repos,
    tasks: taskResult.tasks,
  };
}

function resolveShellState(state: ControlShellState, model: WorkspaceShellModel): ControlShellState {
  return restoreShellState(state, model);
}

function getLeftItemIds(model: WorkspaceShellModel): string[] {
  const itemIds: string[] = [];

  for (const repo of model.repos) {
    itemIds.push(`repo:${repo.id}`);
    for (const task of model.tasks.filter((entry) => entry.repoId === repo.id)) {
      itemIds.push(`task:${task.id}`);
    }
  }

  itemIds.push("new-task");
  itemIds.push("new-workspace");
  return itemIds;
}

function resolvePtySessionSpec(model: WorkspaceShellModel, tabId: string, workspaceRoot: string) {
  const task = model.tasks.find((entry) => entry.ptyTabs.some((tab) => tab.id === tabId)) ?? null;
  const tab = task?.ptyTabs.find((entry) => entry.id === tabId) ?? null;

  return {
    cwd: task?.worktreePath ?? workspaceRoot,
    command: tab?.kind === "agent" ? resolveAgentCommand(tab) : [],
  };
}

function resolveAgentCommand(tab: TaskPtyTabRecord): string[] {
  return [tab.command[0] ?? "codex"];
}

function resolveNewPtyTabKind(task: TaskRecord, activeTab: string): TaskPtyTabRecord["kind"] {
  return task.ptyTabs.find((tab) => tab.id === activeTab)?.kind ?? "terminal";
}

function createNextPtyTab(task: TaskRecord, kind: TaskPtyTabRecord["kind"]): TaskPtyTabRecord {
  const baseTitle = kind === "agent" ? "Codex" : "Terminal";
  const baseId = `${task.id}:${kind}`;
  const existingIds = new Set(task.ptyTabs.map((tab) => tab.id));
  let ordinal = 1;
  let id = baseId;

  while (existingIds.has(id)) {
    ordinal += 1;
    id = `${baseId}-${ordinal}`;
  }

  const timestamp = new Date().toISOString();
  return {
    id,
    kind,
    title: ordinal === 1 ? baseTitle : `${baseTitle} ${ordinal}`,
    command: kind === "agent" ? ["codex"] : [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function createInteractiveTask(paths: ReturnType<typeof getCraigPaths>, repoId: string, prompt: string): Promise<TaskRecord> {
  const provisioned = await provisionTask(paths, repoId, prompt);
  const agentTabId = getRequiredPtyTabId(provisioned.task, "agent");
  const runningTask: TaskRecord = {
    ...provisioned.task,
    status: "running",
    selectedPtyTabId: agentTabId,
    runnerSession: {
      ...provisioned.task.runnerSession,
      startedAt: new Date().toISOString(),
      lastKnownState: "running",
    },
  };

  await writeTask(paths, runningTask);
  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...((await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState()),
      version: 1,
      selectedRepoId: runningTask.repoId,
      selectedWorkspaceId: runningTask.workspaceId,
      selectedTaskId: runningTask.id,
      selectedPtyTabId: runningTask.selectedPtyTabId,
      inputMode: "control",
      focusedRegion: "center",
      activeTab: runningTask.selectedPtyTabId ?? "files",
      selectedActionId: "commit",
      updatedAt: new Date().toISOString(),
    },
  );

  return runningTask;
}

function getRequiredPtyTabId(task: TaskRecord, kind: TaskPtyTabRecord["kind"]): string {
  const tab = task.ptyTabs.find((entry) => entry.kind === kind);
  if (!tab) {
    throw new Error(`Task ${task.id} is missing its ${kind} PTY tab.`);
  }

  return tab.id;
}

function getPtySize(viewport: Viewport): PtySize {
  // The center PTY surface reserves:
  // 1. tab strip
  // 2. active-tab underline
  // 3. task header
  // 4. spacer before the PTY surface
  return {
    columns: Math.max(
      20,
      viewport.width -
        SHELL_LAYOUT.leftWidth -
        SHELL_LAYOUT.rightWidth -
        SHELL_LAYOUT.dividerWidth -
        CENTER_TERMINAL_GUTTER * 2,
    ),
    rows: Math.max(5, viewport.height - SHELL_LAYOUT.topRailHeight - 4),
  };
}

function inputToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return "";
}

function shouldTrackTerminalKey(key: string): boolean {
  return key.length === 1 || isEnterKey(key) || key === "BACKSPACE" || key === "TAB";
}

function isDuplicateTerminalKey(previous: { key: string; at: number } | null, key: string): boolean {
  if (!previous || previous.key !== key || !shouldTrackTerminalKey(key)) {
    return false;
  }

  return Date.now() - previous.at < 30;
}

function isAgentTabId(tabId: string | null): boolean {
  return typeof tabId === "string" && /:agent(?:-\d+)?$/.test(tabId);
}

function getTerminalScrollLinesForKey(key: string): number {
  if (key === "PAGE_UP") {
    return -5;
  }

  if (key === "PAGE_DOWN") {
    return 5;
  }

  if (key === "MOUSE_WHEEL_UP") {
    return -3;
  }

  if (key === "MOUSE_WHEEL_DOWN") {
    return 3;
  }

  return 0;
}

function getTerminalScrollLinesForMouseEvent(name: unknown): number {
  if (name === "MOUSE_WHEEL_UP") {
    return -3;
  }

  if (name === "MOUSE_WHEEL_DOWN") {
    return 3;
  }

  return 0;
}

function getTerminalScrollLinesForRawInput(raw: string): number {
  const match = new RegExp(`${String.fromCharCode(27)}\\[<(\\d+);\\d+;\\d+[mM]`).exec(raw);
  if (!match?.[1]) {
    return 0;
  }

  const code = Number.parseInt(match[1], 10);
  if (code === 64) {
    return -3;
  }

  if (code === 65) {
    return 3;
  }

  return 0;
}

function shouldSuppressRawTerminalInput(
  suppressTerminalEnterOnAttach: boolean,
  previous: { key: string; at: number } | null,
  raw: string,
): boolean {
  if (raw.length === 0) {
    return false;
  }

  if (suppressTerminalEnterOnAttach && (raw === "\r" || raw === "\n" || raw === "\r\n")) {
    return true;
  }

  if (!previous || Date.now() - previous.at >= 30) {
    return false;
  }

  if (raw === previous.key) {
    return true;
  }

  return raw.length <= 4 && raw.split("").every((char) => char === previous.key);
}

async function loadWorkspaceBrowser(rootPath: string): Promise<WorkspaceBrowserState> {
  const directoryEntries = await readdir(rootPath, { withFileTypes: true });
  const entries: WorkspaceBrowserEntry[] = [];

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(rootPath, entry.name);
    entries.push({
      name: entry.name,
      path: entryPath,
      kind: (await isGitRepoDirectory(entryPath)) ? "repo" : "directory",
    });
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "repo" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    cwd: rootPath,
    entries,
    selectedIndex: 0,
    error: null,
  };
}

async function isGitRepoDirectory(rootPath: string): Promise<boolean> {
  const gitPath = path.join(rootPath, ".git");
  const stats = await stat(gitPath).catch(() => null);
  return stats !== null;
}
