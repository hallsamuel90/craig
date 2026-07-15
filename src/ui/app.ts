import { createRequire } from "node:module";
import type * as TerminalKitModule from "terminal-kit";

import { readUiState } from "../state/ui-state-store.js";
import { configService } from "../domain/config/index.js";
import { getCraigPaths } from "../state/craig-paths.js";
import { loadWorkspaceShellModel } from "./shell/loader.js";
import { resolvePtySessionSpec, getPtySize } from "./pty/session.js";
import { positionFrameRows } from "./input/keyboard.js";
import type { PtyRuntimeOptions } from "./pty/runtime.js";
import { createDaemonPtyRuntime } from "./pty/daemon.js";
import {
  renderBootOverlayFrame,
  renderErrorLogOverlayFrame,
  renderHelpOverlayFrame,
  renderMainShellFrame,
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
import { buildShellData } from "./shell/data.js";
import type { AppContext, AppState, TerminalRuntime, PtyRuntimePort, TerminalEventListener } from "./app-context.js";
import { resolveTerminalViewTabId, syncShell, withTerminalView, restoreTerminalScreen } from "./shell/sync.js";
import { hydrateOpenPtyTabs, syncInputCapture } from "./pty/manager.js";
import { pollPullRequests } from "./workspace/pr-polling.js";
import { onKey, onUnknown, onMouse } from "./input/dispatch.js";

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
  let handlePtyUpdate: () => void = () => undefined;
  const ptyOptions: PtyRuntimeOptions = {
    workspaceRoot,
    onUpdate: () => handlePtyUpdate(),
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
      prPollTimer: null,
      prPollInFlight: false,
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

    handlePtyUpdate = () => {
      if (ctx.state.mode !== "main") {
        return;
      }

      if (!ctx.ptyRenderTimer) {
        ctx.ptyRenderTimer = setTimeout(() => {
          ctx.ptyRenderTimer = null;
          if (ctx.state.mode === "main") {
            ctx.state = { mode: "main", shell: withTerminalView(ctx, ctx.state.shell) };
            ctx.render();
          }
        }, 50);
      }
    };

    ctx.render = () => {
      syncInputCapture(ctx);
      ctx.ptyRuntime.setViewedTab?.(
        ctx.state.mode === "main" ? resolveTerminalViewTabId(ctx, ctx.state.shell) : null,
      );
      const viewport = getViewport(activeTerminal.width, activeTerminal.height);
      const frame =
        ctx.state.mode === "main"
          ? renderMainShellFrame(
              viewport,
              buildShellData(syncShell(ctx, ctx.state.shell), ctx.model),
              {
                centerOnly: ctx.state.shell.centerZoomed,
                focusFlashActive: ctx.focusFlashUntil !== null && Date.now() < ctx.focusFlashUntil,
              },
            )
          : ctx.state.variant === "boot"
            ? renderBootOverlayFrame(viewport, {
                menuIndex: ctx.state.menuIndex,
                optionsMessage: ctx.state.optionsMessage,
                versionText: ctx.versionText,
                updateText: ctx.updateText,
              })
            : ctx.state.variant === "pause"
              ? renderPauseOverlayFrame(viewport, {
                  menuIndex: ctx.state.menuIndex,
                  optionsMessage: ctx.state.optionsMessage,
                  versionText: ctx.versionText,
                  updateText: ctx.updateText,
                })
              : ctx.state.variant === "options"
                ? renderOptionsOverlayFrame(viewport, {
                    menuIndex: ctx.state.menuIndex,
                    optionsMenuItems: OPTIONS_MENU_ITEMS,
                  })
                : ctx.state.variant === "runners"
                  ? renderOptionsOverlayFrame(viewport, {
                      menuIndex: getRunnerOptionsState(ctx.state).menuIndex,
                      optionsMenuItems: buildRunnersSubmenuItems(ctx.config, getRunnerOptionsState(ctx.state)),
                      optionsMessage: getRunnersSubmenuMessage(getRunnerOptionsState(ctx.state)),
                      optionsSubtitle: "Runners",
                    })
                  : ctx.state.variant === "previews"
                    ? renderOptionsOverlayFrame(viewport, {
                        menuIndex: getPreviewOptionsState(ctx.state).menuIndex,
                        optionsMenuItems: buildPreviewSubmenuItems(ctx.config),
                        optionsMessage: getPreviewSubmenuMessage(getPreviewOptionsState(ctx.state)),
                        optionsSubtitle: "Feature Previews - Experimental",
                      })
                  : ctx.state.variant === "error-log"
                    ? renderErrorLogOverlayFrame(viewport, {
                        errorLogPath: ctx.state.errorLog?.path ?? paths.errorLogFile,
                        errorLogLines: ctx.state.errorLog?.lines ?? [],
                      })
                    : renderHelpOverlayFrame(viewport);

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
      if (ctx.prPollTimer) { clearInterval(ctx.prPollTimer); ctx.prPollTimer = null; }
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
    ctx.prPollTimer = setInterval(() => {
      void pollPullRequests(ctx);
    }, (ctx.config.github?.watchIntervalSeconds ?? 5) * 1000);
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
