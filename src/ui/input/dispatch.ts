import path from "node:path";

import { configService } from "../../domain/config/index.js";
import { writeTask } from "../../domain/task/index.js";
import { errorService } from "../../domain/error/index.js";
import { getViewport } from "../layout.js";
import { getPtySize, getRequiredPtyTabId } from "../pty/session.js";
import { getWorkspaceBrowserVisibleEntries, openUrl } from "../workspace/browser.js";
import { getSelectedTask } from "../shell/sync.js";
import { getTaskPrimaryPr } from "../../domain/task/index.js";
import { isEnterKey, isPrintableKey, getNextRunner, updateTerminalViewState } from "../state.js";
import { reduceMainKey } from "./reducer.js";
import {
  reduceOptionsMenuKey,
  reduceRunnerOptionsKey,
  type RunnerOptionsState,
} from "../options.js";
import {
  isAgentTabId,
  inputToString,
  shouldTrackTerminalKey,
  getTerminalScrollLinesForKey,
  getTerminalScrollLinesForMouseEvent,
  getTerminalScrollLinesForRawInput,
  isRawTerminalInputPrefix,
  mapRawTerminalInputToKey,
  shouldSuppressRawTerminalInput,
  terminalKeyToRawSequencePart,
} from "./keyboard.js";
import {
  createInteractiveTask,
  InteractiveTaskStartupError,
  saveRunnerEnabled,
  saveRunnerPath,
} from "../actions/index.js";
import {
  syncShell,
  applyErrorToast,
  reportRecoverableError,
  persistShellState,
  persistTaskPtySelection,
  getShellKeyOptions,
  refreshInspection,
  reloadModel,
  scheduleLeftNavInspectionRefresh,
  scheduleInspectionViewportScroll,
  buildActionContext,
} from "../shell/sync.js";
import {
  attachPtyFromShell,
  createPtyTabFromShell,
  closePtyTabFromShell,
  closeTaskFromShell,
  removeWorkspaceFromShell,
  hydrateAndRenderOpenPtyTabs,
  warmSelectedPtyTab,
  scheduleTerminalViewportScroll,
} from "../pty/manager.js";
import { refreshPullRequestChecksFromShell } from "../workspace/pr-polling.js";
import { openWorkspaceBrowser } from "../workspace/browser.js";
import type { AppContext } from "../app-context.js";

function getRunnerOptionsState(ctx: AppContext): RunnerOptionsState {
  const state = ctx.state as Extract<typeof ctx.state, { mode: "overlay" }>;
  return state.runnerOptions ?? { menuIndex: state.menuIndex, message: state.optionsMessage };
}

