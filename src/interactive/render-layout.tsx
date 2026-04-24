import React from "react";
import { Box, Text } from "ink";

import type { TaskPullRequestCheck, TaskRecord, TaskStatus } from "../types/task.js";
import type { CraigContextTab, CraigUiRuntime, OverlayMode, RepoRecord, WorkspaceRecord } from "../types/workspace.js";

export const FULL_LAYOUT_MIN = { columns: 160, rows: 48 };
export const COMPACT_LAYOUT_MIN = { columns: 120, rows: 36 };

export type ViewportMode = "full" | "compact" | "too-small";

interface CraigScreenProps {
  workspaceRoot: string;
  repos: RepoRecord[];
  workspaces: WorkspaceRecord[];
  archivedWorkspaces: WorkspaceRecord[];
  tasks: TaskRecord[];
  selectedTask: TaskRecord | null;
  uiState: CraigUiRuntime;
  overlayMenuIndex: number;
  viewport: {
    columns: number;
    rows: number;
  };
}

const APP_VERSION = "v0.1.0";
const OVERLAY_MENU_ITEMS = ["Start", "Archives", "Exit"] as const;
const FULL_COLUMN_WIDTHS = { left: 33, right: 31 };
const COMPACT_LEFT_WIDTH = 34;
const HEADER_MARGIN_X = 1;
const FRAME_MARGIN_X = 1;
const HEADER_GAP = 1;
const FOOTER_HEIGHT = 1;
const FRAME_SEPARATOR_HEIGHT = 1;
const RIGHT_DRAWER_HEIGHT = 11;
const CENTER_TABS = ["Agent", "Files"] as const;
const RIGHT_TABS = ["summary", "logs", "diff", "files", "review"] as const;
const SCREEN_COLORS = {
  accent: "#7ee787",
  accentMuted: "#4f9d61",
  accentBackground: "#132317",
  accentBackgroundSoft: "#101d13",
  text: "#e5e7eb",
  muted: "#a1a1aa",
  subtle: "#71717a",
  frame: "#3f3f46",
  line: "#27272a",
  blue: "#93c5fd",
  yellow: "#facc15",
  red: "#f87171",
  green: "#86efac",
  whiteSoft: "#f4f4f5",
};

export function CraigScreen(props: CraigScreenProps): React.ReactElement {
  const viewportMode = getViewportMode(props.viewport);

  if (viewportMode === "too-small") {
    return <ResizeOverlay viewport={props.viewport} />;
  }

  return (
    <ShellScene
      workspaceRoot={props.workspaceRoot}
      repos={props.repos}
      workspaces={props.workspaces}
      archivedWorkspaces={props.archivedWorkspaces}
      tasks={props.tasks}
      selectedTask={props.selectedTask}
      uiState={props.uiState}
      overlayMenuIndex={props.overlayMenuIndex}
      viewport={props.viewport}
      viewportMode={viewportMode}
    />
  );
}

export function getViewportMode(viewport: { columns: number; rows: number }): ViewportMode {
  if (viewport.columns >= FULL_LAYOUT_MIN.columns && viewport.rows >= FULL_LAYOUT_MIN.rows) {
    return "full";
  }

  if (viewport.columns >= COMPACT_LAYOUT_MIN.columns && viewport.rows >= COMPACT_LAYOUT_MIN.rows) {
    return "compact";
  }

  return "too-small";
}

