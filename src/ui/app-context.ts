import type { CraigConfig, RunnerType } from "../domain/config/index.js";
import type { CraigUiRuntime } from "../state/ui-runtime.js";
import type { CraigPaths } from "../state/craig-paths.js";
import type { CraigErrorLogSnapshot } from "../domain/error/index.js";
import type { WorkspaceShellModel } from "./shell/data.js";
import type { PreviewOptionsState, RunnerOptionsState } from "./options.js";
import type { PtySize } from "./pty/runtime.js";
import type { ControlShellState } from "./state.js";
import type { PtyActivitySnapshot } from "./agent-activity.js";

type OverlayVariant = "boot" | "pause" | "help" | "options" | "runners" | "previews" | "error-log";

export type AppState =
  | {
      mode: "overlay";
      variant: OverlayVariant;
      menuIndex: number;
      optionsMessage: string | null;
      shell: ControlShellState;
      parentVariant?: "boot" | "pause";
      viaOptions?: boolean;
      runnerOptions?: RunnerOptionsState;
      previewOptions?: PreviewOptionsState;
      errorLog?: CraigErrorLogSnapshot;
    }
  | { mode: "main"; shell: ControlShellState };

/* eslint-disable no-unused-vars */
export type TerminalEventListener = (...args: unknown[]) => void;

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
  ensureSession(...args: [string, string, PtySize]): ControlShellState["terminal"] | Promise<ControlShellState["terminal"]>;
  hydrateSessions?(...args: [string[]]): void | Promise<void>;
  pruneStale?(...args: [string[]]): void | Promise<void>;
  write(...args: [string]): void;
  writeKey(...args: [string]): void;
  scrollViewport(...args: [number]): void;
  resize(...args: [PtySize]): void;
  detach(): void;
  disposeSession(...args: [string]): void;
  disposeAll(): void;
  getViewState(...args: [string | null]): ControlShellState["terminal"];
  getActivitySnapshots?(): PtyActivitySnapshot[];
  setViewedTab?(...args: [string | null]): void;
  setViewUpdateMode?(...args: ["snapshot" | "incremental"]): void;
}
/* eslint-enable no-unused-vars */

export type AppContext = {
  // Mutable state — mutated in place: ctx.state = ..., ctx.model = ..., etc.
  state: AppState;
  model: WorkspaceShellModel;
  config: CraigConfig;
  enabledRunnerIds: RunnerType[];
  creatingTask: boolean;
  suppressTerminalEnterOnAttach: boolean;
  lastTerminalKey: { key: string; at: number } | null;
  pendingScrollLines: number;
  pendingInspectionScrollLines: number;
  leftNavInspectionTimer: ReturnType<typeof setTimeout> | null;
  pendingLeftNavInspectionShell: ControlShellState | null;
  pendingTerminalKeySequence: { raw: string; timer: ReturnType<typeof setTimeout> } | null;
  scrollRenderTimer: ReturnType<typeof setTimeout> | null;
  inspectionScrollRenderTimer: ReturnType<typeof setTimeout> | null;
  ptyRenderTimer: ReturnType<typeof setTimeout> | null;
  footerToastTimer: ReturnType<typeof setTimeout> | null;
  focusFlashUntil: number | null;
  focusFlashTimer: ReturnType<typeof setTimeout> | null;
  lastBackgroundPrPollError: string | null;
  versionText: string | null;
  updateText: string | null;
  inspectionRefreshSequence: number;
  pendingClear: boolean;
  inputCaptureMode: "control" | "terminal" | null;
  runtimeState: CraigUiRuntime | null;
  persistQueue: Promise<void>;
  taskMutationQueue: Promise<void>;
  bootHydrationReady: Promise<void>;
  // Immutable session fixtures
  paths: CraigPaths;
  workspaceRoot: string;
  uiStateFile: string | undefined;
  activeTerminal: TerminalRuntime;
  ptyRuntime: PtyRuntimePort;
  /* eslint-disable no-unused-vars */
  resolve: (_: number) => void;
  render: () => void;
  exit: (_: number) => void;
  /* eslint-enable no-unused-vars */
};
