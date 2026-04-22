import path from "node:path";
import pc from "picocolors";

import { getBannerArtLines } from "../banner.js";
import type { TaskRecord } from "../types/task.js";

interface RenderLayoutInput {
  repoRoot: string;
  tasks: TaskRecord[];
  selectedTaskId: string | null;
  hasSelectedTask: boolean;
  commandBuffer: string;
  outputLines: string[];
  recentEvent: string | null;
  terminalSize: {
    columns: number;
    rows: number;
  };
}

const MIN_THREE_COLUMN_WIDTH = 92;

export function renderInteractiveLayout(input: RenderLayoutInput): string {
  if (input.terminalSize.columns < MIN_THREE_COLUMN_WIDTH) {
    return renderStackedLayout(input);
  }

  return renderThreeColumnLayout(input);
}

function renderThreeColumnLayout(input: RenderLayoutInput): string {
  const widths = getThreeColumnWidths(input.terminalSize.columns);
  const headerLines = renderHeader(input, input.terminalSize.columns);
  const contentRows = Math.max(input.terminalSize.rows - headerLines.length - 2, 10);
  const leftLines = renderTaskNavigator(input, widths.left, contentRows);
  const middleLines = renderMiddleSurface(input, widths.middle, contentRows);
  const rightLines = renderContextSurface(input, widths.right, contentRows);
  const content: string[] = [];

  for (let index = 0; index < contentRows; index += 1) {
    content.push(
      [
        padLine(leftLines[index] ?? "", widths.left),
        padLine(middleLines[index] ?? "", widths.middle),
        padLine(rightLines[index] ?? "", widths.right),
      ].join(" "),
    );
  }

  const rows: string[] = [...headerLines, "", ...decorateWithBanner(content, input.terminalSize.columns)];

  rows.push(padLine(renderFooter(input.terminalSize.columns), input.terminalSize.columns));

  return rows.join("\n");
}

function renderStackedLayout(input: RenderLayoutInput): string {
  const width = input.terminalSize.columns;
  const rows = [
    ...renderHeader(input, width),
    divider(width),
    ...renderTaskNavigator(input, width, 8),
    divider(width),
    ...renderMiddleSurface(input, width, 8),
    divider(width),
    ...renderContextSurface(input, width, 8),
    divider(width),
    renderFooter(width),
  ];

  return rows.map((line) => padLine(line, width)).join("\n");
}

function renderTaskNavigator(input: RenderLayoutInput, width: number, height: number): string[] {
  const lines = [
    `Tasks | ${input.tasks.length}`,
    divider(width),
  ];

  if (input.tasks.length === 0) {
    lines.push("<no tasks>");
  } else {
    for (const task of input.tasks.slice(0, Math.max(1, height - 2))) {
      const marker = task.id === input.selectedTaskId ? ">" : " ";
      lines.push(
        truncateLine(
          `${marker} ${task.id} ${task.status} ${task.title}`,
          width,
        ),
      );
    }
  }

  return fillLines(lines, width, height);
}

function renderMiddleSurface(input: RenderLayoutInput, width: number, height: number): string[] {
  const selectedTask = input.tasks.find((task) => task.id === input.selectedTaskId) ?? null;
  const helperText =
    input.outputLines.length > 0
      ? input.outputLines
      : input.hasSelectedTask
        ? buildSelectedTaskHelp(selectedTask, width)
        : ["Create a task with: new <task>"];
  const lines = [
    "Command Surface",
    divider(width),
    truncateLine(`Recent: ${input.recentEvent ?? "ready"}`, width),
    truncateLine(`craig> ${input.commandBuffer}\u2588`, width),
    divider(width),
    ...helperText,
  ];

  return fillLines(lines, width, height);
}

function renderContextSurface(input: RenderLayoutInput, width: number, height: number): string[] {
  const selectedTask = input.tasks.find((task) => task.id === input.selectedTaskId) ?? null;
  const lines = ["Selected Task", divider(width)];

  if (!selectedTask) {
    lines.push("No task selected.");
    lines.push("Create one with: new <task>");
    return fillLines(lines, width, height);
  }

  lines.push(
    truncateLine(`${selectedTask.id} | ${selectedTask.title}`, width),
    `Status: ${selectedTask.status}`,
    `Runner: ${selectedTask.runnerSession.lastKnownState}`,
    truncateLine(`Branch: ${selectedTask.branch}`, width),
    truncateLine(`Checks: ${selectedTask.checks.status}`, width),
    truncateLine(`PR: ${formatPrStatus(selectedTask)}`, width),
    truncateLine(`Page: ${selectedTask.tmuxPage ?? "-"} Slot: ${selectedTask.layoutSlot ?? "-"}`, width),
    truncateLine(`Next: ${describeNextAction(selectedTask)}`, width),
  );

  return fillLines(lines, width, height);
}