function ShellScene(props: CraigScreenProps & { viewportMode: Exclude<ViewportMode, "too-small"> }): React.ReactElement {
  const overlayActive = props.uiState.activeSurface === "overlay";
  const frameOuterWidth = Math.max(60, props.viewport.columns - FRAME_MARGIN_X * 2);
  const frameOuterHeight = Math.max(20, props.viewport.rows - HEADER_GAP - 1);
  const frameInnerWidth = frameOuterWidth - 2;
  const frameInnerHeight = frameOuterHeight - 2;
  const bodyHeight = Math.max(14, frameInnerHeight - FRAME_SEPARATOR_HEIGHT - FOOTER_HEIGHT);
  const footerWidth = frameInnerWidth;
  const leftWidth = props.viewportMode === "full" ? FULL_COLUMN_WIDTHS.left : COMPACT_LEFT_WIDTH;
  const centerWidth =
    props.viewportMode === "full"
      ? Math.max(54, frameInnerWidth - FULL_COLUMN_WIDTHS.left - FULL_COLUMN_WIDTHS.right)
      : Math.max(40, frameInnerWidth - COMPACT_LEFT_WIDTH);
  const rightWidth =
    props.viewportMode === "full" ? FULL_COLUMN_WIDTHS.right : 0;

  return (
    <Box width={props.viewport.columns} height={props.viewport.rows} flexDirection="column">
      <HeaderBar
        workspaceRoot={props.workspaceRoot}
        taskCount={props.tasks.length}
        uiState={props.uiState}
        dimmed={overlayActive}
      />
      <Box marginTop={HEADER_GAP} marginX={FRAME_MARGIN_X}>
        <Box
          width={frameOuterWidth}
          height={frameOuterHeight}
          borderStyle="round"
          borderColor={SCREEN_COLORS.frame}
          flexDirection="column"
        >
          {overlayActive ? (
            <OverlaySurface
              width={frameInnerWidth}
              height={bodyHeight}
              overlayMode={props.uiState.overlayMode}
              overlayMenuIndex={props.overlayMenuIndex}
              archivedWorkspaces={props.archivedWorkspaces}
            />
          ) : (
            <Box height={bodyHeight} flexDirection="row">
              <TaskRail
                width={leftWidth}
                height={bodyHeight}
                tasks={props.tasks}
                selectedTask={props.selectedTask}
                dimmed={false}
              />
              <CenterStage
                width={centerWidth}
                height={bodyHeight}
                selectedTask={props.selectedTask}
                uiState={props.uiState}
                overlayActive={false}
                overlayMode={props.uiState.overlayMode}
                overlayMenuIndex={props.overlayMenuIndex}
                archivedWorkspaces={props.archivedWorkspaces}
                viewportMode={props.viewportMode}
              />
              {props.viewportMode === "full" ? (
                <ContextRail
                  width={rightWidth}
                  height={bodyHeight}
                  selectedTask={props.selectedTask}
                  uiState={props.uiState}
                  dimmed={false}
                />
              ) : null}
            </Box>
          )}
          <Text color={SCREEN_COLORS.line}>{horizontalRule(footerWidth)}</Text>
          <FooterBar width={footerWidth} compact={props.viewportMode === "compact"} dimmed={overlayActive} />
        </Box>
      </Box>
    </Box>
  );
}

function HeaderBar(props: {
  workspaceRoot: string;
  taskCount: number;
  uiState: CraigUiRuntime;
  dimmed: boolean;
}): React.ReactElement {
  const statusLabel = props.uiState.inputMode === "terminal" ? "LIVE" : "PAUSED";
  const sessionLabel = props.uiState.inputMode === "terminal" ? "Terminal live" : "Agent live";

  return (
    <Box width="100%" paddingX={HEADER_MARGIN_X} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text color={SCREEN_COLORS.accent} dimColor={props.dimmed} bold>
          CRAIG
        </Text>
        <Text color={SCREEN_COLORS.muted} dimColor={props.dimmed} wrap="truncate-end">
          {`  ${formatWorkspacePath(props.workspaceRoot)}  |  ${props.taskCount} ${pluralize("task", props.taskCount)}  |  ${sessionLabel}`}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={SCREEN_COLORS.subtle} dimColor={props.dimmed}>
          {APP_VERSION}
        </Text>
        <Text color={SCREEN_COLORS.subtle} dimColor={props.dimmed}>
          {"   "}
        </Text>
        <Text color={props.uiState.inputMode === "terminal" ? SCREEN_COLORS.accent : SCREEN_COLORS.muted} dimColor={props.dimmed}>
          [{statusLabel}]
        </Text>
        <Text color={SCREEN_COLORS.subtle} dimColor={props.dimmed}>
          {`   ${formatClock(props.uiState.updatedAt)}`}
        </Text>
      </Box>
    </Box>
  );
}

