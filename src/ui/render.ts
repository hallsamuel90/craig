import { getBannerArtLines } from "../banner.js";
import type {
  MockActionRow,
  MockCheckRow,
  MockContextRow,
  MockRunnerRow,
  MockShellData,
  MockTab,
  MockTreeRow,
} from "./mock-data.js";
import { SHELL_LAYOUT, type Viewport } from "./layout.js";

export interface RenderOptions {
  color?: boolean;
  menuIndex?: number;
  optionsMessage?: string | null;
}

interface PaletteColor {
  bg?: string;
  fg?: string;
}

interface SurfaceLine {
  text: string;
  tone?: "default" | "muted" | "selected" | "focused";
  fullBleed?: boolean;
}

const BOOT_MENU = ["Start", "Options", "Exit"];
const PAUSE_MENU = ["Resume", "Options", "Exit"];
const LEFT_PANEL_INSET = 2;
const LEFT_PANEL_GUTTER = 2;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const RESET = "\u001B[0m";
const PALETTE = {
  rail: { bg: "0a0a0a", fg: "e6e6e6" },
  divider: { bg: "1a1a1a", fg: "1a1a1a" },
  overlay: { bg: "0a0a0a", fg: "888888" },
  overlayTitle: { bg: "0a0a0a", fg: "888888" },
  overlayLogo: { bg: "0a0a0a", fg: "22c55e" },
  overlaySubtitle: { bg: "0a0a0a", fg: "6fbf86" },
  leftDefault: { bg: "111418", fg: "d7d7d7" },
  leftMuted: { bg: "111418", fg: "8b8b8b" },
  leftSelected: { bg: "1a1f24", fg: "e6e6e6" },
  centerDefault: { bg: "0a0a0a", fg: "e6e6e6" },
  centerMuted: { bg: "0a0a0a", fg: "888888" },
  rightDefault: { bg: "0c0f12", fg: "e6e6e6" },
  rightMuted: { bg: "0c0f12", fg: "888888" },
  rightSelected: { bg: "1a1f24", fg: "e6e6e6" },
  accent: { fg: "22c55e" },
  warning: { fg: "b8a35d" },
  error: { fg: "c06c6c" },
  subtleDivider: { fg: "444b53" },
} as const;

export function renderBootOverlayFrame(viewport: Viewport, options: RenderOptions = {}): string {
  return renderOverlayFrame(viewport, {
    title: "CRAIG boot",
    subtitle: "crAIg is that you?",
    menuItems: BOOT_MENU,
    menuIndex: options.menuIndex ?? 0,
    optionsMessage: options.optionsMessage ?? null,
    color: options.color ?? true,
  });
}

export function renderPauseOverlayFrame(viewport: Viewport, options: RenderOptions = {}): string {
  return renderOverlayFrame(viewport, {
    title: "CRAIG paused",
    subtitle: "Control mode is paused.",
    menuItems: PAUSE_MENU,
    menuIndex: options.menuIndex ?? 0,
    optionsMessage: options.optionsMessage ?? null,
    color: options.color ?? true,
  });
}

export function renderMainShellFrame(
  viewport: Viewport,
  data: MockShellData,
  options: Pick<RenderOptions, "color"> = {},
): string {
  const color = options.color ?? true;
  const leftWidth = SHELL_LAYOUT.leftWidth;
  const rightWidth = SHELL_LAYOUT.rightWidth;
  const dividerWidth = SHELL_LAYOUT.dividerWidth;
  const centerWidth = viewport.width - leftWidth - rightWidth - dividerWidth;
  const bodyHeight = viewport.height - SHELL_LAYOUT.topRailHeight;

  const railText = `CRAIG  |  ${data.topRail.workspacePath}  |  ${data.topRail.agent}  ${green(
    `● ${data.topRail.liveLabel}`,
    color,
    PALETTE.rail,
  )}`;
  const railTop = fillSurface(pad(railText, viewport.width), color, PALETTE.rail);

  const leftLines = toLeftLines(data, leftWidth - LEFT_PANEL_INSET - LEFT_PANEL_GUTTER, bodyHeight, color);
  const centerLines = toCenterLines(data, centerWidth, bodyHeight, color);
  const rightLines = toRightLines(data, rightWidth, bodyHeight, color);

  const body: string[] = [];

  for (let index = 0; index < bodyHeight; index += 1) {
    const left = renderSurfaceSegment(leftLines[index] ?? emptyLine(), leftWidth, color, "left");
    const center = renderSurfaceSegment(centerLines[index] ?? emptyLine(), centerWidth, color, "center");
    const divider = fillSurface("│", color, PALETTE.divider);
    const right = renderSurfaceSegment(rightLines[index] ?? emptyLine(), rightWidth, color, "right");
    body.push(`${left}${center}${divider}${right}`);
  }

  return [railTop, ...body].join("\n");
}

