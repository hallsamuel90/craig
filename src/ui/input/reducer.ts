import { RUNNER_IDS } from "../../domain/config/index.js";
import type { RunnerType } from "../../domain/config/index.js";
import type { TaskPtyTabKind } from "../../domain/task/index.js";
import {
  INSPECTION_TAB_ID,
  ACTION_IDS,
  REVIEW_ACTION_IDS,
  INSPECTION_MODE_IDS,
  isEnterKey,
  isTerminalDetachKey,
  isFixedCenterTab,
  isTaskLeftItemId,
  getNextRunner,
  getPtyTabKindFromId,
  parseLeftItemId,
  isNewTaskLeftItemId,
  isNewTaskWorkspaceLeftItemId,
  isWorkspaceLeftItemId,
  getNewTaskRepoId,
  getNewTaskWorkspaceId,
} from "../state.js";
import type {
  ControlShellState,
  ReduceMainKeyOptions,
  MainKeyResult,
  CenterTabId,
  LeftNavItemId,
  InspectionMode,
  FocusRegion,
} from "../state.js";

const NAVIGABLE_FOCUS_REGIONS: FocusRegion[] = ["tasks", "center", "inspector"];

export function reduceFileSearchKey(state: ControlShellState, key: string, options: ReduceMainKeyOptions): MainKeyResult {
  if (key === "ESCAPE") {
    return result({ state: { ...state, fileSearchQuery: null }, changed: true });
  }

  if (key === "BACKSPACE" || key === "DELETE") {
    const q = state.fileSearchQuery ?? "";
    return result({ state: { ...state, fileSearchQuery: q.slice(0, -1) }, changed: true });
  }

  if (key === "UP" || key === "k" || key === "DOWN" || key === "j") {
    return moveSelection(state, key === "UP" || key === "k" ? -1 : 1, options);
  }

  if (key === "ENTER") {
    return reduceMainKey({ ...state, fileSearchQuery: null }, key, options);
  }

  if (key.length === 1 && key >= " ") {
    const q = (state.fileSearchQuery ?? "") + key;
    return result({ state: { ...state, fileSearchQuery: q }, changed: true });
  }

  return result({ state });
}

