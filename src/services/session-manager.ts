/* eslint-disable no-unused-vars */
import type { CraigPaths } from "../state/craig-paths.js";
import { readSessionRuntime, writeSessionRuntime } from "../state/runtime-store.js";
import { writeSession } from "../state/session-store.js";
import type { SessionRecord, SessionSnapshot } from "../types/session.js";
import { runCommandAllowingFailure } from "../utils/exec.js";
import {
  allocateTaskPane,
  enablePaneLogging,
  ensureCraigWorkspace,
  focusPane,
  getSessionNameForRepo,
} from "./tmux-session.js";

export interface SessionManager {
  create(...args: [CraigPaths, CreateSessionInput]): Promise<SessionRecord>;
  attach(...args: [CraigPaths, SessionRecord, string]): Promise<SessionRecord>;
  resize(...args: [string, { columns: number; rows: number }]): Promise<void>;
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
    const workspace = await ensureCraigWorkspace(input.repoRoot);
    const runtime = await readSessionRuntime({ sessionFile: paths.sessionFile });
    const pane = await allocateTaskPane(input.repoRoot, input.worktreePath, [
      {
        pageNumber: 1,
        windowTarget: workspace.primaryWindowTarget,
        isPrimary: true,
      },
      ...(runtime?.managedPages.filter((page) => !page.isPrimary) ?? []),
    ]);

    if (input.logPath) {
      await enablePaneLogging(pane.paneId, input.logPath, input.repoRoot);
    }

    await writeSessionRuntime(
      { sessionFile: paths.sessionFile },
      {
        sessionName: workspace.sessionName,
        controlPaneTarget: workspace.controlPaneTarget,
        primaryWindowTarget: workspace.primaryWindowTarget,
        managedPages: dedupePages([
          {
            pageNumber: 1,
            windowTarget: workspace.primaryWindowTarget,
            isPrimary: true,
          },
          ...(runtime?.managedPages ?? []),
          {
            pageNumber: pane.pageNumber,
            windowTarget: pane.windowTarget,
            isPrimary: pane.pageNumber === 1,
          },
        ]),
        ui: runtime?.ui ?? {
          selectedTaskId: null,
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "",
          lastOutputLines: [],
        },
        updatedAt: new Date().toISOString(),
      },
    );

    const snapshot = await createSnapshot({
      paneId: pane.persistedTarget,
      windowTarget: pane.windowTarget,
      pageNumber: pane.pageNumber,
      layoutSlot: pane.layoutSlot,
      alive: true,
    });
    const session: SessionRecord = {
      id: input.sessionId,
      taskId: input.taskId,
      repoId: input.repoId,
      workspaceId: input.workspaceId,
      substrate: "tmux",
      sessionName: getSessionNameForRepo(input.repoRoot),
      paneId: pane.persistedTarget,
      windowTarget: pane.windowTarget,
      pageNumber: pane.pageNumber,
      layoutSlot: pane.layoutSlot,
      worktreePath: input.worktreePath,
      logPath: input.logPath,
      command: input.command,
      status: "starting",
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      lastAttachedAt: null,
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

    await focusPane(repoRoot, session.paneId, session.windowTarget);
    const attached: SessionRecord = {
      ...session,
      status: "running",
      lastAttachedAt: new Date().toISOString(),
      snapshot,
    };
    await writeSession(paths, attached);
    return attached;
  },

  async resize() {
    return;
  },

  async write() {
    throw new Error("Direct session writes are deferred until RFC 1.3.");
  },

  async read() {
    throw new Error("Direct session reads are deferred until RFC 1.3.");
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
          pageNumber: session.pageNumber,
          layoutSlot: session.layoutSlot,
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
    pageNumber: session.pageNumber,
    layoutSlot: session.layoutSlot,
    alive: result.exitCode === 0 && result.stdout.split(/\s+/).some((entry) => entry.trim() === session.paneId),
  });
}

async function createSnapshot(input: {
  paneId: string;
  windowTarget: string | null;
  pageNumber: number | null;
  layoutSlot: number | null;
  alive: boolean;
}): Promise<SessionSnapshot> {
  return {
    paneId: input.paneId,
    windowTarget: input.windowTarget,
    pageNumber: input.pageNumber,
    layoutSlot: input.layoutSlot,
    alive: input.alive,
    capturedAt: new Date().toISOString(),
  };
}

function dedupePages(
  pages: Array<{ pageNumber: number; windowTarget: string; isPrimary: boolean }>,
): Array<{ pageNumber: number; windowTarget: string; isPrimary: boolean }> {
  const map = new Map<number, { pageNumber: number; windowTarget: string; isPrimary: boolean }>();

  for (const page of pages) {
    map.set(page.pageNumber, page);
  }

  return [...map.values()].sort((left, right) => left.pageNumber - right.pageNumber);
}
