/* eslint-disable no-unused-vars */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { writeSession } from "./session.js";
import type { SessionRecord, SessionSnapshot, SessionTerminalSize } from "../types.js";
import { runCommandAllowingFailure } from "../../../shared/exec.js";
import {
  createDetachedTaskSession,
  enablePaneLogging,
  focusPane,
  getSessionNameForTask,
  resizeSessionWindow,
} from "./tmux.js";
import { requireExecutablePath, withDefaultCommandPath } from "../../../shared/command-path.js";
import { shellEscape } from "../../../shared/shell-escape.js";
import type { TaskRecord } from "../types.js";
import { sendCommandToPane } from "./tmux.js";

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

  async terminate(paths, session, _reason) {
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
      command: session.command,
    };
    await writeSession(paths, terminated);
    return terminated;
  },

  async snapshot(session, repoRoot) {
    return snapshotSession(session, repoRoot);
  },
};

export interface RunnerAdapter {
  prepare(...args: [TaskRecord, { repoRoot: string }]): Promise<void>;
  launch(...args: [TaskRecord, { repoRoot: string; session: SessionRecord; environment?: Record<string, string> }]): Promise<void>;
  status(...args: [TaskRecord, { session: SessionRecord }]): Promise<"starting" | "running" | "exited" | "failed">;
  stop(...args: [TaskRecord, { session: SessionRecord }]): Promise<void>;
  collectArtifacts(...args: [TaskRecord, { session: SessionRecord }]): Promise<void>;
}

export const commandRunnerAdapter: RunnerAdapter = {
  async prepare(task, input) {
    const command = task.runnerSession.command;
    const executable = command[0]!;
    const env = withDefaultCommandPath();
    requireExecutablePath(executable, { cwd: input.repoRoot, env });
  },

  async launch(task, input) {
    const command = task.runnerSession.command;
    const executable = requireExecutablePath(command[0]!, { cwd: task.worktreePath, env: withDefaultCommandPath() });
    const environmentFile = Object.keys(input.environment ?? {}).length > 0
      ? await writeLaunchEnvironment(input.session, input.environment!)
      : null;
    const launchCommand = [executable, ...command.slice(1)].map((part) => shellEscape(part)).join(" ");
    const paneCommand = environmentFile
      ? `. ${shellEscape(environmentFile)} && rm -f ${shellEscape(environmentFile)} && exec ${launchCommand}`
      : `exec ${launchCommand}`;
    try {
      await sendCommandToPane(input.session.paneId, paneCommand, input.repoRoot);
    } catch (error) {
      if (environmentFile) await rm(environmentFile, { force: true }).catch(() => undefined);
      throw error;
    }
  },

  async status(task) {
    return task.runnerSession.lastKnownState;
  },

  async stop() {
    return;
  },

  async collectArtifacts() {
    return;
  },
};

async function writeLaunchEnvironment(session: SessionRecord, environment: Record<string, string>): Promise<string> {
  const directory = path.join(path.dirname(session.logPath ?? session.worktreePath), ".launch-environment");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${session.id}.${randomUUID()}.sh`);
  const payload = Object.entries(environment)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid launch environment variable name: ${key}`);
      return `export ${key}=${shellEscape(value)}`;
    })
    .join("\n");
  await writeFile(file, `${payload}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

const snapshotSession = async (session: SessionRecord, repoRoot: string): Promise<SessionSnapshot> => {
  const result = await runCommandAllowingFailure("tmux", ["list-panes", "-F", "#{pane_id}", "-t", session.paneId], {
    cwd: repoRoot,
  });

  return createSnapshot({
    paneId: session.paneId,
    windowTarget: session.windowTarget,
    alive: result.exitCode === 0 && result.stdout.split(/\s+/).some((entry) => entry.trim() === session.paneId),
  });
};

const createSnapshot = async (input: {
  paneId: string;
  windowTarget: string | null;
  alive: boolean;
}): Promise<SessionSnapshot> => {
  return {
    paneId: input.paneId,
    windowTarget: input.windowTarget,
    alive: input.alive,
    capturedAt: new Date().toISOString(),
  };
};