export function reduceMainKey(state: ControlShellState, key: string, options: ReduceMainKeyOptions = { leftItemIds: [] }): MainKeyResult {
  if (state.inputMode === "terminal") {
    if (isTerminalDetachKey(key)) {
      return result({
        state: { ...state, inputMode: "control", centerZoomed: false, actionMessage: null, focusedRegion: "center" },
        changed: true,
        detachTerminal: true,
      });
    }

    return result({ state });
  }

  if (state.fileSearchQuery !== null) {
    return reduceFileSearchKey(state, key, options);
  }

  if (key === "/" && state.focusedRegion === "inspector" && state.inspectionMode === "files") {
    return result({ state: { ...state, fileSearchQuery: "" }, changed: true });
  }

  if (key === "q" || key === "Q") {
    return result({ state, exit: true });
  }

  if (key === "ESCAPE") {
    return result({ state: { ...state, actionMessage: null }, changed: state.actionMessage !== null, pause: true });
  }

  if (key === "n" || key === "N") {
    return result({
      state: {
        ...state,
        focusedRegion: "tasks",
        actionMessage: null,
        taskPromptInput: "",
        taskPromptError: null,
      },
      changed: true,
      beginTaskPrompt: true,
    });
  }

  if ((key === "r" || key === "R") && state.focusedRegion === "tasks" && (isNewTaskLeftItemId(state.selectedLeftItemId) || isNewTaskWorkspaceLeftItemId(state.selectedLeftItemId))) {
    return result({
      state: {
        ...state,
        selectedRunner: getNextRunner(state.selectedRunner, options.enabledRunnerIds),
        actionMessage: null,
        taskPromptError: null,
      },
      changed: true,
    });
  }

  if (key === "TAB" || key === "]") {
    return updateFocus(state, 1);
  }

  if (key === "SHIFT_TAB" || key === "[") {
    return updateFocus(state, -1);
  }

  if (key === "z" || key === "Z") {
    return result({
      state: { ...state, centerZoomed: !state.centerZoomed, actionMessage: null },
      changed: true,
    });
  }

  if (key === "UP" || key === "k") {
    if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
      return scrollInspectionContent(state, -1, options);
    }

    return moveSelection(state, -1, options);
  }

  if (key === "DOWN" || key === "j") {
    if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
      return scrollInspectionContent(state, 1, options);
    }

    return moveSelection(state, 1, options);
  }

  if (key === "PAGE_UP") {
    return scrollInspectionContent(state, -(options.pageRows ?? 10), options);
  }

  if (key === "PAGE_DOWN") {
    return scrollInspectionContent(state, options.pageRows ?? 10, options);
  }

  if (key === "MOUSE_WHEEL_UP") {
    return scrollInspectionContent(state, -3, options);
  }

  if (key === "MOUSE_WHEEL_DOWN") {
    return scrollInspectionContent(state, 3, options);
  }

  if (key === "r" && state.focusedRegion === "center" && state.selectedTaskId) {
    const runners = options.enabledRunnerIds ?? (RUNNER_IDS as readonly RunnerType[]);
    const currentIndex = state.centerTabRunner ? runners.indexOf(state.centerTabRunner) : -1;
    const nextRunner: RunnerType | null = currentIndex === runners.length - 1 ? null : runners[currentIndex + 1]!;
    return result({
      state: { ...state, centerTabRunner: nextRunner, actionMessage: null },
      changed: true,
    });
  }

  if ((key === "+" || key === "a" || key === "A" || key === "t" || key === "T") && state.focusedRegion === "center" && state.selectedTaskId) {
    const kind = getCreatePtyTabKind(state, key);
    return result({
      state: { ...state, preferredPtyTabKind: kind, actionMessage: null },
      changed: true,
      createPtyTab: true,
      createPtyTabKind: kind,
      createPtyTabRunner: kind === "agent" ? state.centerTabRunner : null,
    });
  }

  if (key === "R" && state.focusedRegion === "inspector" && state.inspectionMode === "review") {
    return result({
      state: { ...state, selectedActionId: "refresh-checks", actionMessage: null },
      changed: true,
      refreshPullRequestChecks: true,
    });
  }

  if (key === "o" && state.focusedRegion === "inspector" && state.inspectionMode === "review" && state.selectedTaskId) {
    return result({
      state,
      openPrUrl: true,
    });
  }

  if (key === "X" && state.focusedRegion === "inspector" && state.inspectionMode === "review") {
    return result({
      state: { ...state, selectedActionId: "close-task", actionMessage: null },
      changed: true,
      closeTask: true,
    });
  }

  if (key === "X" && state.focusedRegion === "tasks" && isTaskLeftItemId(state.selectedLeftItemId) && state.selectedTaskId) {
    return result({
      state: { ...state, selectedActionId: "close-task", actionMessage: null },
      changed: true,
      closeTask: true,
    });
  }

  if (key === "X" && state.focusedRegion === "tasks" && isWorkspaceLeftItemId(state.selectedLeftItemId) && state.selectedWorkspaceId) {
    return result({
      state: { ...state, actionMessage: null },
      changed: true,
      removeWorkspace: true,
    });
  }

  if (key === "x" && state.focusedRegion === "center" && isConcretePtyTab(state.activeTab, options.ptyTabIds ?? [])) {
    return result({ state: { ...state, actionMessage: null }, changed: true, closePtyTab: true });
  }

  if (key === "LEFT" || key === "h") {
    if (state.focusedRegion === "center") {
      return moveTab(state, -1, options.centerTabIds);
    }
    if (state.focusedRegion === "inspector") {
      return moveInspectionMode(state, -1);
    }
  }

  if (key === "RIGHT" || key === "l") {
    if (state.focusedRegion === "center") {
      return moveTab(state, 1, options.centerTabIds);
    }
    if (state.focusedRegion === "inspector") {
      return moveInspectionMode(state, 1);
    }
  }

  if (isEnterKey(key)) {
    if (state.focusedRegion === "tasks" && (isNewTaskLeftItemId(state.selectedLeftItemId) || isNewTaskWorkspaceLeftItemId(state.selectedLeftItemId))) {
      const repoId = getNewTaskRepoId(state.selectedLeftItemId);
      const workspaceId = getNewTaskWorkspaceId(state.selectedLeftItemId);
      return result({
        state: {
          ...state,
          selectedRepoId: repoId ?? state.selectedRepoId,
          selectedWorkspaceId: workspaceId ?? state.selectedWorkspaceId,
          actionMessage: null,
          taskPromptInput: "",
          taskPromptError: null,
        },
        changed: true,
        beginTaskPrompt: true,
      });
    }

    if (state.focusedRegion === "tasks" && state.selectedLeftItemId === "new-workspace") {
      return result({
        state: {
          ...state,
          actionMessage: null,
        },
        changed: true,
        openWorkspaceBrowser: true,
      });
    }

    if (state.focusedRegion === "tasks" && isTaskLeftItemId(state.selectedLeftItemId) && state.selectedTaskId) {
      const tabId = state.selectedPtyTabId ?? state.activeTab;
      return result({
        state: {
          ...state,
          inputMode: "terminal",
          focusedRegion: "center",
          activeTab: tabId,
          selectedPtyTabId: tabId,
          preferredPtyTabKind: getPtyTabKindFromId(tabId) ?? state.preferredPtyTabKind,
          actionMessage: null,
        },
        changed: true,
        attachTerminal: true,
      });
    }

    if (state.focusedRegion === "center" && isConcretePtyTab(state.activeTab, options.ptyTabIds ?? []) && state.selectedTaskId) {
      return result({
        state: {
          ...state,
          inputMode: "terminal",
          selectedPtyTabId: state.activeTab,
          preferredPtyTabKind: getPtyTabKindFromId(state.activeTab) ?? state.preferredPtyTabKind,
          actionMessage: null,
        },
        changed: true,
        attachTerminal: true,
      });
    }

    if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
      return result({
        state: { ...state, actionMessage: null },
        changed: true,
        refreshInspection: true,
      });
    }

    if (state.focusedRegion === "inspector" && state.selectedTaskId && state.inspectionMode === "files") {
      const selectedTreePath = state.selectedFileTreePath ?? state.selectedFilePath;
      if (selectedTreePath && (options.fileTreeDirectoryIds ?? []).includes(selectedTreePath)) {
        return result({
          state: toggleCollapsedFileTreePath({ ...state, selectedFileTreePath: selectedTreePath }),
          changed: true,
        });
      }

      const selectedFilePath = selectedTreePath && (options.fileTreeFileIds ?? []).includes(selectedTreePath)
        ? selectedTreePath
        : state.selectedFilePath;
      return result({
        state: {
          ...state,
          selectedFileTreePath: selectedFilePath,
          selectedFilePath,
          activeTab: INSPECTION_TAB_ID,
          openInspectionKind: "file",
          fileScrollOffset: 0,
          actionMessage: null,
        },
        changed: true,
        refreshInspection: true,
      });
    }

    if (state.focusedRegion === "inspector" && state.selectedTaskId && state.inspectionMode === "diff") {
      return result({
        state: {
          ...state,
          activeTab: INSPECTION_TAB_ID,
          openInspectionKind: "diff",
          diffScrollOffset: 0,
          actionMessage: null,
        },
        changed: true,
        refreshInspection: true,
      });
    }

    if (state.focusedRegion === "inspector" && state.inspectionMode === "review") {
      if (state.selectedActionId === "close-task" && !options.projectTargetIds?.length) {
        return result({
          state: {
            ...state,
            actionMessage: null,
          },
          changed: true,
          closeTask: true,
        });
      }

      return result({
        state: {
          ...state,
          selectedActionId: "refresh-checks",
          actionMessage: null,
        },
        changed: true,
        refreshPullRequestChecks: true,
      });
    }

    if (state.focusedRegion !== "actions") {
      return result({ state });
    }

    if (state.selectedActionId === "refresh-checks") {
      return result({
        state: {
          ...state,
          actionMessage: null,
        },
        changed: true,
        refreshPullRequestChecks: true,
      });
    }

    if (state.selectedActionId === "close-task") {
      return result({
        state: {
          ...state,
          actionMessage: null,
        },
        changed: true,
        closeTask: true,
      });
    }

    return result({
      state: {
        ...state,
        actionMessage: `Action queued: ${state.selectedActionId} (inspection surfaces land in phase 4.1).`,
      },
      changed: true,
    });
  }

  return result({ state });
}

