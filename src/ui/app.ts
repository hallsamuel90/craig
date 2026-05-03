import { createRequire } from "node:module";
import type * as TerminalKitModule from "terminal-kit";

import { getMockShellData } from "./mock-data.js";
import { getViewport } from "./layout.js";
import { renderBootOverlayFrame, renderMainShellFrame, renderPauseOverlayFrame } from "./render.js";

type OverlayVariant = "boot" | "pause";
type ShellState =
  | { mode: "overlay"; variant: OverlayVariant; menuIndex: number; optionsMessage: string | null }
  | { mode: "main" };

const require = createRequire(import.meta.url);
const terminalKit = require("terminal-kit") as typeof TerminalKitModule;
const terminal = terminalKit.terminal;

export async function startTerminalApp(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Craig terminal shell requires a TTY.");
  }

  return new Promise<number>((resolve) => {
    let state: ShellState = { mode: "overlay", variant: "boot", menuIndex: 0, optionsMessage: null };

    const render = () => {
      const viewport = getViewport(terminal.width, terminal.height);
      const frame =
        state.mode === "main"
          ? renderMainShellFrame(viewport, getMockShellData())
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
        if (key === "q" || key === "Q") {
          exit(0);
          return;
        }

        if (key === "ESCAPE") {
          state = { mode: "overlay", variant: "pause", menuIndex: 0, optionsMessage: null };
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
          state = { mode: "main" };
          render();
        }
        return;
      }

      if (key !== "ENTER" && key !== "KP_ENTER") {
        return;
      }

      if (state.menuIndex === 0) {
        state = { mode: "main" };
        render();
        return;
      }

      if (state.menuIndex === 1) {
        state = {
          ...state,
          optionsMessage: "Options are not available in phase 1.1.",
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