function renderOverlayFrame(
  viewport: Viewport,
  input: {
    title: string;
    subtitle: string;
    menuItems: string[];
    menuIndex: number;
    optionsMessage: string | null;
    color: boolean;
  },
): string {
  const lines = new Array<string>(viewport.height).fill(fillSurface(" ".repeat(viewport.width), input.color, PALETTE.overlay));
  const logo = getBannerArtLines();
  const menu = input.menuItems.map((item, index) => `${index === input.menuIndex ? ">" : " "} ${item}`);
  const messageLines = input.optionsMessage ? ["", input.optionsMessage, "Press Esc to dismiss."] : [];
  const content = [...logo, "", input.subtitle, "", ...menu, ...messageLines];
  const startLine = Math.max(1, Math.floor((viewport.height - content.length) / 2));

  lines[0] = fillSurface(pad(input.title, viewport.width), input.color, PALETTE.overlayTitle);

  for (let index = 0; index < content.length; index += 1) {
    const centered = centerText(content[index] ?? "", viewport.width);

    if (index < logo.length) {
      lines[startLine + index] = fillSurface(centered, input.color, PALETTE.overlayLogo);
      continue;
    }

    if (index === logo.length + 1) {
      lines[startLine + index] = fillSurface(centered, input.color, PALETTE.overlaySubtitle);
      continue;
    }

    lines[startLine + index] = fillSurface(centered, input.color, PALETTE.overlay);
  }

  return lines.join("\n");
}

function toLeftLines(data: MockShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const lines: SurfaceLine[] = [
    ...data.leftTree.map((row) => renderTreeRow(row, width, color)),
    emptyLine(),
    { text: "+ New Task" },
    emptyLine(),
    { text: "RUNNERS", tone: "muted" },
    emptyLine(),
    ...data.runners.map((runner) => renderRunnerRow(runner)),
    emptyLine(),
  ];

  const fitted = fitLines(lines, height);
  fitted[height - 1] = { text: "NORMAL   ? help   / search   : command", tone: "muted", fullBleed: true };
  return fitted;
}

function toCenterLines(data: MockShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const activeTab = data.tabs.find((tab) => tab.active)?.label ?? "AGENT";
  const tabOffset = findTabOffset(data.tabs);
  const underline = `${" ".repeat(tabOffset)}${green("─".repeat(activeTab.length + 1), color, PALETTE.centerMuted)}`;
  const header = [
    `${green(data.centerHeader.tabLabel, color, PALETTE.centerDefault)}  ${data.centerHeader.taskId}`,
    data.centerHeader.repo,
    data.centerHeader.agent,
  ].join(" · ");

  const lines: SurfaceLine[] = [
    { text: renderTabLine(data.tabs, color) },
    { text: underline, tone: "muted" },
    { text: header },
    emptyLine(),
    ...data.centerTranscript.map((line) => ({ text: line })),
  ];

  return fitLines(lines, height);
}

function toRightLines(data: MockShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const divider = muted("─".repeat(Math.max(0, width - 4)), color, PALETTE.rightMuted);
  const nextAction = data.actionMessage ?? data.rightNextAction;
  const lines: SurfaceLine[] = [
    { text: sectionTitle("CONTEXT", data.focusedRegion === "tasks", color, PALETTE.rightDefault) },
    emptyLine(),
    ...data.rightContext.map((row) => renderContextRow(row, color)),
    emptyLine(),
    { text: divider, tone: "muted" },
    emptyLine(),
    { text: "CHECKS" },
    emptyLine(),
    ...data.rightChecks.map((row) => renderCheckRow(row, color)),
    emptyLine(),
    { text: divider, tone: "muted" },
    emptyLine(),
    { text: sectionTitle("ACTIONS", data.focusedRegion === "actions", color, PALETTE.rightDefault) },
    emptyLine(),
    ...data.rightActions.map((row) => renderActionRow(row, width, color)),
    emptyLine(),
    { text: divider, tone: "muted" },
    emptyLine(),
    { text: "NEXT" },
    emptyLine(),
    { text: nextAction },
  ];

  return fitLines(lines, height);
}

function renderTreeRow(row: MockTreeRow, width: number, color: boolean): SurfaceLine {
  const indent = " ".repeat(row.indent ?? 0);
  const dot = row.accentDot ? " ●" : "";
  const status = row.status ? ` ${row.status}` : "";
  const accentDot = row.accentDot ? ` ${green("●", color, row.selected ? PALETTE.leftSelected : PALETTE.leftDefault)}` : "";
  const visibleWidth = width - stringWidth(status) - stringWidth(dot);
  const label = row.focused && !row.selected ? sectionTitle(row.text, true, color, PALETTE.leftDefault) : row.text;
  const base = pad(`${indent}${label}`, Math.max(0, visibleWidth));
  const text = `${base}${status}${accentDot}`;

  if (row.selected) {
    return { text, tone: "selected" };
  }

  if (row.muted) {
    return { text, tone: "muted" };
  }

  return { text };
}

function renderRunnerRow(runner: MockRunnerRow): SurfaceLine {
  return {
    text: `${runner.name.padEnd(8, " ")} ${runner.meter} ${runner.count}`,
  };
}

function renderTabLine(tabs: MockTab[], color: boolean): string {
  return tabs
    .map((tab) => {
      if (tab.active) {
        return green(tab.label, color, PALETTE.centerDefault);
      }

      return muted(tab.label, color, PALETTE.centerDefault);
    })
    .join("   ");
}

