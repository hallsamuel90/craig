import { getBannerArtLines } from "../banner.js";
import type {
  ShellContextRow,
  ShellData,
  ShellInspectionRow,
  ShellRunnerRow,
  ShellTab,
  ShellTreeRow,
} from "./shell-data.js";
import { SHELL_LAYOUT, type Viewport } from "./layout.js";
import type { TerminalCellStyle, TerminalRowSegment } from "./terminal-emulator.js";
import { isPtyTab } from "./state.js";

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
  segments?: TerminalRowSegment[];
  tone?: "default" | "muted" | "selected" | "focused";
  fullBleed?: boolean;
}

const BOOT_MENU = ["Start", "Options", "Exit"];
const PAUSE_MENU = ["Resume", "Options", "Exit"];
const LEFT_PANEL_INSET = 2;
const LEFT_PANEL_GUTTER = 2;
export const CENTER_TERMINAL_GUTTER = 2;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const ANSI_RESET_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:0)?m`, "g");
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
  data: ShellData,
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

function toLeftLines(data: ShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const lines: SurfaceLine[] = [
    ...data.leftTree.map((row) => renderTreeRow(row, width, color)),
    emptyLine(),
    { text: "RUNNERS", tone: "muted" },
    emptyLine(),
    ...data.runners.map((runner) => renderRunnerRow(runner)),
    emptyLine(),
  ];

  const fitted = fitLines(lines, height);
  fitted[height - 1] = { text: data.footerText, tone: "muted", fullBleed: true };
  return fitted;
}

function toCenterLines(data: ShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const activeTab = data.tabs.find((tab) => tab.active)?.label ?? "AGENT";
  const tabOffset = findTabOffset(data.tabs);
  const underline = `${" ".repeat(tabOffset)}${green("─".repeat(activeTab.length + 1), color, PALETTE.centerMuted)}`;
  const header = [
    `${green(data.centerHeader.tabLabel, color, PALETTE.centerDefault)}  ${data.centerHeader.taskId}`,
    data.centerHeader.repo,
    data.centerHeader.agent,
  ].join(" · ");

  const activeTabId = data.tabs.find((tab) => tab.active)?.id ?? "agent";
  const body = data.centerHeader.tabLabel === "BROWSER" || !isPtyTab(activeTabId)
    ? data.centerTranscript.map((line) => ({ ...line }))
    : renderTerminalSurface(data);
  const lines: SurfaceLine[] = [
    { text: renderTabLine(data.tabs, color) },
    { text: underline, tone: "muted" },
    { text: header },
    emptyLine(),
    ...body,
  ];

  return fitLines(lines, height);
}

function renderTerminalSurface(data: ShellData): SurfaceLine[] {
  if (data.terminal.error) {
    return [
      { text: "terminal ▸ PTY unavailable" },
      emptyLine(),
      { text: data.terminal.error },
      emptyLine(),
      { text: "Fix the native dependency setup, then re-enter terminal mode." },
    ];
  }

  const activeTabId = data.tabs.find((tab) => tab.active)?.id ?? "";
  const surfaceLabel = activeTabId === "agent" || /:agent(?:-\d+)?$/.test(activeTabId) ? "agent" : "terminal";
  if (data.terminal.rows.length === 0) {
    return [
      { text: `Press Enter on the ${surfaceLabel.toUpperCase()} tab to attach a PTY.` },
    ];
  }

  return data.terminal.rows.map((row) => ({
    text: segmentsToPlainText(row.segments),
    segments: row.segments,
    fullBleed: true,
  }));
}

function toRightLines(data: ShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const topSection = data.rightInspection
    ? renderInspectionSection(
        data.actionMessage
          ? [
              ...data.rightInspection.rows.slice(0, 2),
              { id: "action-message", text: data.actionMessage },
              { id: "action-message-spacer", text: "" },
              ...data.rightInspection.rows.slice(2),
            ]
          : data.rightInspection.rows,
        height,
      )
    : fitLines([
        { text: sectionTitle("CONTEXT", data.focusedRegion === "tasks", color, PALETTE.rightDefault) },
        emptyLine(),
        ...data.rightContext.map((row) => renderContextRow(row, color)),
        ...(data.actionMessage ? [emptyLine(), { text: data.actionMessage }] : []),
      ], height);

  return fitLines(topSection, height);
}

function renderInspectionSection(rows: ShellInspectionRow[], height: number): SurfaceLine[] {
  const modeRows = rows.slice(0, 2);
  const itemRows = rows.slice(2);
  const itemHeight = Math.max(0, height - modeRows.length);
  const selectedIndex = itemRows.findIndex((row) => row.focused || row.selected);
  const start = selectedIndex === -1 ? 0 : clamp(selectedIndex - Math.floor(itemHeight / 2), 0, Math.max(0, itemRows.length - itemHeight));
  return [
    ...modeRows.map((row) => renderInspectionRow(row)),
    ...itemRows.slice(start, start + itemHeight).map((row) => renderInspectionRow(row)),
  ];
}

function renderInspectionRow(row: ShellInspectionRow): SurfaceLine {
  const prefix = row.focused ? "▸ " : row.selected ? "• " : "  ";
  return {
    text: `${prefix}${row.text}`,
    tone: row.focused || row.selected ? "selected" : row.muted ? "muted" : "default",
  };
}

function renderTreeRow(row: ShellTreeRow, width: number, color: boolean): SurfaceLine {
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

function renderRunnerRow(runner: ShellRunnerRow): SurfaceLine {
  return {
    text: `${runner.name.padEnd(8, " ")} ${runner.meter} ${runner.count}`,
  };
}

function renderTabLine(tabs: ShellTab[], color: boolean): string {
  return tabs
    .map((tab) => {
      if (tab.active) {
        return green(tab.label, color, PALETTE.centerDefault);
      }

      return muted(tab.label, color, PALETTE.centerDefault);
    })
    .join("   ");
}

function renderContextRow(row: ShellContextRow, color: boolean): SurfaceLine {
  return {
    text: `${row.label.padEnd(8, " ")}  ${row.mutedValue ? muted(row.value, color, PALETTE.rightDefault) : row.value}`,
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
  const lineContent = renderLineContent(line, color, palette);
  if (panel === "left") {
    if (line.fullBleed) {
      return fillSurface(pad(lineContent, width), color, palette);
    }

    const contentWidth = width - LEFT_PANEL_INSET - LEFT_PANEL_GUTTER;
    const text = `${" ".repeat(LEFT_PANEL_INSET)}${pad(lineContent, contentWidth)}${" ".repeat(LEFT_PANEL_GUTTER)}`;
    return fillSurface(text, color, palette);
  }

  if (panel === "center" && line.fullBleed) {
    return renderFullBleedCenterLine(line, width, color, palette);
  }

  const inset = "  ";
  return fillSurface(pad(`${inset}${lineContent}`, width), color, palette);
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

function renderLineContent(line: SurfaceLine, color: boolean, base: PaletteColor): string {
  if (!line.segments) {
    return line.text;
  }

  return line.segments.map((segment) => renderTerminalSegment(segment, color, base)).join("");
}

function renderFullBleedCenterLine(line: SurfaceLine, width: number, color: boolean, base: PaletteColor): string {
  const gutter = " ".repeat(CENTER_TERMINAL_GUTTER);
  const contentWidth = Math.max(0, width - CENTER_TERMINAL_GUTTER * 2);

  if (!line.segments) {
    return fillSurface(`${gutter}${pad(line.text, contentWidth)}${gutter}`, color, base);
  }

  const paddedSegments = fitTerminalSegmentsToWidth(line.segments, contentWidth);
  const content = `${gutter}${paddedSegments.map((segment) => renderTerminalSegment(segment, color, base)).join("")}${gutter}`;
  return fillSurface(content, color, base);
}

function renderTerminalSegment(segment: TerminalRowSegment, color: boolean, base: PaletteColor): string {
  if (!color || !segment.style) {
    return segment.text;
  }

  return `${toAnsi(terminalStyleToPalette(segment.style, base))}${styleCodes(segment.style)}${segment.text}${RESET}${toAnsi(base)}`;
}

function fitTerminalSegmentsToWidth(segments: TerminalRowSegment[], width: number): TerminalRowSegment[] {
  const clipped = clipTerminalSegmentsToWidth(segments, width);
  return padTerminalSegmentsToWidth(clipped, width);
}

function clipTerminalSegmentsToWidth(segments: TerminalRowSegment[], width: number): TerminalRowSegment[] {
  const clipped: TerminalRowSegment[] = [];
  let remaining = width;

  for (const segment of segments) {
    if (remaining <= 0) {
      break;
    }

    const visibleWidth = stringWidth(segment.text);
    if (visibleWidth <= remaining) {
      clipped.push(segment);
      remaining -= visibleWidth;
      continue;
    }

    clipped.push({
      ...segment,
      text: segment.text.slice(0, remaining),
    });
    remaining = 0;
  }

  return clipped;
}

function padTerminalSegmentsToWidth(segments: TerminalRowSegment[], width: number): TerminalRowSegment[] {
  const visibleWidth = stringWidth(segmentsToPlainText(segments));
  if (visibleWidth >= width) {
    return segments;
  }

  const trailingStyle = segments.at(-1)?.style;
  if (trailingStyle?.bg) {
    return [...segments, { text: " ".repeat(width - visibleWidth), style: trailingStyle }];
  }

  return [...segments, { text: " ".repeat(width - visibleWidth) }];
}

function terminalStyleToPalette(style: TerminalCellStyle, base: PaletteColor): PaletteColor {
  const foreground = style.inverse ? style.bg ?? base.bg : style.fg;
  const background = style.inverse ? style.fg ?? base.fg : style.bg;
  const palette: PaletteColor = {};
  const fg = foreground ?? base.fg;
  const bg = background ?? base.bg;

  if (fg) {
    palette.fg = fg;
  }
  if (bg) {
    palette.bg = bg;
  }

  return palette;
}

function styleCodes(style: TerminalCellStyle): string {
  const codes: string[] = [];

  if (style.bold) {
    codes.push("1");
  }
  if (style.dim) {
    codes.push("2");
  }
  if (style.italic) {
    codes.push("3");
  }
  if (style.underline) {
    codes.push("4");
  }

  return codes.length > 0 ? `\u001B[${codes.join(";")}m` : "";
}

function findTabOffset(tabs: ShellTab[]): number {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function segmentsToPlainText(segments: TerminalRowSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function fillSurface(value: string, color: boolean, palette: PaletteColor): string {
  if (!color) {
    return value;
  }

  const surface = toAnsi(palette);
  const valueWithSurfaceAfterReset = value.replace(ANSI_RESET_PATTERN, `${RESET}${surface}`);
  return `${surface}${valueWithSurfaceAfterReset}${RESET}`;
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
