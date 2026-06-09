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
import type { FooterToast } from "./state.js";
import { isPtyTab } from "./state.js";

export interface RenderOptions {
  color?: boolean;
  menuIndex?: number;
  optionsMessage?: string | null;
  optionsMenuItems?: string[];
  optionsSubtitle?: string;
  centerOnly?: boolean;
  versionText?: string | null;
  updateText?: string | null;
  errorLogPath?: string;
  errorLogLines?: string[];
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
  rightAlign?: boolean;
}

const BOOT_MENU = ["Start", "Options", "Exit"];
const PAUSE_MENU = ["Resume", "Options", "Exit"];
const LEFT_PANEL_INSET = 2;
const LEFT_PANEL_GUTTER = 2;
export const CENTER_TERMINAL_GUTTER = 2;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_RESET_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:0)?m`, "g");
const OSC8_PATTERN = new RegExp(`${String.fromCharCode(27)}\\]8;;[^${String.fromCharCode(27)}]*${String.fromCharCode(27)}\\\\`, "g");
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const RESET = "\u001B[0m";
const OSC8_END = "\u001B]8;;\u001B\\";
const PALETTE = {
  panelBg:             { bg: "0a0a0a", fg: "c0caf5" },
  panelMuted:          { bg: "0a0a0a", fg: "565f89" },
  panelSelected:       { bg: "1a1b26", fg: "c0caf5" },
  panelFocused:        { bg: "1a1b26", fg: "7aa2f7" },
  divider:             { bg: "0a0a0a", fg: "292e42" },
  rail:                { bg: "0a0a0a", fg: "c0caf5" },
  overlay:             { bg: "06060f", fg: "565f89" },
  overlayTitle:        { bg: "06060f", fg: "565f89" },
  overlayLogo:         { bg: "06060f", fg: "9ece6a" },
  overlaySubtitle:     { bg: "06060f", fg: "41a6b5" },
  overlayMenuSelected: { bg: "06060f", fg: "7aa2f7" },
  accent:              { fg: "7aa2f7" },
  success:             { fg: "9ece6a" },
  pending:             { fg: "e0af68" },
  error:               { fg: "f7768e" },
  mutedfg:             { fg: "565f89" },
  disabled:            { fg: "3b4261" },
} as const;

export function renderBootOverlayFrame(viewport: Viewport, options: RenderOptions = {}): string {
  return renderOverlayFrame(viewport, {
    subtitle: "crAIg is that you?",
    menuItems: BOOT_MENU,
    menuIndex: options.menuIndex ?? 0,
    optionsMessage: options.optionsMessage ?? null,
    color: options.color ?? true,
    versionText: options.versionText ?? null,
    updateText: options.updateText ?? null,
  });
}

export function renderPauseOverlayFrame(viewport: Viewport, options: RenderOptions = {}): string {
  return renderOverlayFrame(viewport, {
    subtitle: "Control mode is paused.",
    menuItems: PAUSE_MENU,
    menuIndex: options.menuIndex ?? 0,
    optionsMessage: options.optionsMessage ?? null,
    color: options.color ?? true,
    versionText: options.versionText ?? null,
    updateText: options.updateText ?? null,
  });
}

const HELP_LINES = [
  "  GLOBAL                     CENTER PANEL              INSPECTOR",
  "  ?     help                 ←→ / hl   switch tab      ↑↓ / jk   navigate",
  "  Esc   pause / back         +         new tab          ←→ / hl   switch mode",
  "  Tab   cycle panels         a         codex tab        R         sync PR",
  "  q     quit                 t         terminal tab     R         sync PR",
  "                             x         close tab        X         close task",
  "  TASKS                      Enter     attach PTY       X         close task",
  "  ↑↓ / jk   navigate",
  "  n          new task        TERMINAL MODE",
  "  Enter      attach          Ctrl+]   return to control mode",
  "                             Wheel / PgUp / PgDn   scroll",
  "",
  "  Press Esc to return.",
];

const OPTIONS_MENU = ["Help"];

export function renderOptionsOverlayFrame(viewport: Viewport, options: RenderOptions = {}): string {
  return renderOverlayFrame(viewport, {
    subtitle: options.optionsSubtitle ?? "Configuration",
    menuItems: options.optionsMenuItems ?? OPTIONS_MENU,
    menuIndex: options.menuIndex ?? 0,
    optionsMessage: options.optionsMessage ?? null,
    color: options.color ?? true,
  });
}

export function renderHelpOverlayFrame(viewport: Viewport, options: Pick<RenderOptions, "color"> = {}): string {
  const color = options.color ?? true;
  const bg = PALETTE.overlay;
  const lines = new Array<string>(viewport.height).fill(fillSurface(" ".repeat(viewport.width), color, bg));
  const logo = getBannerArtLines();
  const logoStart = Math.max(1, Math.floor((viewport.height - logo.length - 2 - HELP_LINES.length) / 2));

  for (let index = 0; index < logo.length; index += 1) {
    if (logoStart + index >= viewport.height) break;
    lines[logoStart + index] = fillSurface(centerText(logo[index] ?? "", viewport.width), color, PALETTE.overlayLogo);
  }

  const tableWidth = Math.max(...HELP_LINES.map((l) => l.length));
  const tableLeftPad = Math.max(0, Math.floor((viewport.width - tableWidth) / 2));
  const tableStart = logoStart + logo.length + 2;
  for (let index = 0; index < HELP_LINES.length; index += 1) {
    const row = tableStart + index;
    if (row >= viewport.height) break;
    const text = HELP_LINES[index] ?? "";
    lines[row] = fillSurface(pad(" ".repeat(tableLeftPad) + text, viewport.width), color, bg);
  }

  return lines.join("\n");
}

export function renderErrorLogOverlayFrame(
  viewport: Viewport,
  options: Pick<RenderOptions, "color" | "errorLogPath" | "errorLogLines"> = {},
): string {
  const color = options.color ?? true;
  const bg = PALETTE.overlay;
  const lines = new Array<string>(viewport.height).fill(fillSurface(" ".repeat(viewport.width), color, bg));
  const title = "Error Log";
  const pathLabel = options.errorLogPath ?? "";
  const logLines = options.errorLogLines ?? [];
  const bodyWidth = Math.max(20, viewport.width - 8);
  const leftPad = Math.max(0, Math.floor((viewport.width - bodyWidth) / 2));
  const content: SurfaceLine[] = [
    { text: title, tone: "selected" },
    { text: pathLabel, tone: "muted" },
    emptyLine(),
    ...(logLines.length > 0
      ? logLines.map((line) => ({ text: line }))
      : [{ text: "No Craig errors have been logged.", tone: "muted" as const }]),
    emptyLine(),
    { text: "Esc returns to Options.", tone: "muted" },
  ];
  const fitted = fitLines(content, viewport.height - 2);
  const startLine = Math.max(1, Math.floor((viewport.height - fitted.length) / 2));

  for (let index = 0; index < fitted.length; index += 1) {
    const row = startLine + index;
    if (row >= viewport.height) break;
    const entry = fitted[index] ?? emptyLine();
    const text = `${" ".repeat(leftPad)}${clipStringToWidth(entry.text, bodyWidth)}`;
    const palette = entry.tone === "selected"
      ? PALETTE.overlayMenuSelected
      : entry.tone === "muted"
        ? PALETTE.overlay
        : PALETTE.panelBg;
    lines[row] = fillSurface(pad(text, viewport.width), color, palette);
  }

  return lines.join("\n");
}

export function renderMainShellFrame(
  viewport: Viewport,
  data: ShellData,
  options: Pick<RenderOptions, "color" | "centerOnly"> = {},
): string {
  const color = options.color ?? true;
  const leftWidth = SHELL_LAYOUT.leftWidth;
  const rightWidth = SHELL_LAYOUT.rightWidth;
  const dividerWidth = SHELL_LAYOUT.dividerWidth;
  const centerOnly = options.centerOnly ?? false;
  const centerWidth = centerOnly ? viewport.width : viewport.width - leftWidth - rightWidth - dividerWidth * 2;
  const bodyHeight = viewport.height - SHELL_LAYOUT.topRailHeight - 1;

  const railText = `CRAIG  |  ${data.topRail.workspacePath}  |  ${data.topRail.agent}`;
  const railTop = fillSurface(pad(railText, viewport.width), color, PALETTE.rail);

  const leftLines = toLeftLines(data, leftWidth - LEFT_PANEL_INSET - LEFT_PANEL_GUTTER, bodyHeight, color);
  const centerLines = toCenterLines(data, centerWidth, bodyHeight, color);
  const rightLines = toRightLines(data, rightWidth, bodyHeight, color);

  const ptyAttached = data.inputMode === "terminal";

  const body: string[] = [];

  for (let index = 0; index < bodyHeight; index += 1) {
    if (centerOnly) {
      body.push(renderSurfaceSegment(centerLines[index] ?? emptyLine(), centerWidth, color, "center"));
      continue;
    }

    const left = renderSurfaceSegment(leftLines[index] ?? emptyLine(), leftWidth, color, "left");
    const leftDivider = fillSurface("│", color, PALETTE.divider);
    const center = renderSurfaceSegment(centerLines[index] ?? emptyLine(), centerWidth, color, "center");
    const divider = fillSurface("│", color, PALETTE.divider);
    const right = renderSurfaceSegment(rightLines[index] ?? emptyLine(), rightWidth, color, "right");
    body.push(`${left}${leftDivider}${center}${divider}${right}`);
  }

  const footerPalette = ptyAttached || data.modalInput ? PALETTE.panelBg : PALETTE.panelMuted;
  const footerLine = renderFooterLine(data.footerText, data.footerToast, viewport.width, color, footerPalette);
  return [railTop, ...body, footerLine].join("\n");
}

function renderFooterLine(footerText: string, footerToast: FooterToast | null, width: number, color: boolean, palette: PaletteColor): string {
  const left = `  ${footerText}`;
  if (!footerToast) {
    return fillSurface(pad(left, width), color, palette);
  }

  const toast = `${footerToast.tone === "error" ? "✗" : "✓"} ${footerToast.message}`;
  const toastWidth = stringWidth(toast);
  const leftWidth = stringWidth(left);
  const gap = Math.max(1, width - leftWidth - toastWidth - 2);
  const visibleLeft = leftWidth + gap + toastWidth + 2 > width
    ? clipStringToWidth(left, Math.max(0, width - toastWidth - 3))
    : left;
  const visibleGap = Math.max(1, width - stringWidth(visibleLeft) - toastWidth - 2);
  const renderedToast = footerToast.tone === "error"
    ? errorText(toast, color, palette)
    : green(toast, color, palette);
  const line = `${visibleLeft}${" ".repeat(visibleGap)}${renderedToast}  `;
  return fillSurface(pad(line, width), color, palette);
}

function renderOverlayFrame(
  viewport: Viewport,
  input: {
    subtitle: string;
    menuItems: string[];
    menuIndex: number;
    optionsMessage: string | null;
    color: boolean;
    versionText?: string | null;
    updateText?: string | null;
  },
): string {
  const lines = new Array<string>(viewport.height).fill(fillSurface(" ".repeat(viewport.width), input.color, PALETTE.overlay));
  const logo = getBannerArtLines();
  const maxMenuLen = Math.max(...input.menuItems.map((s) => s.length));
  const menu = input.menuItems.map((item, index) => `${index === input.menuIndex ? ">" : " "} ${item.padEnd(maxMenuLen)}`);
  const messageLines = input.optionsMessage ? ["", input.optionsMessage] : [];
  const content = [...logo, "", input.subtitle, "", ...menu, ...messageLines];
  const startLine = Math.max(1, Math.floor((viewport.height - content.length) / 2));

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

    const menuOffset = index - (logo.length + 3);
    const isMenuItem = menuOffset >= 0 && menuOffset < input.menuItems.length;
    const itemPalette = isMenuItem && menuOffset === input.menuIndex
      ? PALETTE.overlayMenuSelected
      : PALETTE.overlay;
    lines[startLine + index] = fillSurface(centered, input.color, itemPalette);
  }

  if (input.versionText) {
    const updateSuffix = input.updateText ? "  (update available)" : "";
    const label = `${input.versionText}${updateSuffix}  `;
    const padding = " ".repeat(Math.max(0, viewport.width - stringWidth(label)));
    lines[viewport.height - 1] = fillSurface(
      `${padding}${muted(label, input.color, PALETTE.overlay)}`,
      input.color,
      PALETTE.overlay,
    );
  }

  return lines.join("\n");
}

function toLeftLines(data: ShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const runnerLine = renderRunnersCompact(data.runners);
  const reservedLines = 1; // runner line
  const treeLines = data.leftTree.map((row) => renderTreeRow(row, width, color));
  const fittedTree = fitLines(treeLines, height - reservedLines);
  return [
    ...fittedTree,
    runnerLine,
  ];
}

function toCenterLines(data: ShellData, width: number, height: number, color: boolean): SurfaceLine[] {
  const contentWidth = width - 2; // renderSurfaceSegment prepends a 2-char inset
  const activeTab = data.tabs.find((tab) => tab.active)?.label ?? "AGENT";
  const tabOffset = data.inputMode === "terminal" ? 0 : findTabOffset(data.tabs);
  const underlineWidth = data.inputMode === "terminal" ? contentWidth : activeTab.length + 1;
  const underlineChars = "─".repeat(Math.max(0, underlineWidth));
  const underline = `${" ".repeat(tabOffset)}${data.inputMode === "terminal" ? green(underlineChars, color, PALETTE.panelBg) : accent(underlineChars, color, PALETTE.panelMuted)}`;
  const header = [
    `${accent(data.centerHeader.tabLabel, color, PALETTE.panelBg)}  ${data.centerHeader.taskId}`,
    data.centerHeader.repo,
  ].join(" · ");

  const activeTabId = data.tabs.find((tab) => tab.active)?.id ?? "agent";
  const body = data.centerHeader.tabLabel === "BROWSER" || !isPtyTab(activeTabId)
    ? data.centerTranscript.map((line) => ({ ...line }))
    : renderTerminalSurface(data);
  const tabLineText = renderTabLine(data.tabs, color, data.focusedRegion === "center");
  const ENGAGED_LABEL = " engaged ";
  const ENGAGED_TOTAL_WIDTH = ENGAGED_LABEL.length + 2; // label + dot + trailing space
  const ptyIndicator = data.inputMode === "terminal"
    ? green(`${ENGAGED_LABEL}● `, color, PALETTE.panelBg)
    : "";
  const tabLinePadding = data.inputMode === "terminal"
    ? " ".repeat(Math.max(0, contentWidth - stringWidth(tabLineText) - ENGAGED_TOTAL_WIDTH))
    : "";
  const tabLine: SurfaceLine = {
    text: data.inputMode === "terminal" ? `${tabLineText}${tabLinePadding}${ptyIndicator}` : tabLineText,
  };
  const lines: SurfaceLine[] = [
    tabLine,
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
        { text: "CONTEXT" },
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
  const tone = row.focused || row.selected ? "selected" : row.muted ? "muted" : "default";
  const text = `${prefix}${row.text}`;

  if (row.segments) {
    return {
      text,
      segments: [{ text: prefix }, ...row.segments],
      tone,
    };
  }

  if (row.accentPrefix && !row.muted) {
    const firstSpace = row.text.indexOf(" ");
    const word = firstSpace === -1 ? row.text : row.text.slice(0, firstSpace);
    const rest = firstSpace === -1 ? "" : row.text.slice(firstSpace);
    return {
      text,
      segments: [
        { text: prefix },
        { text: word, style: { fg: "7aa2f7" } },
        { text: rest },
      ],
      tone,
    };
  }

  if (row.color) {
    return {
      text,
      segments: [{ text: prefix }, { text: row.text, style: { fg: row.color } }],
      tone,
    };
  }

  return { text, tone };
}

function renderTreeRow(row: ShellTreeRow, width: number, color: boolean): SurfaceLine {
  const indent = " ".repeat(row.indent ?? 0);
  const dot = row.accentDot ? " ●" : "";
  const status = row.status ? ` ${row.status}` : "";
  const accentDot = row.accentDot ? ` ${green("●", color, row.selected ? PALETTE.panelSelected : PALETTE.panelBg)}` : "";
  const badgeWidth = row.prBadge ? row.prBadge.reduce((acc, seg) => acc + stringWidth(seg.text), 0) : 0;
  const visibleWidth = width - stringWidth(status) - stringWidth(dot) - badgeWidth;
  const label = row.selected
    ? row.text
    : row.focused
      ? green(row.text, color, PALETTE.panelBg)
      : row.panelHeader
        ? accent(row.text, color, PALETTE.panelMuted)
        : row.text;
  const base = pad(`${indent}${label}`, Math.max(0, visibleWidth));
  const tone: SurfaceLine["tone"] = row.selected ? "selected" : row.muted ? "muted" : "default";

  if (row.prBadge) {
    const segments: TerminalRowSegment[] = [{ text: `${base}${status}${accentDot}` }, ...row.prBadge];
    const plainText = `${base}${status}${row.prBadge.map((s) => s.text).join("")}`;
    return { text: plainText, segments, tone };
  }

  const text = `${base}${status}${accentDot}`;
  return { text, tone };
}

function renderRunnersCompact(runners: ShellRunnerRow[]): SurfaceLine {
  const parts = runners.map((runner) => {
    const active = runner.health >= 1.0;
    const count = parseInt(runner.count, 10);
    const countSuffix = count > 1 ? ` (${count})` : "";
    const dot = active ? "●" : "○";
    return { text: `${dot} ${runner.name}${countSuffix}`, active };
  });

  const segments: TerminalRowSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i > 0) segments.push({ text: "  " });
    if (part.active) {
      segments.push({ text: part.text, style: { fg: PALETTE.success.fg } });
    } else {
      segments.push({ text: part.text, style: { fg: PALETTE.panelMuted.fg } });
    }
  }

  return {
    text: parts.map((p) => p.text).join("  "),
    segments,
    tone: "muted",
  };
}

function renderTabLine(tabs: ShellTab[], color: boolean, centerFocused: boolean): string {
  return tabs
    .map((tab) => {
      if (tab.active) {
        return centerFocused
          ? green(tab.label, color, PALETTE.panelBg)
          : accent(tab.label, color, PALETTE.panelBg);
      }

      return muted(tab.label, color, PALETTE.panelBg);
    })
    .join("   ");
}

function renderContextRow(row: ShellContextRow, color: boolean): SurfaceLine {
  return {
    text: `${row.label.padEnd(8, " ")}  ${row.mutedValue ? muted(row.value, color, PALETTE.panelBg) : row.value}`,
  };
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
    if (line.rightAlign) {
      const visLen = stringWidth(lineContent);
      const leftPad = Math.max(0, contentWidth - visLen);
      const text = `${" ".repeat(LEFT_PANEL_INSET)}${" ".repeat(leftPad)}${lineContent}${" ".repeat(LEFT_PANEL_GUTTER)}`;
      return fillSurface(text, color, palette);
    }

    const text = `${" ".repeat(LEFT_PANEL_INSET)}${pad(lineContent, contentWidth)}${" ".repeat(LEFT_PANEL_GUTTER)}`;
    return fillSurface(text, color, palette);
  }

  if (panel === "center" && line.fullBleed) {
    return renderFullBleedCenterLine(line, width, color, palette);
  }

  const inset = "  ";
  return fillSurface(pad(`${inset}${lineContent}`, width), color, palette);
}

function getPanelPalette(_panel: "left" | "center" | "right", tone: SurfaceLine["tone"]): PaletteColor {
  if (tone === "selected" || tone === "focused") {
    return PALETTE.panelSelected;
  }
  if (tone === "muted") {
    return PALETTE.panelMuted;
  }
  return PALETTE.panelBg;
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
  const text = segment.href
    ? `${osc8Start(segment.href)}${segment.text}${OSC8_END}`
    : linkifyUrls(segment.text);
  if (!color || !segment.style) {
    return text;
  }

  return `${toAnsi(terminalStyleToPalette(segment.style, base))}${styleCodes(segment.style)}${text}${RESET}${toAnsi(base)}`;
}

function linkifyUrls(value: string): string {
  return value.replace(URL_PATTERN, (match) => {
    const [url, trailing] = splitTrailingUrlPunctuation(match);
    return `${osc8Start(url)}${url}${OSC8_END}${trailing}`;
  });
}

function splitTrailingUrlPunctuation(value: string): [string, string] {
  let end = value.length;
  while (end > 0 && ".,;:!?)]}".includes(value[end - 1] ?? "")) {
    end -= 1;
  }

  return [value.slice(0, end), value.slice(end)];
}

function osc8Start(url: string): string {
  return `\u001B]8;;${url}\u001B\\`;
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

    const text = clipStringToWidth(segment.text, remaining);
    if (text.length > 0) {
      clipped.push({
        ...segment,
        text,
      });
    }
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
  if (width <= 0) {
    return "";
  }

  if (stringWidth(value) <= width) {
    return value;
  }

  const plain = stripAnsi(value);
  return clipStringToWidth(plain, Math.max(0, width - 1)) + "…";
}

function stringWidth(value: string): number {
  let width = 0;
  for (const character of Array.from(stripAnsi(value))) {
    width += characterWidth(character);
  }

  return width;
}

function clipStringToWidth(value: string, width: number): string {
  let clipped = "";
  let used = 0;

  for (const character of Array.from(value)) {
    const next = characterWidth(character);
    if (used + next > width) {
      break;
    }

    clipped += character;
    used += next;
  }

  return clipped;
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }

  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function stripAnsi(value: string): string {
  return value.replace(OSC8_PATTERN, "").replace(ANSI_ESCAPE_PATTERN, "");
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
  return inlineColor(value, color, PALETTE.success.fg, base);
}

function errorText(value: string, color: boolean, base: PaletteColor): string {
  return inlineColor(value, color, PALETTE.error.fg, base);
}

function accent(value: string, color: boolean, base: PaletteColor): string {
  return inlineColor(value, color, PALETTE.accent.fg, base);
}

function muted(value: string, color: boolean, base: PaletteColor): string {
  return inlineColor(value, color, PALETTE.mutedfg.fg, base);
}

function inlineColor(value: string, color: boolean, fg: string, base: PaletteColor): string {
  if (!color) {
    return value;
  }

  const inlinePalette: PaletteColor = base.bg ? { fg, bg: base.bg } : { fg };
  return `${toAnsi(inlinePalette)}${value}${toAnsi(base)}`;
}