export function scrollInspectionContent(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  if (delta === 0) {
    return result({ state });
  }

  if (state.focusedRegion === "inspector") {
    if (state.inspectionMode === "files") {
      return moveFileTreeSelection(state, delta, options);
    }

    if (state.inspectionMode === "diff") {
      const next = updateDynamicValue(state, "selectedDiffPath", options.diffPathIds ?? [], delta, true);
      return next.changed ? { ...next, state: { ...next.state, diffScrollOffset: 0 } } : next;
    }

    if (state.inspectionMode === "review") {
      return updateScrollOffset(state, "reviewScrollOffset", delta, options.reviewRowCount ?? 100, options.pageRows);
    }

    return result({ state });
  }

  if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
    if (state.openInspectionKind === "file") {
      return updateScrollOffset(state, "fileScrollOffset", delta, options.fileLineCount ?? 0, options.pageRows);
    }

    if (state.openInspectionKind === "diff") {
      return scrollDiffContent(state, delta, options);
    }
  }

  return result({ state });
}

function updateFocus(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return updateIndexedValue(state, "focusedRegion", NAVIGABLE_FOCUS_REGIONS, direction);
}

function moveTab(state: ControlShellState, direction: -1 | 1, centerTabIds: CenterTabId[] | undefined): MainKeyResult {
  const next = updateIndexedValue(
    state,
    "activeTab",
    centerTabIds && centerTabIds.length > 0 ? centerTabIds : buildCenterTabIdsFromState(state),
    direction,
  );
  if (!next.changed) {
    return next;
  }

  if (isFixedCenterTab(next.state.activeTab)) {
    return next;
  }

  return {
    ...next,
    state: {
      ...next.state,
      selectedPtyTabId: next.state.activeTab,
      preferredPtyTabKind: getPtyTabKindFromId(next.state.activeTab) ?? next.state.preferredPtyTabKind,
    },
  };
}