async function submitTaskPrompt(ctx: AppContext): Promise<void> {
  if (ctx.state.mode !== "main" || ctx.creatingTask) {
    return;
  }

  const shell = ctx.state.shell;
  const prompt = shell.taskPromptInput?.trim() ?? "";

  if (!shell.selectedRepoId && !shell.selectedWorkspaceId) {
    ctx.state = { mode: "main", shell: syncShell(ctx, { ...shell, taskPromptError: "Select a workspace first." }) };
    ctx.render();
    return;
  }

  if (prompt.length === 0) {
    ctx.state = { mode: "main", shell: syncShell(ctx, { ...shell, taskPromptError: "Task prompt cannot be empty." }) };
    ctx.render();
    return;
  }

  ctx.creatingTask = true;
  ctx.state = {
    mode: "main",
    shell: syncShell(ctx, {
      ...shell,
      actionMessage: `Creating ${shell.selectedRunner} task in ${shell.selectedWorkspaceId ?? shell.selectedRepoId}...`,
    }),
  };
  ctx.render();

  let createdTask = null;
  try {
    const created = await createInteractiveTask(
      shell.selectedRepoId,
      shell.selectedWorkspaceId,
      prompt,
      shell.selectedRunner,
      buildActionContext(ctx),
    );
    createdTask = created.task;
    await reloadModel(ctx);
    const nextShell = syncShell(ctx, {
      ...ctx.state.shell,
      ...created.nextShell,
      selectedLeftItemId: `task:${createdTask.id}`,
      inputMode: "terminal",
      taskPromptInput: null,
      taskPromptError: null,
      actionMessage: null,
    });
    const view = await ctx.ptyRuntime.ensureSession(
      createdTask.id,
      nextShell.selectedPtyTabId ?? getRequiredPtyTabId(createdTask, "agent"),
      getPtySize(getViewport(ctx.activeTerminal.width, ctx.activeTerminal.height)),
    );
    ctx.suppressTerminalEnterOnAttach = isAgentTabId(nextShell.selectedPtyTabId);
    ctx.state = { mode: "main", shell: updateTerminalViewState(nextShell, view) };
    persistShellState(ctx, ctx.state.shell);
  } catch (error) {
    if (error instanceof InteractiveTaskStartupError) {
      createdTask = error.task;
    }
    const message = reportRecoverableError(ctx, "create task", error, "Failed to create task.");
    if (createdTask && !(error instanceof InteractiveTaskStartupError)) {
      await writeTask(ctx.paths, {
        ...createdTask,
        status: "draft",
        runnerSession: {
          ...createdTask.runnerSession,
          lastKnownState: "failed",
          exitedAt: new Date().toISOString(),
        },
        lastFailureReason: message,
      }).catch(() => undefined);
      await reloadModel(ctx).catch(() => undefined);
    } else if (createdTask) {
      await writeTask(ctx.paths, { ...createdTask, lastFailureReason: message }).catch(() => undefined);
      await reloadModel(ctx).catch(() => undefined);
    }
    ctx.state = {
      mode: "main",
      shell: applyErrorToast(
        ctx,
        syncShell(ctx, {
          ...ctx.state.shell,
          inputMode: "control",
          selectedTaskId: createdTask?.id ?? ctx.state.shell.selectedTaskId,
          selectedPtyTabId: createdTask?.selectedPtyTabId ?? ctx.state.shell.selectedPtyTabId,
          selectedLeftItemId: createdTask ? `task:${createdTask.id}` : ctx.state.shell.selectedLeftItemId,
          activeTab: createdTask?.selectedPtyTabId ?? ctx.state.shell.activeTab,
          taskPromptInput: createdTask ? null : "",
          taskPromptError: message,
          actionMessage: null,
        }),
        message,
      ),
    };
  } finally {
    ctx.creatingTask = false;
    ctx.render();
  }
}

function handlePromptKey(ctx: AppContext, key: string): void {
  if (ctx.state.mode !== "main") {
    return;
  }

  const shell = ctx.state.shell;
  if (shell.taskPromptInput === null) {
    return;
  }

  if (key === "ESCAPE") {
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, { ...shell, taskPromptInput: null, taskPromptError: null, actionMessage: null }),
    };
    ctx.render();
    return;
  }

  if (isEnterKey(key)) {
    void submitTaskPrompt(ctx);
    return;
  }

  if (key === "BACKSPACE") {
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, {
        ...shell,
        taskPromptInput: shell.taskPromptInput.slice(0, -1),
        taskPromptError: null,
      }),
    };
    ctx.render();
    return;
  }

  if (key === "CTRL_R") {
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, {
        ...shell,
        selectedRunner: getNextRunner(shell.selectedRunner, ctx.enabledRunnerIds),
        taskPromptError: null,
      }),
    };
    ctx.render();
    return;
  }

  if (isPrintableKey(key)) {
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, {
        ...shell,
        taskPromptInput: `${shell.taskPromptInput}${key}`,
        taskPromptError: null,
      }),
    };
    ctx.render();
  }
}