function TaskRail(props: {
  width: number;
  height: number;
  tasks: TaskRecord[];
  selectedTask: TaskRecord | null;
  dimmed: boolean;
}): React.ReactElement {
  const contentWidth = props.width - 1;
  const sectionWidth = Math.max(12, contentWidth - 2);
  const runnersHeight = 10;
  const tasksHeight = Math.max(8, props.height - runnersHeight);
  const taskRows = buildTaskRows(props.tasks, props.selectedTask, Math.max(1, tasksHeight - 6));
  const activeRunner = props.selectedTask?.runner ?? "cursor";

  return (
    <Box
      width={props.width}
      height={props.height}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderRight
      borderColor={SCREEN_COLORS.frame}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
    >
      <Box justifyContent="space-between">
        <SectionLabel text="TASKS" dimmed={props.dimmed} />
        <Text color={SCREEN_COLORS.text} dimColor={props.dimmed}>
          +
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column" minHeight={Math.max(4, taskRows.length * 2)}>
        {taskRows.map((entry) =>
          entry.kind === "ellipsis" ? (
            <Text key="ellipsis" color={SCREEN_COLORS.muted} dimColor={props.dimmed}>
              ...
            </Text>
          ) : (
            <TaskListItem
              key={entry.task.id}
              task={entry.task}
              selected={entry.task.id === props.selectedTask?.id}
              width={sectionWidth}
              dimmed={props.dimmed}
            />
          ),
        )}
      </Box>
      <Box flexGrow={1} />
      <Text color={SCREEN_COLORS.line}>{horizontalRule(sectionWidth)}</Text>
      <Box marginTop={1} flexDirection="column">
        <SectionLabel text="RUNNERS" dimmed={props.dimmed} />
        <Box marginTop={1} flexDirection="column">
          <RunnerRow name="cursor" percent={62} active={activeRunner === "cursor"} dimmed={props.dimmed} width={sectionWidth} />
          <RunnerRow name="codex" percent={28} active={activeRunner === "codex"} dimmed={props.dimmed} width={sectionWidth} />
          <RunnerRow name="shell" percent={12} active={false} dimmed={props.dimmed} width={sectionWidth} />
          <Text color={SCREEN_COLORS.subtle} dimColor={props.dimmed}>
            + Add runner
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function TaskListItem(props: {
  task: TaskRecord;
  selected: boolean;
  width: number;
  dimmed: boolean;
}): React.ReactElement {
  const title = truncate(`${props.task.id}: ${props.task.title}`, Math.max(10, props.width - 4));
  const statusText = getTaskQueueLabel(props.task.status);

  if (props.selected) {
    return (
      <Box marginBottom={1} paddingX={1} paddingY={0} backgroundColor={SCREEN_COLORS.accentBackgroundSoft} flexDirection="column">
        <Text color={SCREEN_COLORS.accent} dimColor={props.dimmed} wrap="truncate-end" bold>
          {`• ${title}`}
        </Text>
        <Text color={SCREEN_COLORS.accentMuted} dimColor={props.dimmed} wrap="truncate-end">
          {`  ${statusText}`}
        </Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text color={SCREEN_COLORS.muted} dimColor={props.dimmed} wrap="truncate-end">
        {`• ${title}`}
      </Text>
      <Text color={SCREEN_COLORS.subtle} dimColor wrap="truncate-end">
        {`  ${statusText}`}
      </Text>
    </Box>
  );
}

function RunnerRow(props: {
  name: string;
  percent: number;
  active: boolean;
  dimmed: boolean;
  width: number;
}): React.ReactElement {
  const barWidth = Math.max(8, Math.min(14, props.width - 18));
  const fillWidth = Math.max(1, Math.round((props.percent / 100) * barWidth));
  const emptyWidth = Math.max(0, barWidth - fillWidth);
  const healthColor = props.percent <= 25 ? SCREEN_COLORS.red : SCREEN_COLORS.accent;
  const labelColor = props.active ? SCREEN_COLORS.green : SCREEN_COLORS.text;

  return (
    <Box width="100%" justifyContent="space-between">
      <Box>
        <Text color={props.active ? SCREEN_COLORS.accent : SCREEN_COLORS.muted} dimColor={props.dimmed}>
          {props.active ? ">" : " "}
        </Text>
        <Text color={labelColor} dimColor={props.dimmed}>
          {` ${props.name}`}
        </Text>
        {props.active ? (
          <Text color={SCREEN_COLORS.accent} dimColor={props.dimmed}>
            {" *"}
          </Text>
        ) : null}
      </Box>
      <Box>
        <Text color={SCREEN_COLORS.frame} dimColor={props.dimmed}>
          [
        </Text>
        <Text color={healthColor} dimColor={props.dimmed}>
          {"█".repeat(fillWidth)}
        </Text>
        <Text backgroundColor={SCREEN_COLORS.line} color={SCREEN_COLORS.line} dimColor={props.dimmed}>
          {" ".repeat(emptyWidth)}
        </Text>
        <Text color={SCREEN_COLORS.frame} dimColor={props.dimmed}>
          ]
        </Text>
        <Text color={healthColor} dimColor={props.dimmed}>
          {` ${props.percent}%`}
        </Text>
      </Box>
    </Box>
  );
}

function CenterStage(props: {
  width: number;
  height: number;
  selectedTask: TaskRecord | null;
  uiState: CraigUiRuntime;
  overlayActive: boolean;
  overlayMode: OverlayMode;
  overlayMenuIndex: number;
  archivedWorkspaces: WorkspaceRecord[];
  viewportMode: Exclude<ViewportMode, "too-small">;
}): React.ReactElement {
  const borderRight = props.viewportMode === "full";
  const contentWidth = props.width - (borderRight ? 1 : 0);

  return (
    <Box
      width={props.width}
      height={props.height}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderRight={borderRight}
      borderColor={SCREEN_COLORS.frame}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
    >
      {props.overlayActive ? (
        <OverlayPanel
          width={Math.max(24, contentWidth - 2)}
          height={Math.max(12, props.height - 2)}
          overlayMode={props.overlayMode}
          overlayMenuIndex={props.overlayMenuIndex}
          archivedWorkspaces={props.archivedWorkspaces}
        />
      ) : (
        <LiveCenterPanel
          width={Math.max(24, contentWidth - 2)}
          height={Math.max(12, props.height - 2)}
          selectedTask={props.selectedTask}
          uiState={props.uiState}
          compact={props.viewportMode === "compact"}
        />
      )}
    </Box>
  );
}

function OverlaySurface(props: {
  width: number;
  height: number;
  overlayMode: OverlayMode;
  overlayMenuIndex: number;
  archivedWorkspaces: WorkspaceRecord[];
}): React.ReactElement {
  return (
    <Box width={props.width} height={props.height} flexDirection="column" paddingX={1} paddingY={1}>
      <OverlayPanel
        width={Math.max(32, props.width - 2)}
        height={Math.max(14, props.height - 2)}
        overlayMode={props.overlayMode}
        overlayMenuIndex={props.overlayMenuIndex}
        archivedWorkspaces={props.archivedWorkspaces}
      />
    </Box>
  );
}

function LiveCenterPanel(props: {
  width: number;
  height: number;
  selectedTask: TaskRecord | null;
  uiState: CraigUiRuntime;
  compact: boolean;
}): React.ReactElement {
  const title = props.selectedTask ? `TASK ${props.selectedTask.id}: ${props.selectedTask.title}` : "TASK No active task selected";
  const availableBodyHeight = props.compact ? Math.max(7, props.height - 9 - RIGHT_DRAWER_HEIGHT) : Math.max(10, props.height - 9);
  const terminalLabel = props.uiState.inputMode === "terminal" ? "Attached terminal session." : "Ask the agent anything...";
  const outputLines =
    props.uiState.outputLines.length > 0
      ? props.uiState.outputLines.slice(-Math.max(4, availableBodyHeight - 4))
      : [terminalLabel];

  return (
    <Box width="100%" height="100%" flexDirection="column">
      <Text color={SCREEN_COLORS.text} wrap="truncate-end" bold>
        {truncate(title, props.width - 2)}
      </Text>
      <Box marginTop={1}>
        <TabStrip tabs={CENTER_TABS} activeIndex={0} width={props.width - 2} />
      </Box>
      <Box marginTop={1}>
        <Box
          width={props.width}
          height={availableBodyHeight}
          borderStyle="round"
          borderColor={SCREEN_COLORS.frame}
          flexDirection="column"
          paddingX={1}
          paddingY={0}
        >
          {outputLines.length === 0 ? (
            <Text color={SCREEN_COLORS.subtle}>{"> Ask the agent anything..."}</Text>
          ) : (
            outputLines.map((line, index) => (
              <Text
                key={`${index}-${line}`}
                color={index === 0 && props.uiState.outputLines.length === 0 ? SCREEN_COLORS.subtle : SCREEN_COLORS.text}
                wrap="truncate-end"
              >
                {index === 0 && props.uiState.outputLines.length === 0 ? `> ${line}` : line}
              </Text>
            ))
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        <CommandInputBar width={props.width} commandBuffer={props.uiState.commandBuffer} />
      </Box>
      {props.compact ? (
        <CompactContextDrawer
          width={props.width}
          height={RIGHT_DRAWER_HEIGHT}
          selectedTask={props.selectedTask}
          uiState={props.uiState}
          open={props.uiState.panelFocus === "right"}
        />
      ) : null}
    </Box>
  );
}

function OverlayPanel(props: {
  width: number;
  height: number;
  overlayMode: OverlayMode;
  overlayMenuIndex: number;
  archivedWorkspaces: WorkspaceRecord[];
}): React.ReactElement {
  const cardWidth = Math.min(Math.max(52, Math.floor(props.width * 0.56)), Math.max(52, props.width - 6));
  const cardHeight = Math.min(Math.max(24, Math.floor(props.height * 0.86)), Math.max(20, props.height - 1));
  const archives = props.archivedWorkspaces.slice(0, 4);
  const overlayTagline = "c r A I g   i s   t h a t   y o u ?";

  return (
    <Box width="100%" height="100%" justifyContent="center" alignItems="center">
      <Box
        width={cardWidth}
        height={cardHeight}
        flexDirection="column"
        paddingX={3}
        paddingY={1}
      >
        {props.overlayMode === "archives" ? (
          <Box flexDirection="column" marginTop={2}>
            <Box alignItems="center" justifyContent="center">
              <Text color={SCREEN_COLORS.accent} bold>
                ARCHIVES
              </Text>
            </Box>
            <Box marginTop={1} alignItems="center" justifyContent="center">
              <Text color={SCREEN_COLORS.muted}>Resume an archived workspace.</Text>
            </Box>
            <Box marginTop={2} flexDirection="column">
              {archives.length > 0 ? (
                archives.map((workspace) => (
                  <Text key={workspace.id} color={SCREEN_COLORS.text} wrap="truncate-end">
                    {truncate(`${workspace.id}  ${workspace.branch}`, cardWidth - 6)}
                  </Text>
                ))
              ) : (
                <Text color={SCREEN_COLORS.subtle}>No archived workspaces.</Text>
              )}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" alignItems="center" marginTop={3}>
            <OverlayLogo />
            <Box marginTop={1}>
              <Text color={SCREEN_COLORS.accent} wrap="truncate-end">
                {overlayTagline}
              </Text>
            </Box>
          </Box>
        )}
        <Box height={2} />
        <Box flexDirection="column" alignItems="center">
          {OVERLAY_MENU_ITEMS.map((item, index) => (
            <OverlayMenuItem key={item} label={item} selected={index === props.overlayMenuIndex} />
          ))}
        </Box>
        <Box justifyContent="center" marginTop={1}>
          <Text color={SCREEN_COLORS.muted}>[ ^/v navigate   enter select   esc back ]</Text>
        </Box>
      </Box>
    </Box>
  );
}

function OverlayLogo(): React.ReactElement {
  const lines = [
    "   ▄████▄   ██▀███   ▄▄▄       ██▓  ▄████",
    "  ▒██▀ ▀█  ▓██ ▒ ██▒▒████▄    ▓██▒ ██▒ ▀█▒",
    "  ▒▓█    ▄ ▓██ ░▄█ ▒▒██  ▀█▄  ▒██▒▒██░▄▄▄░",
    "  ▒▓▓▄ ▄██▒▒██▀▀█▄  ░██▄▄▄▄██ ░██░░▓█  ██▓",
    "  ▒ ▓███▀ ░░██▓ ▒██▒ ▓█   ▓██▒░██░░▒▓███▀▒",
    "  ░ ░▒ ▒  ░░ ▒▓ ░▒▓░ ▒▒   ▓▒█░░▓   ░▒   ▒",
    "    ░  ▒     ░▒ ░ ▒░  ▒   ▒▒ ░ ▒ ░  ░   ░",
    "  ░          ░░   ░   ░   ▒    ▒ ░░ ░   ░",
    "  ░ ░         ░           ░  ░ ░        ░",
    "  ░",
  ];

  return (
    <Box flexDirection="column" alignItems="center">
      {lines.map((line, index) => (
        <Text
          key={`${index}-${line}`}
          color={index < 9 ? SCREEN_COLORS.accent : SCREEN_COLORS.accentMuted}
          bold={index < 9}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

function OverlayMenuItem(props: { label: string; selected: boolean }): React.ReactElement {
  if (props.selected) {
    return (
      <Box marginBottom={0}>
        <Text color={SCREEN_COLORS.accent}>{`> ${props.label}`}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={0}>
      <Text color={SCREEN_COLORS.accent}>{props.label}</Text>
    </Box>
  );
}

function CommandInputBar(props: { width: number; commandBuffer: string }): React.ReactElement {
  const placeholder = props.commandBuffer.length > 0 ? props.commandBuffer : "Ask the agent anything...";
  const line = truncate(`> ${placeholder}`, Math.max(10, props.width - 4));

  return (
    <Box width={props.width} borderStyle="round" borderColor={SCREEN_COLORS.frame} paddingX={1}>
      <Text color={props.commandBuffer.length > 0 ? SCREEN_COLORS.text : SCREEN_COLORS.subtle} wrap="truncate-end">
        {line}
      </Text>
    </Box>
  );
}

function CompactContextDrawer(props: {
  width: number;
  height: number;
  selectedTask: TaskRecord | null;
  uiState: CraigUiRuntime;
  open: boolean;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={SCREEN_COLORS.muted} wrap="truncate-end">
        {`Context tabs: ${RIGHT_TABS.join(" | ")}`}
      </Text>
      {props.open ? (
        <Box
          marginTop={1}
          width={props.width}
          height={props.height}
          borderStyle="round"
          borderColor={SCREEN_COLORS.frame}
          flexDirection="column"
          paddingX={1}
          paddingY={0}
        >
          <Text color={SCREEN_COLORS.whiteSoft} bold>
            {`Context Drawer (${props.uiState.rightContextTab})`}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {renderTaskContext(props.selectedTask, props.uiState.rightContextTab, props.width - 4)}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function ContextRail(props: {
  width: number;
  height: number;
  selectedTask: TaskRecord | null;
  uiState: CraigUiRuntime;
  dimmed: boolean;
}): React.ReactElement {
  const contentWidth = props.width - 2;
  const actionButtonWidth = Math.max(12, Math.floor((contentWidth - 3) / 2));
  const activeTopTab = mapRightRailTab(props.uiState.rightContextTab);
  const checks = buildCheckRows(props.selectedTask);
  const diffLines = buildDiffLines(props.selectedTask, props.uiState.rightContextTab, contentWidth);

  return (
    <Box width={props.width} height={props.height} flexDirection="column" paddingX={1} paddingY={1}>
      <TabStrip tabs={["Diff", "Checks", "PR"]} activeIndex={activeTopTab} width={contentWidth} />
      <Box marginTop={1} flexDirection="column">
        {diffLines.map((line, index) => (
          <Text
            key={`${index}-${line.text}`}
            color={line.color}
            dimColor={props.dimmed}
            wrap="truncate-end"
          >
            {line.text}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={SCREEN_COLORS.line}>{horizontalRule(contentWidth)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <SectionLabel text="ACTIONS" dimmed={props.dimmed} />
        <Box marginTop={1} justifyContent="space-between">
          <ActionButton label="Commit" width={actionButtonWidth} />
          <ActionButton label="Push" width={actionButtonWidth} />
        </Box>
        <Box marginTop={1}>
          <ActionButton label="Create PR" width={contentWidth} accent />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={SCREEN_COLORS.line}>{horizontalRule(contentWidth)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <SectionLabel text="CHECKS" dimmed={props.dimmed} />
        <Box marginTop={1} flexDirection="column">
          {checks.map((check) => (
            <CheckRow key={check.name} name={check.name} status={check.status} duration={check.duration} dimmed={props.dimmed} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function ActionButton(props: { label: string; width: number; accent?: boolean }): React.ReactElement {
  return (
    <Box
      width={props.width}
      justifyContent="center"
      borderStyle="round"
      borderColor={props.accent ? SCREEN_COLORS.blue : SCREEN_COLORS.frame}
      paddingX={1}
      paddingY={0}
    >
      <Text color={props.accent ? SCREEN_COLORS.blue : SCREEN_COLORS.whiteSoft} bold={props.accent ?? false}>
        {props.label}
      </Text>
    </Box>
  );
}

function CheckRow(props: {
  name: string;
  status: "pass" | "running" | "pending" | "fail";
  duration: string;
  dimmed: boolean;
}): React.ReactElement {
  const symbol = props.status === "pass" ? "OK" : props.status === "fail" ? "!!" : props.status === "running" ? ".." : "--";
  const color =
    props.status === "pass"
      ? SCREEN_COLORS.green
      : props.status === "fail"
        ? SCREEN_COLORS.red
        : props.status === "running"
          ? SCREEN_COLORS.yellow
          : SCREEN_COLORS.subtle;
  const label =
    props.status === "pass" ? "Pass" : props.status === "fail" ? "Fail" : props.status === "running" ? "Running" : "Pending";

  return (
    <Box width="100%" justifyContent="space-between">
      <Text color={SCREEN_COLORS.whiteSoft} dimColor={props.dimmed}>
        {props.name}
      </Text>
      <Box marginLeft={1}>
        <Text color={color} dimColor={props.dimmed}>
          {`${symbol} ${label}`}
        </Text>
        <Text color={SCREEN_COLORS.subtle} dimColor={props.dimmed}>
          {`  ${props.duration}`}
        </Text>
      </Box>
    </Box>
  );
}

function FooterBar(props: {
  width: number;
  compact: boolean;
  dimmed: boolean;
}): React.ReactElement {
  const leftText = "^/v navigate  enter select  esc menu";
  const rightText = props.compact ? "t toggle panel  r refresh  ? help" : "tab focus  t attach  r refresh  ? help";

  return (
    <Box width={props.width} justifyContent="space-between">
      <Text color={SCREEN_COLORS.muted} dimColor={props.dimmed} wrap="truncate-end">
        {leftText.replaceAll("  ", "  •  ")}
      </Text>
      <Text color={SCREEN_COLORS.muted} dimColor={props.dimmed} wrap="truncate-end">
        {rightText.replaceAll("  ", "  •  ")}
      </Text>
    </Box>
  );
}

function ResizeOverlay(props: {
  viewport: {
    columns: number;
    rows: number;
  };
}): React.ReactElement {
  return (
    <Box width={props.viewport.columns} height={props.viewport.rows} justifyContent="center" alignItems="center">
      <Box
        width={52}
        borderStyle="round"
        borderColor={SCREEN_COLORS.frame}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text color={SCREEN_COLORS.accent} bold>
          CRAIG
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={SCREEN_COLORS.text}>Resize the terminal to continue.</Text>
          <Text color={SCREEN_COLORS.muted}>{`Minimum size: ${COMPACT_LAYOUT_MIN.columns}x${COMPACT_LAYOUT_MIN.rows}`}</Text>
          <Text color={SCREEN_COLORS.muted}>{`Current size: ${props.viewport.columns}x${props.viewport.rows}`}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function TabStrip(props: {
  tabs: readonly string[];
  activeIndex: number;
  width: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        {props.tabs.map((tab, index) => (
          <Text
            key={tab}
            color={index === props.activeIndex ? SCREEN_COLORS.accent : SCREEN_COLORS.muted}
            bold={index === props.activeIndex}
          >
            {index === props.tabs.length - 1 ? tab : `${tab}    `}
          </Text>
        ))}
      </Box>
      <Text color={SCREEN_COLORS.line}>{horizontalRule(Math.max(8, props.width))}</Text>
    </Box>
  );
}

function SectionLabel(props: { text: string; dimmed: boolean }): React.ReactElement {
  return (
    <Text color={SCREEN_COLORS.muted} dimColor={props.dimmed} bold>
      {props.text}
    </Text>
  );
}

function renderTaskContext(task: TaskRecord | null, tab: CraigContextTab, width: number): React.ReactNode {
  if (!task) {
    return <Text color={SCREEN_COLORS.subtle}>No task selected.</Text>;
  }

  if (tab === "summary") {
    return (
      <>
        <Text color={SCREEN_COLORS.text} wrap="truncate-end">
          {truncate(task.title, width)}
        </Text>
        <Text color={SCREEN_COLORS.muted}>{`Status: ${task.status}`}</Text>
        <Text color={SCREEN_COLORS.muted}>{`Branch: ${task.branch}`}</Text>
        <Text color={SCREEN_COLORS.muted}>{`Runner: ${task.runner}`}</Text>
      </>
    );
  }

  if (tab === "logs") {
    return (
      <>
        <Text color={SCREEN_COLORS.text}>Logs</Text>
        <Text color={SCREEN_COLORS.muted} wrap="truncate-end">
          {truncate(task.artifacts.logPath ?? "<none>", width)}
        </Text>
      </>
    );
  }

  if (tab === "diff") {
    return (
      <>
        <Text color={SCREEN_COLORS.text}>Diff</Text>
        <Text color={SCREEN_COLORS.muted}>Use `task diff` for the full patch.</Text>
      </>
    );
  }

  if (tab === "files") {
    return (
      <>
        <Text color={SCREEN_COLORS.text}>Files</Text>
        <Text color={SCREEN_COLORS.muted}>Open the selected task worktree for the full file list.</Text>
      </>
    );
  }

  return (
    <>
      <Text color={SCREEN_COLORS.text}>Review</Text>
      <Text color={SCREEN_COLORS.muted}>Checks, PR state, and pending actions live here.</Text>
    </>
  );
}

function buildTaskRows(tasks: TaskRecord[], selectedTask: TaskRecord | null, maxRows: number): Array<{ kind: "task"; task: TaskRecord } | { kind: "ellipsis" }> {
  if (tasks.length === 0) {
    return [];
  }

  const visibleTasks = tasks.slice(0, maxRows);
  const selectedMissing = selectedTask && !visibleTasks.some((task) => task.id === selectedTask.id);
  const rows = selectedMissing ? [selectedTask, ...visibleTasks.slice(0, Math.max(0, maxRows - 1))] : visibleTasks;
  const deduped = rows.filter((task, index) => rows.findIndex((candidate) => candidate.id === task.id) === index);
  const result: Array<{ kind: "task"; task: TaskRecord } | { kind: "ellipsis" }> = deduped.map((task) => ({
    kind: "task",
    task,
  }));

  if (tasks.length > deduped.length) {
    result.push({ kind: "ellipsis" });
  }

  return result;
}

function buildDiffLines(
  task: TaskRecord | null,
  tab: CraigContextTab,
  width: number,
): Array<{ text: string; color: string }> {
  if (!task) {
    return [{ text: "No task selected.", color: SCREEN_COLORS.subtle }];
  }

  const header = tab === "files" ? "workspace/files.ts" : `${task.repoId.replace(/^repo_/, "apps/")}/Dockerfile`;
  const lines = [
    { text: truncate(header, width), color: SCREEN_COLORS.text },
    { text: "@@ -12,7 +12,9 @@", color: SCREEN_COLORS.subtle },
    { text: "  RUN npm run build", color: SCREEN_COLORS.muted },
    { text: "  RUN npm prune --omit=dev", color: SCREEN_COLORS.muted },
    { text: "", color: SCREEN_COLORS.text },
    {
      text: tab === "review" ? "+ Ensure PR copy reflects current checks" : "+ Include migration sources for runtime",
      color: SCREEN_COLORS.accent,
    },
    { text: "+ COPY drizzle ./drizzle", color: SCREEN_COLORS.accent },
    { text: "+ COPY prisma ./prisma", color: SCREEN_COLORS.accent },
    { text: "", color: SCREEN_COLORS.text },
    { text: '+ CMD ["node", "dist/index.js"]', color: SCREEN_COLORS.muted },
  ];

  return lines.map((line) => ({
    text: line.text.length === 0 ? " " : truncate(line.text, width),
    color: line.color,
  }));
}

function buildCheckRows(task: TaskRecord | null): Array<{ name: string; status: "pass" | "running" | "pending" | "fail"; duration: string }> {
  const prChecks = task?.pullRequest.requiredChecks ?? [];

  if (prChecks.length > 0) {
    return prChecks.slice(0, 5).map((check, index) => ({
      name: truncate(check.name, 18),
      status: mapPullRequestCheckStatus(check),
      duration: index === 0 ? "5s" : index === 1 ? "7s" : index === 2 ? "12s" : "--",
    }));
  }

  const taskChecks = task?.checks.status ?? "not_run";
  return [
    { name: "Lint", status: taskChecks === "failed" ? "fail" : "pass", duration: "5s" },
    { name: "Typecheck", status: taskChecks === "failed" ? "fail" : "pass", duration: "7s" },
    { name: "Tests", status: taskChecks === "running" ? "running" : taskChecks === "failed" ? "fail" : "pass", duration: "12s" },
    { name: "Build", status: taskChecks === "running" ? "running" : "pending", duration: "18s" },
    { name: "Docker Build", status: "pending", duration: "--" },
  ];
}

function mapPullRequestCheckStatus(check: TaskPullRequestCheck): "pass" | "running" | "pending" | "fail" {
  if (check.status === "success") {
    return "pass";
  }

  if (check.status === "failed") {
    return "fail";
  }

  if (check.conclusion === "success") {
    return "pass";
  }

  if (check.conclusion === "failure") {
    return "fail";
  }

  return "pending";
}

function mapRightRailTab(tab: CraigContextTab): number {
  if (tab === "diff" || tab === "files") {
    return 0;
  }

  if (tab === "review") {
    return 2;
  }

  return 1;
}

function getTaskQueueLabel(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "review":
      return "ready for review";
    case "checked":
      return "checks passed";
    case "pr_open":
      return "pull request open";
    case "merge_ready":
      return "ready to merge";
    case "merged":
      return "merged";
    default:
      return "queued";
  }
}

function formatWorkspacePath(workspaceRoot: string): string {
  const home = process.env.HOME;
  if (home && workspaceRoot.startsWith(home)) {
    return `~${workspaceRoot.slice(home.length)}`;
  }

  return workspaceRoot;
}

function formatClock(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function horizontalRule(width: number): string {
  return "-".repeat(Math.max(1, width));
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}
