import { createRequire } from "node:module";
import type * as TerminalKitModule from "terminal-kit";

import { readUiState, writeUiState } from "../state/ui-state-store.js";
import { getMockShellData } from "./mock-data.js";
import { getViewport } from "./layout.js";
import { renderBootOverlayFrame, renderMainShellFrame, renderPauseOverlayFrame } from "./render.js";
import { createInitialShellState, reduceMainKey, toPersistedUiState, type ControlShellState } from "./state.js";

type OverlayVariant = "boot" | "pause";
type AppState =
  | { mode: "overlay"; variant: OverlayVariant; menuIndex: number; optionsMessage: string | null; shell: ControlShellState }
  | { mode: "main"; shell: ControlShellState };

export interface TerminalAppOptions {
  uiStateFile?: string;
}

const require = createRequire(import.meta.url);
const terminalKit = require("terminal-kit") as typeof TerminalKitModule;
const terminal = terminalKit.terminal;

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
    let state: AppState = {
      mode: "overlay",
      variant: "boot",
      menuIndex: 0,
      optionsMessage: null,
      shell: createInitialShellState(runtimeState),
    };

    const render = () => {
      const viewport = getViewport(terminal.width, terminal.height);
      const frame =
        state.mode === "main"
          ? renderMainShellFrame(viewport, getMockShellData(state.shell))
          : state.variant === "boot"
            ? renderBootOverlayFrame(viewport, {
                menuIndex: state.menuIndex,
                optionsMessage: state.optionsMessage,
              })
            : renderPauseOverlayFrame(viewport, {
                menuIndex: state.menuIndex,
                optionsMessage: state.optionsMessage,
              });

      terminal.moveTo(1, 1);
      terminal.eraseDisplayBelow();
      terminal.noFormat(frame);
    };

    const cleanup = () => {
      process.stdout.off("resize", render);
      terminal.removeListener("key", onKey);
      terminal.grabInput(false);
      terminal.hideCursor(false);
      terminal.fullscreen(false);
    };

    const exit = (code: number) => {
      cleanup();
      resolve(code);
    };

    const onKey = (name: unknown) => {
      const key = typeof name === "string" ? name : "";

      if (key === "CTRL_C") {
        exit(0);
        return;
      }

      if (state.mode === "main") {
        const result = reduceMainKey(state.shell, key);

        if (result.exit) {
          exit(0);
          return;
        }

        if (result.pause) {
          state = { mode: "overlay", variant: "pause", menuIndex: 0, optionsMessage: null, shell: result.state };
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
        if (key === "ESCAPE" || key === "ENTER" || key === "KP_ENTER") {
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

      if (key !== "ENTER" && key !== "KP_ENTER") {
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

    terminal.fullscreen(true);
    terminal.hideCursor();
    terminal.grabInput(true);
    terminal.on("key", onKey);
    process.stdout.on("resize", render);
    render();
  });
}