function moveSelection(state: ControlShellState, direction: -1 | 1, options: ReduceMainKeyOptions): MainKeyResult {
  if (state.focusedRegion === "tasks") {
    return moveLeftSelection(state, direction, options.leftItemIds);
  }

  if (state.focusedRegion === "center") {
    return moveTab(state, direction, options.centerTabIds);
  }

  if (state.focusedRegion === "inspector") {
    if (state.inspectionMode === "files") {
      return moveFileTreeSelection(state, direction, options);
    }

    if (state.inspectionMode === "diff") {
      const next = updateDynamicValue(state, "selectedDiffPath", options.diffPathIds ?? [], direction, true);
      return next.changed
        ? {
            ...next,
            state: {
              ...next.state,
              activeTab: INSPECTION_TAB_ID,
              openInspectionKind: "diff",
              diffScrollOffset: 0,
            },
            refreshInspection: true,
          }
        : next;
    }

    if (options.projectTargetIds?.length) {
      const next = updateDynamicValue(state, "selectedProjectTargetId", options.projectTargetIds, direction);
      return next.changed ? { ...next, state: { ...next.state, reviewScrollOffset: 0, selectedActionId: "refresh-checks" } } : next;
    }
    return updateIndexedValue(state, "selectedActionId", REVIEW_ACTION_IDS, direction);
  }

  return updateIndexedValue(state, "selectedActionId", ACTION_IDS, direction);
}