function handleWorkspaceBrowserKey(ctx: AppContext, key: string): void {
  if (ctx.state.mode !== "main") {
    return;
  }

  const browser = ctx.state.shell.workspaceBrowser;
  if (!browser) {
    return;
  }

  if (key === "ESCAPE") {
    if (browser.query !== null) {
      ctx.state = {
        mode: "main",
        shell: syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: { ...browser, query: null, selectedIndex: 0 } }),
      };
      ctx.render();
      return;
    }
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: null, actionMessage: null }),
    };
    ctx.render();
    return;
  }

  if (key === "/") {
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: { ...browser, query: "", selectedIndex: 0 } }),
    };
    ctx.render();
    return;
  }

  if (browser.query !== null && (key === "BACKSPACE" || key === "DELETE")) {
    const q = browser.query.slice(0, -1);
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: { ...browser, query: q, selectedIndex: 0 } }),
    };
    ctx.render();
    return;
  }

  if (browser.query !== null && key.length === 1 && key >= " ") {
    const q = browser.query + key;
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: { ...browser, query: q, selectedIndex: 0 } }),
    };
    ctx.render();
    return;
  }

  const visibleEntries = getWorkspaceBrowserVisibleEntries(browser);

  if (key === "UP" || key === "k") {
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, {
        ...ctx.state.shell,
        workspaceBrowser: { ...browser, selectedIndex: Math.max(0, browser.selectedIndex - 1), error: null },
      }),
    };
    ctx.render();
    return;
  }

  if (key === "DOWN" || key === "j") {
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, {
        ...ctx.state.shell,
        workspaceBrowser: {
          ...browser,
          selectedIndex: Math.min(Math.max(0, visibleEntries.length - 1), browser.selectedIndex + 1),
          error: null,
        },
      }),
    };
    ctx.render();
    return;
  }

  if (key === "LEFT" || key === "h") {
    void openWorkspaceBrowser(ctx, path.dirname(browser.cwd)).catch((error: unknown) => {
      const message = reportRecoverableError(ctx, "open parent workspace directory", error, "Failed to open parent directory.");
      ctx.state = {
        mode: "main",
        shell: applyErrorToast(ctx, syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: { ...browser, error: message } }), message),
      };
      ctx.render();
    });
    return;
  }

  if (key === "RIGHT" || key === "l" || isEnterKey(key)) {
    const selectedEntry = visibleEntries[browser.selectedIndex] ?? null;
    if (!selectedEntry) {
      return;
    }

    if ((key === "RIGHT" || key === "l") && (selectedEntry.kind === "directory" || selectedEntry.kind === "repo")) {
      void openWorkspaceBrowser(ctx, selectedEntry.path).catch((error: unknown) => {
        const message = reportRecoverableError(ctx, "open workspace directory", error, "Failed to open directory.");
        ctx.state = {
          mode: "main",
          shell: applyErrorToast(ctx, syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: { ...browser, error: message } }), message),
        };
        ctx.render();
      });
      return;
    }

    const { workspaceService: ws } = buildActionContext(ctx);
    void ws.addWorkspace(ctx.paths, selectedEntry.path)
      .then(async (result) => {
        await reloadModel(ctx);
        const selectedRepo = result.repos[0] ?? null;
        const nextShell = syncShell(ctx, {
          ...ctx.state.shell,
          workspaceBrowser: null,
          selectedLeftItemId: `workspace:${result.workspace.id}`,
          selectedWorkspaceId: result.workspace.id,
          selectedRepoId: selectedRepo?.id ?? null,
          selectedTaskId: null,
          selectedPtyTabId: null,
          actionMessage: `Registered workspace: ${result.workspace.name ?? result.workspace.id}`,
        });
        ctx.state = { mode: "main", shell: nextShell };
        persistShellState(ctx, ctx.state.shell);
        ctx.render();
      })
      .catch((error: unknown) => {
        const message = reportRecoverableError(ctx, "add workspace", error, "Failed to add workspace.");
        ctx.state = {
          mode: "main",
          shell: applyErrorToast(ctx, syncShell(ctx, { ...ctx.state.shell, workspaceBrowser: { ...browser, error: message } }), message),
        };
        ctx.render();
      });
  }
}

function handleOptionsMenuKey(ctx: AppContext, key: string): void {
  if (ctx.state.mode !== "overlay" || ctx.state.variant !== "options") {
    return;
  }

  const result = reduceOptionsMenuKey(ctx.state.menuIndex, key);

  if (result.kind === "noop") {
    return;
  }

  if (result.kind === "render") {
    ctx.state = { ...ctx.state, menuIndex: result.menuIndex };
    ctx.render();
    return;
  }

  if (result.kind === "back") {
    if (ctx.state.parentVariant) {
      ctx.state = { mode: "overlay", variant: ctx.state.parentVariant, menuIndex: 1, optionsMessage: null, shell: ctx.state.shell };
      ctx.pendingClear = true;
      ctx.render();
    }
    return;
  }

  if (result.kind === "help") {
    const parentVariant = ctx.state.parentVariant;
    ctx.state = {
      mode: "overlay",
      variant: "help",
      menuIndex: 0,
      optionsMessage: null,
      shell: ctx.state.shell,
      viaOptions: true,
      ...(parentVariant !== undefined ? { parentVariant } : {}),
    };
    ctx.pendingClear = true;
    ctx.render();
    return;
  }

  if (result.kind === "runners") {
    const parentVariant = ctx.state.parentVariant;
    ctx.state = {
      mode: "overlay",
      variant: "runners",
      menuIndex: 0,
      optionsMessage: null,
      shell: ctx.state.shell,
      ...(parentVariant !== undefined ? { parentVariant } : {}),
    };
    ctx.pendingClear = true;
    ctx.render();
    return;
  }

  if (result.kind === "error-log") {
    const parentVariant = ctx.state.parentVariant;
    void openErrorLogOverlay(ctx, parentVariant);
  }
}

