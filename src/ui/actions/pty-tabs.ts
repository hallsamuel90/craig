import type { CraigConfig } from "../../domain/config/index.js";
import { configService } from "../../domain/config/index.js";
import type { RunnerType } from "../../domain/config/index.js";
import { readTask, writeTask } from "../../domain/task/index.js";
import type { TaskPtyTabRecord, TaskRecord } from "../../types/task.js";
import type { ActionContext } from "./context.js";
import type { ControlShellState } from "../state.js";

export type PtyTabsActionResult = {
  updatedTask: TaskRecord;
  nextShell: Partial<ControlShellState>;
};

export const createPtyTab = async (
  shell: ControlShellState,
  requestedKind: TaskPtyTabRecord["kind"] | null,
  requestedRunner: RunnerType | null | undefined,
  ctx: ActionContext,
): Promise<PtyTabsActionResult> => {
  if (!shell.selectedTaskId) {
    throw new Error("Select a task before creating a tab.");
  }

  const updatedTask = await ctx.queueTaskMutation(async () => {
    const task = await readTask(ctx.paths, shell.selectedTaskId!);
    const kind = requestedKind ?? resolveNewPtyTabKind(task, shell.activeTab, shell.preferredPtyTabKind);
    const tab = createNextPtyTab(task, kind, requestedRunner ?? undefined, ctx.config);
    const next: TaskRecord = {
      ...task,
      ptyTabs: [...task.ptyTabs, tab],
      selectedPtyTabId: tab.id,
    };
    await writeTask(ctx.paths, next);
    return next;
  });

  return {
    updatedTask,
    nextShell: {
      activeTab: updatedTask.selectedPtyTabId ?? shell.activeTab,
      selectedPtyTabId: updatedTask.selectedPtyTabId,
      preferredPtyTabKind: updatedTask.ptyTabs.at(-1)?.kind ?? shell.preferredPtyTabKind,
      focusedRegion: "center",
      actionMessage: `Created tab: ${updatedTask.ptyTabs.at(-1)?.title ?? "tab"}`,
    },
  };
};

export const closePtyTab = async (
  shell: ControlShellState,
  ctx: ActionContext,
): Promise<{ closedTab: TaskPtyTabRecord; nextSelectedTab: TaskPtyTabRecord | null; nextShell: Partial<ControlShellState> }> => {
  if (!shell.selectedTaskId) {
    throw new Error("Select a task before closing a tab.");
  }

  const { closedTab, nextSelectedTab } = await ctx.queueTaskMutation(async () => {
    const task = await readTask(ctx.paths, shell.selectedTaskId!);
    const closedIndex = task.ptyTabs.findIndex((tab) => tab.id === shell.activeTab);
    if (closedIndex === -1) {
      throw new Error("Only PTY tabs can be closed.");
    }

    const closedTab = task.ptyTabs[closedIndex]!;
    const remainingTabs = task.ptyTabs.filter((tab) => tab.id !== closedTab.id);
    const nextSelectedTab = remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)] ?? null;
    await writeTask(ctx.paths, {
      ...task,
      ptyTabs: remainingTabs,
      selectedPtyTabId: nextSelectedTab?.id ?? null,
    });
    return { closedTab, nextSelectedTab };
  });

  return {
    closedTab,
    nextSelectedTab,
    nextShell: {
      activeTab: nextSelectedTab?.id ?? (shell.openInspectionKind ? "inspection" : shell.activeTab),
      selectedPtyTabId: nextSelectedTab?.id ?? null,
      focusedRegion: "center",
      actionMessage: `Closed tab: ${closedTab.title}`,
    },
  };
};

export const persistPtyTabSelection = async (
  shell: ControlShellState,
  ctx: ActionContext,
): Promise<void> => {
  const taskId = shell.selectedTaskId;
  if (!taskId) return;

  await ctx.queueTaskMutation(async () => {
    const latestTask = await readTask(ctx.paths, taskId);
    if (
      !latestTask.ptyTabs.some((tab) => tab.id === shell.activeTab) ||
      latestTask.selectedPtyTabId === shell.activeTab
    ) {
      return;
    }
    await writeTask(ctx.paths, { ...latestTask, selectedPtyTabId: shell.activeTab });
  });
};

export const ensureAgentTab = async (
  task: TaskRecord,
  ctx: ActionContext,
): Promise<TaskRecord> => {
  const agentTab = task.ptyTabs.find((t) => t.kind === "agent") ?? null;

  if (agentTab) {
    await ctx.queueTaskMutation(async () => {
      const latestTask = await readTask(ctx.paths, task.id);
      const latestAgentTab = latestTask.ptyTabs.find((t) => t.kind === "agent") ?? null;
      if (!latestAgentTab) return;
      await writeTask(ctx.paths, { ...latestTask, selectedPtyTabId: latestAgentTab.id });
    });
    return { ...task, selectedPtyTabId: agentTab.id };
  }

  const tab = createNextPtyTab(task, "agent", undefined, ctx.config);
  await ctx.queueTaskMutation(async () => {
    const latestTask = await readTask(ctx.paths, task.id);
    const latestAgentTab = latestTask.ptyTabs.find((t) => t.kind === "agent") ?? null;
    if (latestAgentTab) {
      await writeTask(ctx.paths, { ...latestTask, selectedPtyTabId: latestAgentTab.id });
      return;
    }
    await writeTask(ctx.paths, {
      ...latestTask,
      ptyTabs: [...latestTask.ptyTabs, tab],
      selectedPtyTabId: tab.id,
    });
  });
  return { ...task, ptyTabs: [...task.ptyTabs, tab], selectedPtyTabId: tab.id };
};

export function resolveNewPtyTabKind(
  task: TaskRecord,
  activeTab: string,
  preferredKind: TaskPtyTabRecord["kind"],
): TaskPtyTabRecord["kind"] {
  return task.ptyTabs.find((tab) => tab.id === activeTab)?.kind ?? preferredKind;
}

export function createNextPtyTab(
  task: TaskRecord,
  kind: TaskPtyTabRecord["kind"],
  runner?: RunnerType,
  config: CraigConfig = {},
): TaskPtyTabRecord {
  const effectiveRunner = runner ?? task.runner;
  const runnerProfile = configService.runners.getProfile(effectiveRunner);
  const baseTitle = kind === "agent" ? runnerProfile.defaultAgentTitle : "Terminal";
  const baseId =
    kind === "agent" && runner && runner !== task.runner
      ? `${task.id}:${runner}`
      : `${task.id}:${kind}`;
  const existingIds = new Set(task.ptyTabs.map((tab) => tab.id));
  let ordinal = 1;
  let id = baseId;

  while (existingIds.has(id)) {
    ordinal += 1;
    id = `${baseId}-${ordinal}`;
  }

  const timestamp = new Date().toISOString();
  const tabRunner = runner && runner !== task.runner ? runner : undefined;
  return {
    id,
    kind,
    ...(tabRunner ? { runner: tabRunner } : {}),
    title: ordinal === 1 ? baseTitle : `${baseTitle} ${ordinal}`,
    command: kind === "agent" ? configService.runners.buildCommand(effectiveRunner, undefined, config) : [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