function moveLeftSelection(state: ControlShellState, direction: -1 | 1, leftItemIds: LeftNavItemId[]): MainKeyResult {
  const next = updateDynamicValue(state, "selectedLeftItemId", leftItemIds, direction);
  if (!next.changed) {
    return next;
  }

  const selection = parseLeftItemId(next.state.selectedLeftItemId);
  if (selection?.kind === "workspace") {
    return {
      ...next,
      state: {
        ...next.state,
        selectedWorkspaceId: selection.id,
        selectedTaskId: null,
        selectedPtyTabId: null,
        selectedFilePath: null,
        selectedFileTreePath: null,
        selectedDiffPath: null,
        fileScrollOffset: 0,
        diffScrollOffset: 0,
        reviewScrollOffset: 0,
      },
      refreshInspection: true,
    };
  }
  if (selection?.kind === "task") {
    return {
      ...next,
      state: {
        ...next.state,
        selectedTaskId: selection.id,
        selectedFilePath: null,
        selectedFileTreePath: null,
        selectedDiffPath: null,
        fileScrollOffset: 0,
        diffScrollOffset: 0,
        reviewScrollOffset: 0,
      },
      refreshInspection: true,
    };
  }

  if (selection?.kind === "repo") {
    return {
      ...next,
      state: {
        ...next.state,
        selectedRepoId: selection.id,
        selectedTaskId: null,
        selectedPtyTabId: null,
        selectedFilePath: null,
        selectedFileTreePath: null,
        selectedDiffPath: null,
        fileScrollOffset: 0,
        diffScrollOffset: 0,
        reviewScrollOffset: 0,
      },
      refreshInspection: true,
    };
  }

  const newTaskRepoId = getNewTaskRepoId(next.state.selectedLeftItemId);
  if (newTaskRepoId) {
    return {
      ...next,
      state: {
        ...next.state,
        selectedRepoId: newTaskRepoId,
      },
    };
  }

  const newTaskWorkspaceId = getNewTaskWorkspaceId(next.state.selectedLeftItemId);
  if (newTaskWorkspaceId) {
    return {
      ...next,
      state: {
        ...next.state,
        selectedWorkspaceId: newTaskWorkspaceId,
      },
    };
  }

  return next;
}

function setInspectionMode(state: ControlShellState, mode: InspectionMode): MainKeyResult {
  if (state.inspectionMode === mode) {
    return result({ state });
  }

  const openInspectionKind = mode === "diff" ? "diff" : mode === "files" ? "file" : state.openInspectionKind;
  const activeTab = mode === "diff" || mode === "files" ? INSPECTION_TAB_ID : state.activeTab;

  return result({
    state: {
      ...state,
      inspectionMode: mode,
      activeTab,
      openInspectionKind,
      fileScrollOffset: mode === "files" ? 0 : state.fileScrollOffset,
      diffScrollOffset: mode === "diff" ? 0 : state.diffScrollOffset,
      reviewScrollOffset: mode === "review" ? 0 : state.reviewScrollOffset,
      actionMessage: null,
    },
    changed: true,
    refreshInspection: true,
  });
}

function moveInspectionMode(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return setInspectionMode(
    state,
    updateValueInList(state.inspectionMode, INSPECTION_MODE_IDS, direction),
  );
}

function moveFileTreeSelection(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  const rowIds = options.fileTreeRowIds && options.fileTreeRowIds.length > 0 ? options.fileTreeRowIds : options.filePathIds ?? [];
  if (rowIds.length === 0) {
    return result({ state });
  }

  const currentPath = state.selectedFileTreePath ?? state.selectedFilePath ?? rowIds[0] ?? null;
  const currentIndex = rowIds.indexOf(currentPath ?? "");
  const nextIndex = clamp(currentIndex === -1 ? 0 : currentIndex + delta, 0, rowIds.length - 1);
  const nextPath = rowIds[nextIndex] ?? null;
  if (nextPath === state.selectedFileTreePath) {
    return result({ state });
  }

  const isFile = nextPath !== null && (options.fileTreeFileIds ?? options.filePathIds ?? []).includes(nextPath);
  return result({
    state: {
      ...state,
      selectedFileTreePath: nextPath,
      selectedFilePath: isFile ? nextPath : state.selectedFilePath,
      activeTab: isFile ? INSPECTION_TAB_ID : state.activeTab,
      openInspectionKind: isFile ? "file" : state.openInspectionKind,
      fileScrollOffset: isFile ? 0 : state.fileScrollOffset,
      actionMessage: null,
    },
    changed: true,
    refreshInspection: isFile,
  });
}

function toggleCollapsedFileTreePath(state: ControlShellState): ControlShellState {
  if (!state.selectedFileTreePath) {
    return state;
  }

  const collapsed = new Set(state.collapsedFileTreePaths);
  if (collapsed.has(state.selectedFileTreePath)) {
    collapsed.delete(state.selectedFileTreePath);
  } else {
    collapsed.add(state.selectedFileTreePath);
  }

  return {
    ...state,
    collapsedFileTreePaths: [...collapsed].sort((left, right) => left.localeCompare(right)),
    actionMessage: null,
  };
}