async function openErrorLogOverlay(ctx: AppContext, parentVariant: "boot" | "pause" | undefined): Promise<void> {
  let errorLog;
  try {
    errorLog = await errorService.readRecentErrorLines(ctx.paths);
  } catch (error) {
    const message = reportRecoverableError(ctx, "open error log", error, "Failed to read Craig error log.");
    errorLog = {
      path: ctx.paths.errorLogFile,
      lines: [`Unable to read error log: ${message}`],
      empty: false,
    };
  }

  if (ctx.state.mode !== "overlay") {
    return;
  }

  ctx.state = {
    mode: "overlay",
    variant: "error-log",
    menuIndex: 0,
    optionsMessage: null,
    shell: ctx.state.shell,
    errorLog,
    ...(parentVariant !== undefined ? { parentVariant } : {}),
  };
  ctx.pendingClear = true;
  ctx.render();
}

function handleRunnersKey(ctx: AppContext, key: string): void {
  if (ctx.state.mode !== "overlay" || ctx.state.variant !== "runners") {
    return;
  }

  const result = reduceRunnerOptionsKey(getRunnerOptionsState(ctx), ctx.config, key, ctx.enabledRunnerIds);

  if (result.kind === "noop") {
    return;
  }

  if (result.kind === "back") {
    const parentVariant = ctx.state.parentVariant;
    ctx.state = {
      mode: "overlay",
      variant: "options",
      menuIndex: 0,
      optionsMessage: null,
      shell: ctx.state.shell,
      ...(parentVariant !== undefined ? { parentVariant } : {}),
    };
    ctx.pendingClear = true;
    ctx.render();
    return;
  }

  if (result.kind === "render") {
    ctx.state = { ...ctx.state, runnerOptions: result.state };
    ctx.render();
    return;
  }

  const savePromise =
    result.kind === "save-enabled"
      ? saveRunnerEnabled(result.runner, result.enabled, buildActionContext(ctx))
      : saveRunnerPath(result.runner, result.path, buildActionContext(ctx));

  void savePromise
    .then((nextConfig) => {
      if (ctx.state.mode !== "overlay" || ctx.state.variant !== "runners") {
        return;
      }
      ctx.config = nextConfig;
      ctx.enabledRunnerIds = configService.runners.getEnabled(ctx.config);
      ctx.model = { ...ctx.model, enabledRunnerIds: ctx.enabledRunnerIds };
      ctx.state = {
        ...ctx.state,
        shell: syncShell(ctx, {
          ...ctx.state.shell,
          selectedRunner: ctx.enabledRunnerIds.includes(ctx.state.shell.selectedRunner)
            ? ctx.state.shell.selectedRunner
            : configService.runners.getDefault(ctx.config),
        }),
        runnerOptions: result.state,
      };
      ctx.render();
    })
    .catch((error: unknown) => {
      if (ctx.state.mode !== "overlay" || ctx.state.variant !== "runners") {
        return;
      }
      const message = reportRecoverableError(ctx, "save runner option", error, "Failed to save runner option.");
      ctx.state = {
        ...ctx.state,
        shell: applyErrorToast(ctx, syncShell(ctx, ctx.state.shell), message),
        runnerOptions: { ...getRunnerOptionsState(ctx), message },
      };
      ctx.render();
    });
}

