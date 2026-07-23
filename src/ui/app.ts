import { createRequire } from "node:module";
import type * as TerminalKitModule from "terminal-kit";

import { readUiState } from "../state/ui-state-store.js";
import { configService } from "../domain/config/index.js";
import { getCraigPaths } from "../state/craig-paths.js";
import { loadWorkspaceShellModel } from "./shell/loader.js";
import { resolvePtySessionSpec, getPtySize } from "./pty/session.js";
import { positionFrameRows } from "./input/keyboard.js";
import type { PtyRuntimeOptions, PtyViewInvalidation } from "./pty/runtime.js";
import { createDaemonPtyRuntime } from "./pty/daemon.js";
import {
  renderBootOverlayFrame,
  renderErrorLogOverlayFrame,
  renderHelpOverlayFrame,
  renderMainShellPresentation,
  renderOptionsOverlayFrame,
  renderPauseOverlayFrame,
} from "./render.js";
import {
  buildPreviewSubmenuItems,
  buildRunnersSubmenuItems,
  getPreviewSubmenuMessage,
  getRunnersSubmenuMessage,
  OPTIONS_MENU_ITEMS,
  type PreviewOptionsState,
  type RunnerOptionsState,
} from "./options.js";
import { createInitialShellState, restoreShellState } from "./state.js";
import { getViewport } from "./layout.js";
import { buildShellData, type ShellData } from "./shell/data.js";
import type { RenderedRegion } from "./render.js";
import { buildCenterPaneUpdate } from "./center-pane-render.js";
import type { AppContext, AppState, TerminalRuntime, PtyRuntimePort, TerminalEventListener } from "./app-context.js";
import {
  buildActionContext,
  resolveTerminalViewTabId,
  syncShell,
  withTerminalView,
  restoreTerminalScreen,
} from "./shell/sync.js";
import { hydrateOpenPtyTabs, syncInputCapture } from "./pty/manager.js";
import { pollPullRequests } from "./workspace/pr-polling.js";
import { onKey, onUnknown, onMouse } from "./input/dispatch.js";
import { Heartbeat } from "./heartbeat.js";
import { logBackgroundError } from "./actions/index.js";

export type { TerminalRuntime, PtyRuntimePort, TerminalEventListener };

export interface TerminalAppOptions {
  uiStateFile?: string;
  workspaceRoot?: string;
  terminal?: TerminalRuntime;
  ptyRuntime?: PtyRuntimePort;
}

const require = createRequire(import.meta.url);
const terminalKit = require("terminal-kit") as typeof TerminalKitModule;
const terminal = terminalKit.terminal;

function getRunnerOptionsState(state: Extract<AppState, { mode: "overlay" }>): RunnerOptionsState {
  return state.runnerOptions ?? { menuIndex: state.menuIndex, message: state.optionsMessage };
}

function getPreviewOptionsState(state: Extract<AppState, { mode: "overlay" }>): PreviewOptionsState {
  return state.previewOptions ?? { menuIndex: state.menuIndex, message: state.optionsMessage };
}

function mergePtyInvalidations(
  current: PtyViewInvalidation | null,
  next: PtyViewInvalidation,
): PtyViewInvalidation {
  if (!current) {
    return next;
  }
  if (current.tabId !== next.tabId) {
    return { tabId: next.tabId, kind: "full" };
  }
  if (current.kind === "full" || next.kind === "full") {
    return { tabId: next.tabId, kind: "full" };
  }
  return {
    tabId: next.tabId,
    kind: "rows",
    rowIndices: [...new Set([...current.rowIndices, ...next.rowIndices])],
  };
}