function updateScrollOffset(
  state: ControlShellState,
  key: "fileScrollOffset" | "diffScrollOffset" | "reviewScrollOffset",
  delta: number,
  lineCount: number,
  visibleRows = 10,
): MainKeyResult {
  const maxOffset = Math.max(0, lineCount - Math.max(1, visibleRows));
  const nextOffset = clamp(state[key] + delta, 0, maxOffset);

  if (nextOffset === state[key]) {
    return result({ state });
  }

  return result({
    state: { ...state, [key]: nextOffset, actionMessage: null },
    changed: true,
  });
}

function scrollDiffContent(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  if (options.diffPathRanges && options.diffPathRanges.length > 0) {
    return scrollCombinedDiffContent(state, delta, options);
  }

  const lineCount = options.diffLineCount ?? 0;
  const visibleRows = options.pageRows ?? 10;
  const maxOffset = Math.max(0, lineCount - Math.max(1, visibleRows));
  const targetOffset = state.diffScrollOffset + delta;

  const diffPathIds = options.diffPathIds ?? [];
  if (diffPathIds.length === 0 || !state.selectedDiffPath) {
    const nextOffset = clamp(targetOffset, 0, maxOffset);
    return nextOffset === state.diffScrollOffset
      ? result({ state })
      : result({
          state: { ...state, diffScrollOffset: nextOffset, actionMessage: null },
          changed: true,
        });
  }

  const currentIndex = diffPathIds.indexOf(state.selectedDiffPath);
  if (currentIndex === -1) {
    const nextOffset = clamp(targetOffset, 0, maxOffset);
    return nextOffset === state.diffScrollOffset
      ? result({ state })
      : result({
          state: { ...state, diffScrollOffset: nextOffset, actionMessage: null },
          changed: true,
        });
  }

  if (delta > 0 && targetOffset > maxOffset) {
    const nextPath = diffPathIds[currentIndex + 1] ?? null;
    if (!nextPath) {
      return state.diffScrollOffset === maxOffset
        ? result({ state })
        : result({
            state: { ...state, diffScrollOffset: maxOffset, actionMessage: null },
            changed: true,
          });
    }

    return result({
      state: { ...state, selectedDiffPath: nextPath, activeTab: INSPECTION_TAB_ID, openInspectionKind: "diff", diffScrollOffset: 0, actionMessage: null },
      changed: true,
      refreshInspection: true,
    });
  }

  if (delta < 0 && targetOffset < 0) {
    const previousPath = diffPathIds[currentIndex - 1] ?? null;
    if (!previousPath) {
      return state.diffScrollOffset === 0
        ? result({ state })
        : result({
            state: { ...state, diffScrollOffset: 0, actionMessage: null },
            changed: true,
          });
    }

    return result({
      state: {
        ...state,
        selectedDiffPath: previousPath,
        activeTab: INSPECTION_TAB_ID,
        openInspectionKind: "diff",
        diffScrollOffset: Number.MAX_SAFE_INTEGER,
        actionMessage: null,
      },
      changed: true,
      refreshInspection: true,
    });
  }

  const nextOffset = clamp(targetOffset, 0, maxOffset);
  return nextOffset === state.diffScrollOffset
    ? result({ state })
    : result({
        state: { ...state, diffScrollOffset: nextOffset, actionMessage: null },
        changed: true,
      });
}

function scrollCombinedDiffContent(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  const lineCount = options.diffLineCount ?? 0;
  const visibleRows = options.pageRows ?? 10;
  const maxOffset = Math.max(0, lineCount - Math.max(1, visibleRows));
  const nextOffset = clamp(state.diffScrollOffset + delta, 0, maxOffset);
  const nextPath = resolveDiffPathForOffset(options.diffPathRanges ?? [], nextOffset) ?? state.selectedDiffPath;

  if (nextOffset === state.diffScrollOffset && nextPath === state.selectedDiffPath) {
    return result({ state });
  }

  return result({
    state: {
      ...state,
      diffScrollOffset: nextOffset,
      selectedDiffPath: nextPath,
      actionMessage: null,
    },
    changed: true,
  });
}

