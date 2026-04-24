/* eslint-disable no-unused-vars */
import type { CraigPaths } from "../state/craig-paths.js";
import { writeSession } from "../state/session-store.js";
import type { SessionRecord, SessionSnapshot, SessionTerminalSize } from "../types/session.js";
import { runCommandAllowingFailure } from "../utils/exec.js";
import {
  createDetachedTaskSession,
  enablePaneLogging,
  focusPane,
  getSessionNameForTask,
  resizeSessionWindow,
} from "./tmux-session.js";

export interface SessionManager {
  create(...args: [CraigPaths, CreateSessionInput]): Promise<SessionRecord>;
  attach(...args: [CraigPaths, SessionRecord, string]): Promise<SessionRecord>;
  resize(...args: [CraigPaths, SessionRecord, SessionTerminalSize, string]): Promise<SessionRecord>;
  write(...args: [string, string]): Promise<void>;
  read(...args: [string]): Promise<string>;
  terminate(...args: [CraigPaths, SessionRecord, string]): Promise<SessionRecord>;
  snapshot(...args: [SessionRecord, string]): Promise<SessionSnapshot>;
}

export interface CreateSessionInput {
  sessionId: string;
  taskId: string;
  repoId: string;
  workspaceId: string;
  repoRoot: string;
  worktreePath: string;
  logPath: string | null;
  command: string[];
}

export const tmuxSessionManager: SessionManager = {
  async create(paths, input) {
    const provisioned = await createDetachedTaskSession(input.repoRoot, input.taskId, input.worktreePath);

    if (input.logPath) {
      await enablePaneLogging(provisioned.paneId, input.logPath, input.repoRoot);
    }

    const snapshot = await createSnapshot({
      paneId: provisioned.paneId,
      windowTarget: provisioned.windowTarget,
      alive: true,
    });
    const session: SessionRecord = {
      id: input.sessionId,
      taskId: input.taskId,
      repoId: input.repoId,
      workspaceId: input.workspaceId,
      substrate: "tmux",
      sessionName: provisioned.sessionName || getSessionNameForTask(input.repoRoot, input.taskId),
      paneId: provisioned.paneId,
      windowTarget: provisioned.windowTarget,
      worktreePath: input.worktreePath,
      logPath: input.logPath,
      command: input.command,
      status: "starting",
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      lastAttachedAt: null,
      attach: {
        detachChord: "ctrl+]",
        lastSize: null,
      },
      snapshot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await writeSession(paths, session);
    return session;
  },

  async attach(paths, session, repoRoot) {
    const snapshot = await tmuxSessionManager.snapshot(session, repoRoot);

    if (!snapshot.alive) {
      throw new Error(`Session ${session.id} is no longer live and cannot be attached.`);
    }

    await focusPane(repoRoot, session.paneId, session.windowTarget, session.sessionName);
    const attached: SessionRecord = {
      ...session,
      status: "running",
      lastAttachedAt: new Date().toISOString(),
      snapshot,
    };
    await writeSession(paths, attached);
    return attached;
  },

  async resize(paths, session, size, repoRoot) {
    await resizeSessionWindow(repoRoot, session.sessionName, size);
    const resized: SessionRecord = {
      ...session,
      attach: {
        ...session.attach,
        lastSize: size,
      },
    };
    await writeSession(paths, resized);
    return resized;
  },

  async write() {
    throw new Error("Direct session writes are owned by the terminal bridge.");
  },

  async read() {
    throw new Error("Direct session reads are owned by the terminal bridge.");
  },

  async terminate(paths, session, reason) {
    const terminated: SessionRecord = {
      ...session,
      status: "failed",
      exitedAt: new Date().toISOString(),
      snapshot: {
        ...(session.snapshot ?? {
          paneId: session.paneId,
          windowTarget: session.windowTarget,
          alive: false,
          capturedAt: new Date().toISOString(),
        }),
        alive: false,
        capturedAt: new Date().toISOString(),
      },
      command: reason.length > 0 ? session.command : session.command,
    };
    await writeSession(paths, terminated);
    return terminated;
  },

  async snapshot(session, repoRoot) {
    return snapshotSession(session, repoRoot);
  },
};

async function snapshotSession(session: SessionRecord, repoRoot: string): Promise<SessionSnapshot> {
  const result = await runCommandAllowingFailure("tmux", ["list-panes", "-F", "#{pane_id}", "-t", session.paneId], {
    cwd: repoRoot,
  });

  return createSnapshot({
    paneId: session.paneId,
    windowTarget: session.windowTarget,
    alive: result.exitCode === 0 && result.stdout.split(/\s+/).some((entry) => entry.trim() === session.paneId),
  });
}

async function createSnapshot(input: {
  paneId: string;
  windowTarget: string | null;
  alive: boolean;
}): Promise<SessionSnapshot> {
  return {
    paneId: input.paneId,
    windowTarget: input.windowTarget,
    alive: input.alive,
    capturedAt: new Date().toISOString(),
  };
}
