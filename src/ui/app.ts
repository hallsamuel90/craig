import { createRequire } from "node:module";
import type * as TerminalKitModule from "terminal-kit";

import { readUiState, writeUiState } from "../state/ui-state-store.js";
import { getMockShellData } from "./mock-data.js";
import { getViewport, SHELL_LAYOUT, type Viewport } from "./layout.js";
import { PtyRuntime, type PtySize } from "./pty-runtime.js";
import { renderBootOverlayFrame, renderMainShellFrame, renderPauseOverlayFrame } from "./render.js";
import {
  createInitialShellState,
  isEnterKey,
  markTerminalAttachFailed,
  reduceMainKey,
  toPersistedUiState,
  updateTerminalViewState,
  type ControlShellState,
} from "./state.js";

type OverlayVariant = "boot" | "pause";
type AppState =
  | { mode: "overlay"; variant: OverlayVariant; menuIndex: number; optionsMessage: string | null; shell: ControlShellState }
  | { mode: "main"; shell: ControlShellState };

/* eslint-disable no-unused-vars */
type KeyListener = (...args: [unknown]) => void;

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
  grabInput(...args: [boolean]): void;
  hideCursor(...args: [boolean?]): void;
  fullscreen(...args: [boolean]): void;
  on(...args: ["key" | "unknown", KeyListener]): void;
  removeListener(...args: ["key" | "unknown", KeyListener]): void;
}

export interface PtyRuntimePort {
  ensureSession(...args: [ControlShellState["selectedTaskId"], PtySize]): ControlShellState["terminal"];
  write(...args: [string]): void;
  writeKey(...args: [string]): void;
  resize(...args: [PtySize]): void;
  detach(): void;
  disposeAll(): void;
  getViewState(...args: [ControlShellState["selectedTaskId"]]): ControlShellState["terminal"];
}
/* eslint-enable no-unused-vars */

export async function startTerminalApp(options: TerminalAppOptions = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Craig terminal shell requires a TTY.");
  }

  let runtimeState = options.uiStateFile ? await readUiState({ uiStateFile: options.uiStateFile }) : null;
  let persistQueue = Promise.resolve();
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
      shell: createInitialShellState(runtimeState),
    };
    const ptyRuntime: PtyRuntimePort = options.ptyRuntime ?? new PtyRuntime({
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
      onUpdate: () => {
        if (state.mode === "main") {
          state = { mode: "main", shell: withTerminalView(state.shell) };
          render();
        }
      },
    });

    const withTerminalView = (shell: ControlShellState): ControlShellState =>
      updateTerminalViewState(shell, ptyRuntime.getViewState(shell.selectedTaskId));

    const render = () => {
      const viewport = getViewport(activeTerminal.width, activeTerminal.height);
      const frame =
        state.mode === "main"
          ? renderMainShellFrame(viewport, getMockShellData(withTerminalView(state.shell)))
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
      activeTerminal.eraseDisplayBelow();
      activeTerminal.noFormat(frame);
    };

    const cleanup = () => {
      process.stdout.off("resize", handleResize);
      activeTerminal.removeListener("key", onKey);
      activeTerminal.removeListener("unknown", onUnknown);
      ptyRuntime.disposeAll();
      activeTerminal.grabInput(false);
      activeTerminal.hideCursor(false);
      activeTerminal.fullscreen(false);
    };

    const exit = (code: number) => {
      cleanup();
      resolve(code);
    };

    const onKey = (name: unknown) => {
      const key = typeof name === "string" ? name : "";

      if (state.mode === "main") {
        const result = reduceMainKey(state.shell, key);

        if (result.exit) {
          exit(0);
          return;
        }

        if (result.detachTerminal) {
          ptyRuntime.detach();
          state = { mode: "main", shell: withTerminalView(result.state) };
          render();
          return;
        }

        if (state.shell.inputMode === "terminal") {
          ptyRuntime.writeKey(key);
          return;
        }

        if (key === "CTRL_C") {
          exit(0);
          return;
        }

        if (result.pause) {
          state = { mode: "overlay", variant: "pause", menuIndex: 0, optionsMessage: null, shell: result.state };
          render();
          return;
        }

        if (result.attachTerminal) {
          try {
            const view = ptyRuntime.ensureSession(result.state.selectedTaskId, getPtySize(getViewport(activeTerminal.width, activeTerminal.height)));
            state = { mode: "main", shell: updateTerminalViewState(result.state, view) };
            persistShellState(state.shell);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to start PTY.";
            state = { mode: "main", shell: markTerminalAttachFailed(result.state, message) };
            persistShellState(state.shell);
          }
          render();
          return;
        }

        if (result.changed) {
          state = { mode: "main", shell: result.state };
          persistShellState(result.state);
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
          state = { mode: "main", shell: state.shell };
          render();
        }
        return;
      }

      if (!isEnterKey(key)) {
        return;
      }

      if (state.menuIndex === 0) {
        state = { mode: "main", shell: state.shell };
        render();
        return;
      }

      if (state.menuIndex === 1) {
        state = {
          ...state,
          optionsMessage: "Options are not available in phase 1.2.",
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
        state = { mode: "main", shell: withTerminalView({ ...state.shell, inputMode: "control", actionMessage: null }) };
        render();
        return;
      }

      ptyRuntime.write(raw);
    };

    const handleResize = () => {
      if (state.mode === "main" && state.shell.inputMode === "terminal") {
        ptyRuntime.resize(getPtySize(getViewport(activeTerminal.width, activeTerminal.height)));
      }

      render();
    };

    activeTerminal.fullscreen(true);
    activeTerminal.hideCursor();
    activeTerminal.grabInput(true);
    activeTerminal.on("key", onKey);
    activeTerminal.on("unknown", onUnknown);
    process.stdout.on("resize", handleResize);
    render();
  });
}

function inputToString(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (Buffer.isBuffer(input)) {
    return input.toString();
  }

  return "";
}

function getPtySize(viewport: Viewport): PtySize {
  const centerWidth = viewport.width - SHELL_LAYOUT.leftWidth - SHELL_LAYOUT.rightWidth - SHELL_LAYOUT.dividerWidth;
  const bodyHeight = viewport.height - SHELL_LAYOUT.topRailHeight;

  return {
    columns: Math.max(10, centerWidth - 2),
    rows: Math.max(5, bodyHeight - 5),
  };
}