export function onKey(ctx: AppContext, name: unknown): void {
  const key = typeof name === "string" ? name : "";

  if (ctx.state.mode === "main" && ctx.state.shell.taskPromptInput !== null) {
    handlePromptKey(ctx, key);
    return;
  }

  if (ctx.state.mode === "main" && ctx.state.shell.workspaceBrowser !== null) {
    handleWorkspaceBrowserKey(ctx, key);
    return;
  }

  if (ctx.state.mode === "main" && ctx.state.shell.inputMode === "control") {
    if (key === "F") {
      triggerFocusFlash(ctx);
      ctx.render();
      return;
    }
    if (ctx.focusFlashUntil !== null) {
      ctx.focusFlashUntil = null;
      if (ctx.focusFlashTimer) {
        clearTimeout(ctx.focusFlashTimer);
        ctx.focusFlashTimer = null;
      }
    }
  }

  if (ctx.state.mode === "main") {
    const result = reduceMainKey(ctx.state.shell, key, getShellKeyOptions(ctx, ctx.state.shell));

    if (result.exit) {
      ctx.exit(0);
      return;
    }

    if (result.detachTerminal) {
      ctx.ptyRuntime.detach();
      ctx.state = { mode: "main", shell: syncShell(ctx, result.state) };
      persistShellState(ctx, ctx.state.shell);
      ctx.render();
      return;
    }

    if (ctx.state.shell.inputMode === "terminal") {
      if (result.changed) {
        ctx.state = { mode: "main", shell: syncShell(ctx, result.state) };
        persistShellState(ctx, ctx.state.shell);
        ctx.render();
        return;
      }

      if (ctx.suppressTerminalEnterOnAttach && isEnterKey(key)) {
        ctx.suppressTerminalEnterOnAttach = false;
        return;
      }

      if (ctx.suppressTerminalEnterOnAttach) {
        ctx.suppressTerminalEnterOnAttach = false;
      }

      const mappedRawKey = mapRawTerminalInputToKey(key);
      if (mappedRawKey) {
        ctx.lastTerminalKey = { key: mappedRawKey, at: Date.now() };
        ctx.ptyRuntime.writeKey(mappedRawKey);
        return;
      }

      if (handleTerminalKeySequence(ctx, key)) {
        return;
      }

      ctx.lastTerminalKey = shouldTrackTerminalKey(key) ? { key, at: Date.now() } : null;

      const scrollLines = getTerminalScrollLinesForKey(key, ctx.state.shell.terminal.scrolledBack ?? false);
      if (scrollLines !== 0) {
        scheduleTerminalViewportScroll(ctx, scrollLines);
        return;
      }

      ctx.ptyRuntime.writeKey(key);
      return;
    }

    if (key === "CTRL_C") {
      ctx.exit(0);
      return;
    }

    if (key === "?" && ctx.state.shell.inputMode === "control") {
      ctx.state = { mode: "overlay", variant: "help", menuIndex: 0, optionsMessage: null, shell: ctx.state.shell };
      ctx.pendingClear = true;
      ctx.render();
      return;
    }

    if (result.pause) {
      ctx.state = {
        mode: "overlay",
        variant: "pause",
        menuIndex: 0,
        optionsMessage: null,
        shell: syncShell(ctx, result.state),
      };
      ctx.pendingClear = true;
      ctx.render();
      return;
    }

    if (result.beginTaskPrompt) {
      ctx.state = { mode: "main", shell: syncShell(ctx, result.state) };
      persistShellState(ctx, ctx.state.shell);
      ctx.render();
      return;
    }

    if (result.openWorkspaceBrowser) {
      void openWorkspaceBrowser(ctx, ctx.workspaceRoot).catch((error: unknown) => {
        const message = reportRecoverableError(ctx, "browse workspaces", error, "Failed to browse workspaces.");
        ctx.state = {
          mode: "main",
          shell: applyErrorToast(
            ctx,
            syncShell(ctx, {
              ...result.state,
              workspaceBrowser: { cwd: ctx.workspaceRoot, entries: [], selectedIndex: 0, query: null, error: message },
            }),
            message,
          ),
        };
        ctx.render();
      });
      return;
    }

    if (result.createPtyTab) {
      void createPtyTabFromShell(ctx, result.state, result.createPtyTabKind, result.createPtyTabRunner)
        .then((nextShell) => {
          void attachPtyFromShell(ctx, nextShell);
        })
        .catch((error: unknown) => {
          const message = reportRecoverableError(ctx, "create PTY tab", error, "Failed to create tab.");
          ctx.state = {
            mode: "main",
            shell: applyErrorToast(ctx, syncShell(ctx, { ...result.state, actionMessage: message }), message),
          };
          ctx.render();
        });
      return;
    }

    if (result.closePtyTab) {
      void closePtyTabFromShell(ctx, result.state)
        .then((nextShell) => {
          ctx.state = { mode: "main", shell: nextShell };
          persistShellState(ctx, ctx.state.shell);
          ctx.render();
        })
        .catch((error: unknown) => {
          const message = reportRecoverableError(ctx, "close PTY tab", error, "Failed to close tab.");
          ctx.state = {
            mode: "main",
            shell: applyErrorToast(ctx, syncShell(ctx, { ...result.state, actionMessage: message }), message),
          };
          ctx.render();
        });
      return;
    }

    if (result.refreshPullRequestChecks) {
      void refreshPullRequestChecksFromShell(ctx, result.state)
        .then((nextShell) => {
          ctx.state = { mode: "main", shell: nextShell };
          persistShellState(ctx, ctx.state.shell);
          ctx.render();
        })
        .catch((error: unknown) => {
          const message = reportRecoverableError(ctx, "refresh PR checks", error, "Failed to refresh PR checks.");
          ctx.state = {
            mode: "main",
            shell: applyErrorToast(ctx, syncShell(ctx, { ...result.state, actionMessage: message }), message),
          };
          ctx.render();
        });
      return;
    }

    if (result.openPrUrl) {
      const selectedTask = getSelectedTask(ctx.model.tasks, result.state);
      const prUrl = selectedTask ? getTaskPrimaryPr(selectedTask)?.url ?? null : null;
      if (prUrl) {
        openUrl(prUrl).catch((error: unknown) => {
          const message = reportRecoverableError(ctx, "open PR URL", error, "Failed to open PR in browser.");
          ctx.state = { mode: "main", shell: applyErrorToast(ctx, syncShell(ctx, result.state), message) };
          ctx.render();
        });
      } else {
        ctx.state = { mode: "main", shell: applyErrorToast(ctx, syncShell(ctx, result.state), "No PR URL available.") };
        ctx.render();
      }
      return;
    }

    if (result.closeTask) {
      void closeTaskFromShell(ctx, result.state)
        .then((nextShell) => {
          ctx.state = { mode: "main", shell: nextShell };
          persistShellState(ctx, ctx.state.shell);
          ctx.render();
        })
        .catch((error: unknown) => {
          const message = reportRecoverableError(ctx, "close task", error, "Failed to close task.");
          ctx.state = {
            mode: "main",
            shell: applyErrorToast(ctx, syncShell(ctx, { ...result.state, actionMessage: message }), message),
          };
          ctx.render();
        });
      return;
    }

    if (result.removeWorkspace) {
      void removeWorkspaceFromShell(ctx, result.state)
        .then((nextShell) => {
          ctx.state = { mode: "main", shell: nextShell };
          persistShellState(ctx, ctx.state.shell);
          ctx.render();
        })
        .catch((error: unknown) => {
          const message = reportRecoverableError(ctx, "remove workspace", error, "Failed to remove workspace.");
          ctx.state = {
            mode: "main",
            shell: applyErrorToast(ctx, syncShell(ctx, { ...result.state, actionMessage: message }), message),
          };
          ctx.render();
        });
      return;
    }

    if (result.attachTerminal) {
      void attachPtyFromShell(ctx, result.state);
      return;
    }

    if (result.refreshInspection) {
      ctx.state = { mode: "main", shell: syncShell(ctx, result.state) };
      persistShellState(ctx, ctx.state.shell);
      ctx.render();
      if (ctx.state.shell.focusedRegion === "tasks") {
        scheduleLeftNavInspectionRefresh(ctx, ctx.state.shell);
        return;
      }
      void refreshInspection(ctx, ctx.state.shell).catch((error: unknown) => {
        const message = reportRecoverableError(ctx, "refresh inspection", error, "Failed to refresh inspection.");
        ctx.state = {
          mode: "main",
          shell: applyErrorToast(ctx, syncShell(ctx, { ...ctx.state.shell, actionMessage: message }), message),
        };
        ctx.render();
      });
      return;
    }

    if (result.changed) {
      ctx.state = { mode: "main", shell: syncShell(ctx, result.state) };
      void persistTaskPtySelection(ctx, ctx.state.shell).catch(() => undefined);
      persistShellState(ctx, ctx.state.shell);
      ctx.render();
    }
    return;
  }

  if (ctx.state.variant === "help") {
    if (ctx.state.viaOptions && ctx.state.parentVariant) {
      ctx.state = {
        mode: "overlay",
        variant: "options",
        menuIndex: 2,
        optionsMessage: null,
        shell: ctx.state.shell,
        parentVariant: ctx.state.parentVariant,
      };
    } else if (ctx.state.parentVariant) {
      ctx.state = {
        mode: "overlay",
        variant: ctx.state.parentVariant,
        menuIndex: 1,
        optionsMessage: null,
        shell: ctx.state.shell,
      };
    } else {
      ctx.state = { mode: "main", shell: syncShell(ctx, ctx.state.shell) };
    }
    ctx.pendingClear = true;
    ctx.render();
    return;
  }

  if (ctx.state.variant === "options") {
    handleOptionsMenuKey(ctx, key);
    return;
  }

  if (ctx.state.variant === "runners") {
    handleRunnersKey(ctx, key);
    return;
  }

  if (ctx.state.variant === "error-log") {
    if (key === "ESCAPE" || isEnterKey(key)) {
      const parentVariant = ctx.state.parentVariant;
      ctx.state = {
        mode: "overlay",
        variant: "options",
        menuIndex: 1,
        optionsMessage: null,
        shell: ctx.state.shell,
        ...(parentVariant !== undefined ? { parentVariant } : {}),
      };
      ctx.pendingClear = true;
      ctx.render();
    }
    return;
  }

  if (ctx.state.optionsMessage) {
    if (key === "ESCAPE" || isEnterKey(key)) {
      ctx.state = { ...ctx.state, optionsMessage: null };
      ctx.render();
    }
    return;
  }

  if (key === "UP" || key === "k") {
    ctx.state = { ...ctx.state, menuIndex: Math.max(0, ctx.state.menuIndex - 1) };
    ctx.render();
    return;
  }

  if (key === "DOWN" || key === "j") {
    ctx.state = { ...ctx.state, menuIndex: Math.min(2, ctx.state.menuIndex + 1) };
    ctx.render();
    return;
  }

  if (key === "ESCAPE") {
    if (ctx.state.variant === "pause") {
      ctx.state = { mode: "main", shell: syncShell(ctx, ctx.state.shell) };
      ctx.pendingClear = true;
      ctx.render();
    }
    return;
  }

  if (!isEnterKey(key)) {
    return;
  }

  if (ctx.state.menuIndex === 0) {
    const fromBoot = ctx.state.variant === "boot";
    ctx.state = { mode: "main", shell: syncShell(ctx, { ...ctx.state.shell, inputMode: "control" }) };
    ctx.pendingClear = true;
    ctx.render();
    if (fromBoot) {
      void ctx.bootHydrationReady.then(() => {
        if (ctx.state.mode !== "main") {
          return;
        }
        const shellBeforeWarm = ctx.state.shell;
        void warmSelectedPtyTab(ctx, shellBeforeWarm)
          .then((shell) => {
            if (ctx.state.mode !== "main" || ctx.state.shell !== shellBeforeWarm) {
              return;
            }
            ctx.state = { mode: "main", shell };
            persistShellState(ctx, ctx.state.shell);
            ctx.render();
          })
          .catch((error: unknown) => {
            if (ctx.state.mode !== "main" || ctx.state.shell !== shellBeforeWarm) {
              return;
            }
            const message = reportRecoverableError(ctx, "warm selected PTY", error, "Failed to start selected PTY.");
            ctx.state = { mode: "main", shell: applyErrorToast(ctx, syncShell(ctx, ctx.state.shell), message) };
            persistShellState(ctx, ctx.state.shell);
            ctx.render();
          });
      });
    } else {
      hydrateAndRenderOpenPtyTabs(ctx);
    }
    return;
  }

  if (ctx.state.menuIndex === 1) {
    const parentVariant =
      ctx.state.variant === "boot" || ctx.state.variant === "pause" ? ctx.state.variant : undefined;
    ctx.state = {
      mode: "overlay",
      variant: "options",
      menuIndex: 0,
      optionsMessage: null,
      shell: ctx.state.shell,
      ...(parentVariant !== undefined ? { parentVariant } : {}),
    };
    ctx.pendingClear = true;
    ctx.render();
    return;
  }

  ctx.exit(0);
}

