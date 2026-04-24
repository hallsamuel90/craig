import { listRegisteredRepos } from "../services/repo-registry.js";
import { listWorkspaces } from "../services/workspace-registry.js";
import { renderWorkspaceOverlay } from "./render-layout.js";
import {
  canUseInteractiveTerminal,
  createTerminalSession,
  type TerminalEvent,
  type TerminalSession,
} from "./terminal-io.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import type { CommandContext } from "../commands/command-router.js";
import type { OverlayMode } from "../types/workspace.js";

interface InteractiveAppOptions {
  terminal?: TerminalSession;
}

interface InteractiveState {
  overlayMode: OverlayMode;
  selectedMenuIndex: number;
  messageLines: string[];
}

const MENU_ITEMS = ["Start", "Archives", "Options", "Exit"] as const;

export async function startInteractiveApp(context: CommandContext, options?: InteractiveAppOptions): Promise<number> {
  if (!options?.terminal && !canUseInteractiveTerminal()) {
    throw new Error("Interactive terminal surface unavailable.");
  }

  const terminal = options?.terminal ?? createTerminalSession();
  const uiState = (await readUiState({ uiStateFile: context.paths.uiStateFile })) ?? getDefaultUiState();
  const state: InteractiveState = {
    overlayMode: uiState.overlayMode,
    selectedMenuIndex: uiState.overlayMode === "archives" ? 1 : 0,
    messageLines: [],
  };

  try {
    await persistUiState(context, state);
    terminal.render(await renderFrame(context, state, terminal));

    while (true) {
      const event = await terminal.readEvent();

      if (event.kind === "resize") {
        terminal.render(await renderFrame(context, state, terminal));
        continue;
      }

      const exitCode = await handleEvent(context, state, event);

      if (exitCode !== null) {
        return exitCode;
      }

      terminal.render(await renderFrame(context, state, terminal));
    }
  } finally {
    terminal.dispose();
  }
}

async function handleEvent(
  context: CommandContext,
  state: InteractiveState,
  event: Extract<TerminalEvent, { kind: "keypress" }>,
): Promise<number | null> {
  if (event.ctrl && event.name === "c") {
    return 0;
  }

  if (event.name === "up" || event.text === "k") {
    state.selectedMenuIndex = Math.max(0, state.selectedMenuIndex - 1);
  } else if (event.name === "down" || event.text === "j") {
    state.selectedMenuIndex = Math.min(MENU_ITEMS.length - 1, state.selectedMenuIndex + 1);
  } else if (event.name === "escape") {
    state.overlayMode = "start";
    state.selectedMenuIndex = 0;
  } else if (event.name === "return") {
    const selection = MENU_ITEMS[state.selectedMenuIndex];

    switch (selection) {
      case "Start":
        state.overlayMode = "start";
        state.messageLines = ["Workspace initialized.", "Use 'craig repo add <path>' to register repositories."];
        break;
      case "Archives":
        state.overlayMode = "archives";
        state.messageLines = ["Browsing archived workspaces."];
        break;
      case "Options":
        state.messageLines = ["Options are deferred in RFC 1.1."];
        break;
      case "Exit":
        return 0;
      default:
        break;
    }
  }

  await persistUiState(context, state);
  return null;
}

async function renderFrame(
  context: CommandContext,
  state: InteractiveState,
  terminal: TerminalSession,
): Promise<string> {
  const [reposResult, activeWorkspaces, archivedWorkspaces] = await Promise.all([
    listRegisteredRepos(context.paths),
    listWorkspaces(context.paths, { archived: false }),
    listWorkspaces(context.paths, { archived: true }),
  ]);

  return renderWorkspaceOverlay({
    workspaceRoot: context.paths.workspaceRoot,
    repos: reposResult.repos,
    workspaces: activeWorkspaces.workspaces,
    archivedWorkspaces: archivedWorkspaces.workspaces,
    overlayMode: state.overlayMode,
    selectedMenuIndex: state.selectedMenuIndex,
    messageLines: state.messageLines,
    terminalSize: terminal.getSize(),
  });
}

async function persistUiState(context: CommandContext, state: InteractiveState): Promise<void> {
  const current = (await readUiState({ uiStateFile: context.paths.uiStateFile })) ?? getDefaultUiState();

  await writeUiState(
    { uiStateFile: context.paths.uiStateFile },
    {
      ...current,
      activeSurface: "overlay",
      overlayMode: state.overlayMode,
    },
  );
}