function renderFooter(width: number): string {
  return truncateLine("Enter run command | r refresh | Ctrl-L redraw | Ctrl-C exit", width);
}

function renderHeader(input: RenderLayoutInput, width: number): string[] {
  const summary = truncateLine(
    `${path.basename(input.repoRoot)} | ${input.tasks.length} tasks | full-screen control surface`,
    width,
  );

  return [summary, divider(width)];
}

function describeNextAction(task: TaskRecord): string {
  switch (task.status) {
    case "draft":
    case "running":
      return "show or diff";
    case "review":
      return "check";
    case "checked":
      return "pr";
    case "pr_open":
      return "pr --watch";
    case "merge_ready":
      return "merge";
    case "merged":
      return "open or cleanup done";
    default:
      return "show";
  }
}

function buildSelectedTaskHelp(selectedTask: TaskRecord | null, width: number): string[] {
  if (!selectedTask) {
    return ["Selected-task commands can omit the id."];
  }

  const defaultAction = describeDefaultAction(selectedTask);

  return [
    truncateLine(`Selected: ${selectedTask.id}`, width),
    truncateLine(`Enter: ${defaultAction}`, width),
    truncateLine("Actions: show logs diff focus open check", width),
    truncateLine("Task commands can omit the id.", width),
  ];
}

function describeDefaultAction(task: TaskRecord): string {
  switch (task.status) {
    case "draft":
    case "running":
      return "logs";
    case "review":
    case "checked":
    case "pr_open":
    case "merge_ready":
    case "merged":
      return "diff";
    default:
      return "show";
  }
}

function formatPrStatus(task: TaskRecord): string {
  if (!task.pullRequest.number) {
    return "-";
  }

  return `#${task.pullRequest.number}:${task.pullRequest.status ?? "unknown"}`;
}

function getThreeColumnWidths(totalWidth: number): { left: number; middle: number; right: number } {
  const gap = 2;
  const available = totalWidth - gap;
  const left = Math.max(24, Math.floor(available * 0.25));
  const middle = Math.max(40, Math.floor(available * 0.45));

  return { left, middle, right: available - left - middle };
}

function fillLines(lines: string[], width: number, height: number): string[] {
  const truncated = lines.slice(0, height).map((line) => truncateLine(line, width));

  while (truncated.length < height) {
    truncated.push("");
  }

  return truncated;
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

function padLine(value: string, width: number): string {
  const truncated = truncateLine(value, width);
  return truncated.padEnd(width, " ");
}

function decorateWithBanner(rows: string[], width: number): string[] {
  if (rows.length < 16 || width < 120) {
    return rows;
  }

  const banner = getBannerArtLines().map((line) => pc.green(line));
  const bannerWidth = Math.max(...banner.map((line) => stripAnsi(line).length));
  const rightInset = 4;
  const bottomInset = 2;
  const startColumn = Math.max(0, width - bannerWidth - rightInset);
  const startRow = Math.max(0, rows.length - banner.length - bottomInset);

  if (!canOverlayBanner(rows, startRow, startColumn, bannerWidth, banner.length)) {
    return rows;
  }
  const nextRows = [...rows];

  for (let index = 0; index < banner.length; index += 1) {
    const rowIndex = startRow + index;

    if (rowIndex >= nextRows.length) {
      break;
    }

    nextRows[rowIndex] = overlayAtColumn(nextRows[rowIndex] ?? "", banner[index] ?? "", startColumn, width);
  }

  return nextRows;
}

function overlayAtColumn(base: string, overlay: string, startColumn: number, width: number): string {
  const plainOverlay = stripAnsi(overlay);
  const left = stripAnsi(base).slice(0, startColumn).padEnd(startColumn, " ");
  const rightStart = startColumn + plainOverlay.length;
  const right = stripAnsi(base).slice(rightStart, width);

  return `${left}${overlay}${right}`.slice(0, Math.max(width, startColumn + plainOverlay.length));
}

function divider(width: number): string {
  return "-".repeat(Math.max(0, width));
}

function canOverlayBanner(
  rows: string[],
  startRow: number,
  startColumn: number,
  bannerWidth: number,
  bannerHeight: number,
): boolean {
  for (let index = 0; index < bannerHeight; index += 1) {
    const row = stripAnsi(rows[startRow + index] ?? "");
    const region = row.slice(startColumn, startColumn + bannerWidth);

    if (region.trim().length > 0) {
      return false;
    }
  }

  return true;
}

function stripAnsi(value: string): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      index += 2;

      while (index < value.length && value[index] !== "m") {
        index += 1;
      }

      if (index < value.length) {
        index += 1;
      }

      continue;
    }

    result += value[index];
    index += 1;
  }

  return result;
}