export async function startTerminalApp(options: TerminalAppOptions = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Craig terminal shell requires a TTY.");
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const paths = getCraigPaths(workspaceRoot);
  let config = await configService.load(paths);
  let enabledRunnerIds = configService.runners.getEnabled(config);
  const runtimeState = options.uiStateFile ? await readUiState({ uiStateFile: options.uiStateFile }) : null;
  let model = await loadWorkspaceShellModel(workspaceRoot, undefined, enabledRunnerIds);
  const initialShell = restoreShellState(createInitialShellState(runtimeState, config), model);
  model = await loadWorkspaceShellModel(workspaceRoot, initialShell, enabledRunnerIds);
  const modelRef = { current: model };
  let handlePtyUpdate: NonNullable<PtyRuntimeOptions["onUpdate"]> = () => undefined;
  const ptyOptions: PtyRuntimeOptions = {
    workspaceRoot,
    onUpdate: (invalidation) => handlePtyUpdate(invalidation),
    resolveSessionSpec: (_taskId, tabId) => resolvePtySessionSpec(modelRef.current, tabId, workspaceRoot),
  };
  const initialPtyRuntime: PtyRuntimePort =
    options.ptyRuntime ??
    (await createDaemonPtyRuntime({
      ...ptyOptions,
      paths,
      viewUpdateMode: configService.previews.isEnabled(config, "incrementalCenterPane") ? "incremental" : "snapshot",
    }));

  return new Promise<number>((resolve) => {
    const activeTerminal = options.terminal ?? terminal;
    let lastRenderedFrame: string | null = null;
    let lastRenderedCenter: RenderedRegion | null = null;
    let lastShellData: ShellData | null = null;
    let pendingPtyInvalidation: PtyViewInvalidation | null = null;
    const ctx: AppContext = {
      state: {
        mode: "overlay",
        variant: "boot",
        menuIndex: 0,
        optionsMessage: null,
        shell: restoreShellState(initialShell, model),
      },
      get model() {
        return modelRef.current;
      },
      set model(nextModel) {
        modelRef.current = nextModel;
      },
      config,
      enabledRunnerIds,
      creatingTask: false,
      suppressTerminalEnterOnAttach: false,
      lastTerminalKey: null,
      pendingScrollLines: 0,
      pendingInspectionScrollLines: 0,
      leftNavInspectionTimer: null,
      pendingLeftNavInspectionShell: null,
      pendingTerminalKeySequence: null,
      scrollRenderTimer: null,
      inspectionScrollRenderTimer: null,
      ptyRenderTimer: null,
      footerToastTimer: null,
      focusFlashUntil: null,
      focusFlashTimer: null,
      lastBackgroundPrPollError: null,
      versionText: `Craig v${configService.version.getCurrent()}`,
      updateText: null,
      inspectionRefreshSequence: 0,
      pendingClear: true,
      inputCaptureMode: null,
      runtimeState,
      persistQueue: Promise.resolve(),
      taskMutationQueue: Promise.resolve(),
      bootHydrationReady: Promise.resolve(),
      paths,
      workspaceRoot,
      uiStateFile: options.uiStateFile,
      activeTerminal,
      ptyRuntime: initialPtyRuntime,
      resolve,
      render: () => undefined,
      exit: (code: number) => resolve(code),
    };
    const heartbeat = new Heartbeat({
      onError: (jobId, error) => logBackgroundError(`heartbeat job "${jobId}"`, error, buildActionContext(ctx)),
    });

    handlePtyUpdate = (invalidation) => {
      if (ctx.state.mode !== "main") {
        return;
      }

      pendingPtyInvalidation = mergePtyInvalidations(pendingPtyInvalidation, invalidation);

      if (!ctx.ptyRenderTimer) {
        ctx.ptyRenderTimer = setTimeout(() => {
          ctx.ptyRenderTimer = null;
          const pendingInvalidation = pendingPtyInvalidation;
          pendingPtyInvalidation = null;
          if (ctx.state.mode === "main") {
            const shell = withTerminalView(ctx, ctx.state.shell);
            ctx.state = { mode: "main", shell };
            const incrementalCenterEnabled = configService.previews.isEnabled(ctx.config, "incrementalCenterPane");
            if (!incrementalCenterEnabled || !lastShellData || !lastRenderedCenter) {
              ctx.render();
              return;
            }

            const viewport = getViewport(activeTerminal.width, activeTerminal.height);
            const nextShellData = { ...lastShellData, terminal: shell.terminal };
            const centerUpdate = buildCenterPaneUpdate(
              viewport,
              nextShellData,
              lastRenderedCenter,
              shell.centerZoomed,
              pendingInvalidation?.kind === "rows" ? pendingInvalidation.rowIndices : null,
            );
            if (!centerUpdate) {
              ctx.render();
              return;
            }

            if (centerUpdate.output.length > 0) {
              activeTerminal.noFormat(centerUpdate.output);
            }
            lastShellData = nextShellData;
            lastRenderedCenter = centerUpdate.region;
            activeTerminal.hideCursor(true);
          }
        }, configService.previews.isEnabled(ctx.config, "incrementalCenterPane") ? 0 : 50);
      }
    };

    ctx.render = () => {
      syncInputCapture(ctx);
      const renderState = ctx.state;
      ctx.ptyRuntime.setViewedTab?.(
        renderState.mode === "main" ? resolveTerminalViewTabId(ctx, renderState.shell) : null,
      );
      const viewport = getViewport(activeTerminal.width, activeTerminal.height);
      let frame: string;

      if (renderState.mode === "main") {
        const mainShellData = buildShellData(syncShell(ctx, renderState.shell), ctx.model);
        const mainPresentation = renderMainShellPresentation(viewport, mainShellData, {
            centerOnly: renderState.shell.centerZoomed,
            focusFlashActive: ctx.focusFlashUntil !== null && Date.now() < ctx.focusFlashUntil,
        });
        frame = mainPresentation.frame;
        lastShellData = mainShellData;
        lastRenderedCenter = mainPresentation.center;
      } else {
        frame = renderState.variant === "boot"
          ? renderBootOverlayFrame(viewport, {
              menuIndex: renderState.menuIndex,
              optionsMessage: renderState.optionsMessage,
              versionText: ctx.versionText,
              updateText: ctx.updateText,
            })
          : renderState.variant === "pause"
            ? renderPauseOverlayFrame(viewport, {
                menuIndex: renderState.menuIndex,
                optionsMessage: renderState.optionsMessage,
                versionText: ctx.versionText,
                updateText: ctx.updateText,
              })
            : renderState.variant === "options"
              ? renderOptionsOverlayFrame(viewport, {
                  menuIndex: renderState.menuIndex,
                  optionsMenuItems: OPTIONS_MENU_ITEMS,
                })
              : renderState.variant === "runners"
                ? renderOptionsOverlayFrame(viewport, {
                    menuIndex: getRunnerOptionsState(renderState).menuIndex,
                    optionsMenuItems: buildRunnersSubmenuItems(ctx.config, getRunnerOptionsState(renderState)),
                    optionsMessage: getRunnersSubmenuMessage(getRunnerOptionsState(renderState)),
                    optionsSubtitle: "Runners",
                  })
                : renderState.variant === "previews"
                  ? renderOptionsOverlayFrame(viewport, {
                      menuIndex: getPreviewOptionsState(renderState).menuIndex,
                      optionsMenuItems: buildPreviewSubmenuItems(ctx.config),
                      optionsMessage: getPreviewSubmenuMessage(getPreviewOptionsState(renderState)),
                      optionsSubtitle: "Feature Previews - Experimental",
                    })
                : renderState.variant === "error-log"
                  ? renderErrorLogOverlayFrame(viewport, {
                      errorLogPath: renderState.errorLog?.path ?? paths.errorLogFile,
                      errorLogLines: renderState.errorLog?.lines ?? [],
                    })
                  : renderHelpOverlayFrame(viewport);
        lastShellData = null;
        lastRenderedCenter = null;
      }

      if (ctx.pendingClear) {
        activeTerminal.moveTo(1, 1);
        activeTerminal.eraseDisplayBelow();
        ctx.pendingClear = false;
        lastRenderedFrame = null;
      }
      activeTerminal.noFormat(positionFrameRows(frame, lastRenderedFrame));
      lastRenderedFrame = frame;
      activeTerminal.hideCursor(true);
    };

    const boundOnKey = (name: unknown) => onKey(ctx, name);
    const boundOnUnknown = (input: unknown) => onUnknown(ctx, input);
    const boundOnMouse = (name: unknown) => onMouse(ctx, name);

    const cleanup = () => {
      process.stdout.off("resize", handleResize);
      process.off("SIGCONT", handleResume);
      activeTerminal.removeListener("key", boundOnKey);
      activeTerminal.removeListener("unknown", boundOnUnknown);
      activeTerminal.removeListener("mouse", boundOnMouse);
      if (ctx.scrollRenderTimer) { clearTimeout(ctx.scrollRenderTimer); ctx.scrollRenderTimer = null; }
      if (ctx.inspectionScrollRenderTimer) { clearTimeout(ctx.inspectionScrollRenderTimer); ctx.inspectionScrollRenderTimer = null; }
      if (ctx.leftNavInspectionTimer) { clearTimeout(ctx.leftNavInspectionTimer); ctx.leftNavInspectionTimer = null; }
      if (ctx.pendingTerminalKeySequence) { clearTimeout(ctx.pendingTerminalKeySequence.timer); ctx.pendingTerminalKeySequence = null; }
      if (ctx.ptyRenderTimer) { clearTimeout(ctx.ptyRenderTimer); ctx.ptyRenderTimer = null; }
      if (ctx.footerToastTimer) { clearTimeout(ctx.footerToastTimer); ctx.footerToastTimer = null; }
      if (ctx.focusFlashTimer) { clearTimeout(ctx.focusFlashTimer); ctx.focusFlashTimer = null; }
      heartbeat.stop();
      ctx.ptyRuntime.disposeAll();
      activeTerminal.grabInput(false);
      activeTerminal.hideCursor(false);
      activeTerminal.fullscreen(false);
    };

    ctx.exit = (code: number) => {
      cleanup();
      resolve(code);
    };

    const handleResize = () => {
      restoreTerminalScreen(ctx);
      if (ctx.state.mode === "main" && ctx.state.shell.inputMode === "terminal") {
        ctx.ptyRuntime.resize(getPtySize(getViewport(activeTerminal.width, activeTerminal.height)));
        ctx.state = { mode: "main", shell: withTerminalView(ctx, ctx.state.shell) };
      }
      ctx.render();
    };

    const handleResume = () => {
      restoreTerminalScreen(ctx);
      if (ctx.state.mode === "main" && ctx.state.shell.inputMode === "terminal") {
        ctx.ptyRuntime.resize(getPtySize(getViewport(activeTerminal.width, activeTerminal.height)));
        ctx.state = { mode: "main", shell: withTerminalView(ctx, ctx.state.shell) };
      }
      ctx.render();
    };

    process.stdout.on("resize", handleResize);
    process.on("SIGCONT", handleResume);
    activeTerminal.grabInput(true);
    ctx.inputCaptureMode = "control";
    activeTerminal.hideCursor(true);
    activeTerminal.fullscreen(true);
    activeTerminal.on("key", boundOnKey);
    activeTerminal.on("unknown", boundOnUnknown);
    activeTerminal.on("mouse", boundOnMouse);
    heartbeat.register({
      id: "github.pull-requests",
      intervalMs: (ctx.config.github?.watchIntervalSeconds ?? 5) * 1_000,
      run: (signal) => pollPullRequests(ctx, signal),
    });
    heartbeat.start();
    void configService.version.checkForUpdate().then((result) => {
      if (result.updateAvailable && result.latest) {
        ctx.updateText = `Update available: v${result.latest}`;
        ctx.render();
      }
    });
    ctx.bootHydrationReady = hydrateOpenPtyTabs(ctx).catch(() => undefined);
    ctx.render();
  });
}