function resolveDiffPathForOffset(
  ranges: Array<{ path: string; start: number; end: number }>,
  offset: number,
): string | null {
  return ranges.find((range) => offset >= range.start && offset < range.end)?.path ?? ranges.at(-1)?.path ?? null;
}

function updateIndexedValue<Key extends "focusedRegion" | "activeTab" | "selectedActionId">(
  state: ControlShellState,
  key: Key,
  values: readonly ControlShellState[Key][],
  direction: number,
): MainKeyResult {
  const index = values.indexOf(state[key]);
  const nextIndex = clamp(index + direction, 0, values.length - 1);
  const nextValue = values[nextIndex];

  if (!nextValue || nextValue === state[key]) {
    return result({ state });
  }

  return result({
    state: { ...state, [key]: nextValue, actionMessage: null },
    changed: true,
  });
}

function updateDynamicValue<Key extends "selectedTaskId" | "selectedLeftItemId" | "selectedFilePath" | "selectedDiffPath" | "selectedProjectTargetId">(
  state: ControlShellState,
  key: Key,
  values: string[],
  direction: number,
  refreshInspection = false,
): MainKeyResult {
  if (values.length === 0) {
    return result({ state });
  }

  const index = values.indexOf(state[key] ?? values[0] ?? "");
  const nextIndex = clamp(index === -1 ? 0 : index + direction, 0, values.length - 1);
  const nextValue = values[nextIndex] ?? null;

  if (nextValue === state[key]) {
    return result({ state });
  }

  return result({
    state: { ...state, [key]: nextValue, actionMessage: null },
    changed: true,
    refreshInspection,
  });
}

function updateValueInList<const Values extends readonly string[]>(
  value: Values[number],
  values: Values,
  direction: -1 | 1,
): Values[number] {
  const index = values.indexOf(value);
  return values[clamp(index + direction, 0, values.length - 1)] ?? value;
}

function result(input: {
  state: ControlShellState;
  changed?: boolean;
  exit?: boolean;
  pause?: boolean;
  attachTerminal?: boolean;
  detachTerminal?: boolean;
  beginTaskPrompt?: boolean;
  openWorkspaceBrowser?: boolean;
  createWorkspaceTask?: boolean;
  createPtyTab?: boolean;
  createPtyTabKind?: TaskPtyTabKind | null;
  createPtyTabRunner?: RunnerType | null;
  closePtyTab?: boolean;
  refreshPullRequestChecks?: boolean;
  closeTask?: boolean;
  removeWorkspace?: boolean;
  refreshInspection?: boolean;
  openPrUrl?: boolean;
}): MainKeyResult {
  return {
    state: input.state,
    changed: input.changed ?? false,
    exit: input.exit ?? false,
    pause: input.pause ?? false,
    attachTerminal: input.attachTerminal ?? false,
    detachTerminal: input.detachTerminal ?? false,
    beginTaskPrompt: input.beginTaskPrompt ?? false,
    openWorkspaceBrowser: input.openWorkspaceBrowser ?? false,
    createWorkspaceTask: input.createWorkspaceTask ?? false,
    createPtyTab: input.createPtyTab ?? false,
    createPtyTabKind: input.createPtyTabKind ?? null,
    createPtyTabRunner: input.createPtyTabRunner ?? null,
    closePtyTab: input.closePtyTab ?? false,
    refreshPullRequestChecks: input.refreshPullRequestChecks ?? false,
    closeTask: input.closeTask ?? false,
    removeWorkspace: input.removeWorkspace ?? false,
    refreshInspection: input.refreshInspection ?? false,
    openPrUrl: input.openPrUrl ?? false,
  };
}

function isConcretePtyTab(tabId: string, ptyTabIds: string[]): boolean {
  return ptyTabIds.includes(tabId);
}

function getCreatePtyTabKind(state: ControlShellState, key: string): TaskPtyTabKind {
  if (key === "a" || key === "A") {
    return "agent";
  }

  if (key === "t" || key === "T") {
    return "terminal";
  }

  return getPtyTabKindFromId(state.activeTab) ?? state.preferredPtyTabKind;
}

function buildCenterTabIdsFromState(state: ControlShellState): CenterTabId[] {
  return [
    state.selectedPtyTabId,
    state.openInspectionKind ? INSPECTION_TAB_ID : null,
  ].filter((entry): entry is string => typeof entry === "string");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