function renderContextRow(row: MockContextRow, color: boolean): SurfaceLine {
  return {
    text: `${row.label.padEnd(8, " ")}  ${row.mutedValue ? muted(row.value, color, PALETTE.rightDefault) : row.value}`,
  };
}

function renderCheckRow(row: MockCheckRow, color: boolean): SurfaceLine {
  const status = row.success ? green(row.status, color, PALETTE.rightDefault) : muted(row.status, color, PALETTE.rightDefault);
  const result = row.success ? row.result.padEnd(8, " ") : muted(row.result.padEnd(8, " "), color, PALETTE.rightDefault);
  const duration = row.success ? row.duration : muted(row.duration, color, PALETTE.rightDefault);

  return {
    text: `${status} ${row.label.padEnd(14, " ")}  ${result} ${duration}`,
  };
}

function renderActionRow(row: MockActionRow, width: number, color: boolean): SurfaceLine {
  const prefix = row.selected ? green("▸", color, PALETTE.rightSelected) : " ";
  const shortcutWidth = Math.max(0, width - 6);
  const content = `${prefix}  ${row.label.padEnd(shortcutWidth, " ")}${row.shortcut}`;
  return {
    text: content,
    tone: row.selected ? "selected" : "default",
  };
}

function sectionTitle(text: string, focused: boolean, color: boolean, base: PaletteColor): string {
  return focused ? green(text, color, base) : text;
}

function renderSurfaceSegment(
  line: SurfaceLine,
  width: number,
  color: boolean,
  panel: "left" | "center" | "right",
): string {
  const palette = getPanelPalette(panel, line.tone ?? "default");
  if (panel === "left") {
    if (line.fullBleed) {
      return fillSurface(pad(line.text, width), color, palette);
    }

    const contentWidth = width - LEFT_PANEL_INSET - LEFT_PANEL_GUTTER;
    const text = `${" ".repeat(LEFT_PANEL_INSET)}${pad(line.text, contentWidth)}${" ".repeat(LEFT_PANEL_GUTTER)}`;
    return fillSurface(text, color, palette);
  }

  const inset = "  ";
  return fillSurface(pad(`${inset}${line.text}`, width), color, palette);
}

function getPanelPalette(panel: "left" | "center" | "right", tone: SurfaceLine["tone"]): PaletteColor {
  if (panel === "left") {
    if (tone === "selected") {
      return PALETTE.leftSelected;
    }
    if (tone === "muted") {
      return PALETTE.leftMuted;
    }
    return PALETTE.leftDefault;
  }

  if (panel === "right") {
    if (tone === "selected") {
      return PALETTE.rightSelected;
    }
    if (tone === "muted") {
      return PALETTE.rightMuted;
    }
    return PALETTE.rightDefault;
  }

  if (tone === "muted") {
    return PALETTE.centerMuted;
  }

  return PALETTE.centerDefault;
}

function fitLines(lines: SurfaceLine[], height: number): SurfaceLine[] {
  const clamped = lines.slice(0, height);

  while (clamped.length < height) {
    clamped.push(emptyLine());
  }

  return clamped;
}

function emptyLine(): SurfaceLine {
  return { text: "" };
}

function findTabOffset(tabs: MockTab[]): number {
  let offset = 0;

  for (const tab of tabs) {
    if (tab.active) {
      return offset;
    }

    offset += tab.label.length + 3;
  }

  return 0;
}

function centerText(value: string, width: number): string {
  const visible = Math.max(0, width - stringWidth(value));
  const left = Math.floor(visible / 2);
  const right = visible - left;
  return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
}

function pad(value: string, width: number): string {
  const visibleWidth = stringWidth(value);
  if (visibleWidth >= width) {
    return truncate(value, width);
  }

  return value + " ".repeat(width - visibleWidth);
}

function truncate(value: string, width: number): string {
  if (stringWidth(value) <= width) {
    return value;
  }

  const plain = stripAnsi(value);
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

function stringWidth(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function fillSurface(value: string, color: boolean, palette: PaletteColor): string {
  if (!color) {
    return value;
  }

  return `${toAnsi(palette)}${value}${RESET}`;
}

function toAnsi(palette: PaletteColor): string {
  const codes: string[] = [];

  if (palette.fg) {
    codes.push(`38;2;${hexToRgb(palette.fg).join(";")}`);
  }

  if (palette.bg) {
    codes.push(`48;2;${hexToRgb(palette.bg).join(";")}`);
  }

  return `\u001B[${codes.join(";")}m`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function green(value: string, color: boolean, base: PaletteColor): string {
  return inlineColor(value, color, PALETTE.accent.fg, base);
}

function muted(value: string, color: boolean, base: PaletteColor): string {
  return inlineColor(value, color, PALETTE.rightMuted.fg, base);
}

function inlineColor(value: string, color: boolean, fg: string, base: PaletteColor): string {
  if (!color) {
    return value;
  }

  const inlinePalette: PaletteColor = base.bg ? { fg, bg: base.bg } : { fg };
  return `${toAnsi(inlinePalette)}${value}${toAnsi(base)}`;
}