export function onUnknown(ctx: AppContext, input: unknown): void {
  const raw = inputToString(input);
  if (ctx.state.mode !== "main" || ctx.state.shell.inputMode !== "terminal" || raw.length === 0) {
    return;
  }

  if (ctx.pendingTerminalKeySequence) {
    const combinedRaw = `${ctx.pendingTerminalKeySequence.raw}${raw}`;
    const mappedKey = mapRawTerminalInputToKey(combinedRaw);
    if (mappedKey) {
      clearPendingTerminalKeySequence(ctx);
      ctx.suppressTerminalEnterOnAttach = false;
      ctx.lastTerminalKey = { key: mappedKey, at: Date.now() };
      ctx.ptyRuntime.writeKey(mappedKey);
      return;
    }

    if (isRawTerminalInputPrefix(combinedRaw)) {
      ctx.pendingTerminalKeySequence.raw = combinedRaw;
      schedulePendingTerminalKeySequenceFlush(ctx);
      return;
    }

    flushPendingTerminalKeySequence(ctx);
  }

  if (raw.includes("")) {
    ctx.ptyRuntime.detach();
    ctx.suppressTerminalEnterOnAttach = false;
    ctx.lastTerminalKey = null;
    ctx.state = {
      mode: "main",
      shell: syncShell(ctx, { ...ctx.state.shell, inputMode: "control", actionMessage: null, focusedRegion: "center" }),
    };
    persistShellState(ctx, ctx.state.shell);
    ctx.render();
    return;
  }

  const scrollLines = getTerminalScrollLinesForRawInput(raw);
  if (scrollLines !== 0) {
    scheduleTerminalViewportScroll(ctx, scrollLines);
    return;
  }

  const mappedKey = mapRawTerminalInputToKey(raw);
  if (mappedKey) {
    ctx.suppressTerminalEnterOnAttach = false;
    ctx.lastTerminalKey = { key: mappedKey, at: Date.now() };
    ctx.ptyRuntime.writeKey(mappedKey);
    return;
  }

  if (ctx.suppressTerminalEnterOnAttach && raw !== "\r" && raw !== "\n" && raw !== "\r\n") {
    ctx.suppressTerminalEnterOnAttach = false;
  }

  if (shouldSuppressRawTerminalInput(ctx.suppressTerminalEnterOnAttach, ctx.lastTerminalKey, raw)) {
    ctx.suppressTerminalEnterOnAttach = false;
    return;
  }

  ctx.ptyRuntime.write(raw);
}

