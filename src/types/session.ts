export type SessionSubstrate = "tmux";
export type SessionStatus = "starting" | "running" | "exited" | "failed";

export interface SessionTerminalSize {
  columns: number;
  rows: number;
}

export interface SessionSnapshot {
  paneId: string;
  windowTarget: string | null;
  alive: boolean;
  capturedAt: string;
}

export interface SessionAttachState {
  detachChord: "ctrl+]";
  lastSize: SessionTerminalSize | null;
}

export interface SessionRecord {
  id: string;
  taskId: string;
  repoId: string;
  workspaceId: string;
  substrate: SessionSubstrate;
  sessionName: string;
  paneId: string;
  windowTarget: string | null;
  worktreePath: string;
  logPath: string | null;
  command: string[];
  status: SessionStatus;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  lastAttachedAt: string | null;
  attach: SessionAttachState;
  snapshot: SessionSnapshot | null;
  createdAt: string;
  updatedAt: string;
}
