import { configService, RUNNER_IDS } from "../domain/config/index.js";
import type { CraigConfig, RunnerType } from "../domain/config/index.js";

export interface RunnerOptionsPathEdit {
  runner: RunnerType;
  value: string;
}

export interface RunnerOptionsState {
  menuIndex: number;
  message: string | null;
  pathEdit?: RunnerOptionsPathEdit;
}

export type RunnerOptionsKeyResult =
  | { kind: "back"; state: RunnerOptionsState }
  | { kind: "noop"; state: RunnerOptionsState }
  | { kind: "render"; state: RunnerOptionsState }
  | { kind: "save"; config: CraigConfig; state: RunnerOptionsState };

export type OptionsMenuKeyResult =
  | { kind: "back" }
  | { kind: "runners" }
  | { kind: "error-log" }
  | { kind: "help" }
  | { kind: "noop"; menuIndex: number }
  | { kind: "render"; menuIndex: number };

export const OPTIONS_MENU_ITEMS = ["Runners", "Error Log", "Help"];

export function buildRunnersSubmenuItems(config: CraigConfig, state: RunnerOptionsState): string[] {
  return RUNNER_IDS.map((runner) => {
    const profile = configService.runners.getProfile(runner);
    const enabled = config.runners?.[runner]?.enabled !== false;
    const configuredPath = config.runners?.[runner]?.path?.trim();
    const pathDisplay = state.pathEdit?.runner === runner
      ? `${state.pathEdit.value}_`
      : configuredPath && configuredPath.length > 0
        ? configuredPath
        : `default (${profile.executable})`;

    return `${profile.displayName}  ${enabled ? "enabled" : "disabled"}  ${pathDisplay}`;
  });
}

export function getRunnersSubmenuMessage(state: RunnerOptionsState): string | null {
  if (state.message) {
    return state.message;
  }

  if (state.pathEdit) {
    return "Type an executable path. Enter saves. Empty resets to default. Esc cancels.";
  }

  return "Enter toggles. E edits the executable path.";
}

export function reduceOptionsMenuKey(menuIndex: number, key: string): OptionsMenuKeyResult {
  if (key === "UP" || key === "k") {
    return { kind: "render", menuIndex: Math.max(0, menuIndex - 1) };
  }

  if (key === "DOWN" || key === "j") {
    return { kind: "render", menuIndex: Math.min(OPTIONS_MENU_ITEMS.length - 1, menuIndex + 1) };
  }

  if (key === "ESCAPE") {
    return { kind: "back" };
  }

  if (!isEnterKey(key)) {
    return { kind: "noop", menuIndex };
  }

  if (menuIndex === 0) {
    return { kind: "runners" };
  }

  if (menuIndex === 1) {
    return { kind: "error-log" };
  }

  return { kind: "help" };
}

export function reduceRunnerOptionsKey(
  state: RunnerOptionsState,
  config: CraigConfig,
  key: string,
  enabledRunnerIds: readonly RunnerType[],
): RunnerOptionsKeyResult {
  if (state.pathEdit) {
    return reducePathEditKey({ ...state, pathEdit: state.pathEdit }, config, key);
  }

  const menuItemCount = buildRunnersSubmenuItems(config, state).length;
  if (key === "UP" || key === "k") {
    return {
      kind: "render",
      state: {
        ...state,
        menuIndex: Math.max(0, state.menuIndex - 1),
        message: null,
      },
    };
  }

  if (key === "DOWN" || key === "j") {
    return {
      kind: "render",
      state: {
        ...state,
        menuIndex: Math.min(menuItemCount - 1, state.menuIndex + 1),
        message: null,
      },
    };
  }

  if (key === "ESCAPE") {
    return { kind: "back", state };
  }

  if (key === "e") {
    const runner = RUNNER_IDS[state.menuIndex] ?? "codex";
    return {
      kind: "render",
      state: {
        ...state,
        message: null,
        pathEdit: {
          runner,
          value: config.runners?.[runner]?.path ?? "",
        },
      },
    };
  }

  if (!isEnterKey(key)) {
    return { kind: "noop", state };
  }

  const runner = RUNNER_IDS[state.menuIndex] ?? "codex";
  const enabled = config.runners?.[runner]?.enabled !== false;
  if (enabled && enabledRunnerIds.length <= 1) {
    return {
      kind: "render",
      state: {
        ...state,
        message: "At least one runner must stay enabled.",
      },
    };
  }

  return {
    kind: "save",
    config: updateRunnerEnabled(config, runner, !enabled),
    state: {
      ...state,
      message: `${configService.runners.getProfile(runner).displayName} ${enabled ? "disabled" : "enabled"}.`,
    },
  };
}

function reducePathEditKey(
  state: RunnerOptionsState & { pathEdit: RunnerOptionsPathEdit },
  config: CraigConfig,
  key: string,
): RunnerOptionsKeyResult {
  if (key === "ESCAPE") {
    return {
      kind: "render",
      state: clearPathEdit({
        ...state,
        message: null,
      }),
    };
  }

  if (key === "BACKSPACE") {
    return {
      kind: "render",
      state: {
        ...state,
        pathEdit: {
          ...state.pathEdit,
          value: state.pathEdit.value.slice(0, -1),
        },
      },
    };
  }

  if (isEnterKey(key)) {
    const runner = state.pathEdit.runner;
    const value = state.pathEdit.value.trim();
    return {
      kind: "save",
      config: updateRunnerPath(config, runner, value.length > 0 ? value : null),
      state: clearPathEdit({
        ...state,
        message: value.length > 0
          ? `${configService.runners.getProfile(runner).displayName} executable saved.`
          : `${configService.runners.getProfile(runner).displayName} executable reset to default.`,
      }),
    };
  }

  if (isPrintableKey(key)) {
    return {
      kind: "render",
      state: {
        ...state,
        pathEdit: {
          ...state.pathEdit,
          value: `${state.pathEdit.value}${key}`,
        },
      },
    };
  }

  return { kind: "noop", state };
}

function updateRunnerEnabled(config: CraigConfig, runner: RunnerType, enabled: boolean): CraigConfig {
  return {
    ...config,
    runners: {
      ...(config.runners ?? {}),
      [runner]: {
        ...(config.runners?.[runner] ?? {}),
        enabled,
      },
    },
  };
}

function updateRunnerPath(config: CraigConfig, runner: RunnerType, executablePath: string | null): CraigConfig {
  const runnerConfig = {
    ...(config.runners?.[runner] ?? {}),
    ...(executablePath ? { path: executablePath } : {}),
  };

  if (!executablePath) {
    delete runnerConfig.path;
  }

  return {
    ...config,
    runners: {
      ...(config.runners ?? {}),
      [runner]: runnerConfig,
    },
  };
}

function clearPathEdit(state: RunnerOptionsState): RunnerOptionsState {
  const next = { ...state };
  delete next.pathEdit;
  return next;
}

function isEnterKey(key: string): boolean {
  return key === "ENTER" || key === "RETURN" || key === "CTRL_M" || key === "\r" || key === "\n";
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "";
}