function handleTerminalKeySequence(ctx: AppContext, key: string): boolean {
  if (ctx.pendingTerminalKeySequence) {
    const raw = terminalKeyToRawSequencePart(key);
    if (raw !== null) {
      const nextRaw = `${ctx.pendingTerminalKeySequence.raw}${raw}`;
      const mappedKey = mapRawTerminalInputToKey(nextRaw);
      if (mappedKey) {
        clearPendingTerminalKeySequence(ctx);
        ctx.lastTerminalKey = { key: mappedKey, at: Date.now() };
        ctx.ptyRuntime.writeKey(mappedKey);
        return true;
      }

      if (isRawTerminalInputPrefix(nextRaw)) {
        ctx.pendingTerminalKeySequence.raw = nextRaw;
        schedulePendingTerminalKeySequenceFlush(ctx);
        return true;
      }
    }

    flushPendingTerminalKeySequence(ctx);
    return false;
  }

  if (key !== "ESCAPE") {
    return false;
  }

  ctx.pendingTerminalKeySequence = {
    raw: "",
    timer: setTimeout(() => flushPendingTerminalKeySequence(ctx), 30),
  };
  return true;
}

function schedulePendingTerminalKeySequenceFlush(ctx: AppContext): void {
  if (!ctx.pendingTerminalKeySequence) {
    return;
  }

  clearTimeout(ctx.pendingTerminalKeySequence.timer);
  ctx.pendingTerminalKeySequence.timer = setTimeout(() => flushPendingTerminalKeySequence(ctx), 30);
}

function flushPendingTerminalKeySequence(ctx: AppContext): void {
  if (!ctx.pendingTerminalKeySequence) {
    return;
  }

  const pending = ctx.pendingTerminalKeySequence;
  ctx.pendingTerminalKeySequence = null;
  clearTimeout(pending.timer);
  ctx.ptyRuntime.write(pending.raw);
}

function clearPendingTerminalKeySequence(ctx: AppContext): void {
  if (!ctx.pendingTerminalKeySequence) {
    return;
  }

  clearTimeout(ctx.pendingTerminalKeySequence.timer);
  ctx.pendingTerminalKeySequence = null;
}

export function onMouse(ctx: AppContext, name: unknown): void {
  if (ctx.state.mode !== "main") {
    return;
  }

  if (ctx.state.shell.inputMode === "control") {
    scheduleInspectionViewportScroll(ctx, getTerminalScrollLinesForMouseEvent(name));
    return;
  }

  const scrollLines = getTerminalScrollLinesForMouseEvent(name);
  if (scrollLines === 0) {
    return;
  }

  scheduleTerminalViewportScroll(ctx, scrollLines);
}

function triggerFocusFlash(ctx: AppContext): void {
  ctx.focusFlashUntil = Date.now() + 600;
  if (ctx.focusFlashTimer) clearTimeout(ctx.focusFlashTimer);
  ctx.focusFlashTimer = setTimeout(() => {
    ctx.focusFlashUntil = null;
    ctx.focusFlashTimer = null;
    ctx.render();
  }, 600);
}
