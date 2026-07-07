import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { SessionRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";

export const readSession = async (paths: CraigPaths, sessionId: string): Promise<SessionRecord> => {
  const raw = await readFile(getSessionFilePath(paths, sessionId), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validateSessionRecord(parsed, getSessionFilePath(paths, sessionId));
};

export const writeSession = async (paths: CraigPaths, session: SessionRecord): Promise<void> => {
  await atomicWriteJson(getSessionFilePath(paths, session.id), {
    ...session,
    updatedAt: new Date().toISOString(),
  });
};

export const deleteSession = async (paths: CraigPaths, sessionId: string): Promise<void> => {
  await rm(getSessionFilePath(paths, sessionId), { force: true });
};

const getSessionFilePath = (paths: CraigPaths, sessionId: string): string => {
  return path.join(paths.sessionsDir, `${sessionId}.json`);
};

export function validateSessionRecord(value: unknown, filePath: string): SessionRecord {
  const candidate = normalizeSessionRecord(value);

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.id !== "string" ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.repoId !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    candidate.substrate !== "tmux" ||
    typeof candidate.sessionName !== "string" ||
    typeof candidate.paneId !== "string" ||
    !(candidate.windowTarget === null || typeof candidate.windowTarget === "string") ||
    typeof candidate.worktreePath !== "string" ||
    !(candidate.logPath === null || typeof candidate.logPath === "string") ||
    !Array.isArray(candidate.command) ||
    !candidate.command.every((entry) => typeof entry === "string") ||
    !["starting", "running", "exited", "failed"].includes(candidate.status) ||
    !(candidate.startedAt === null || typeof candidate.startedAt === "string") ||
    !(candidate.exitedAt === null || typeof candidate.exitedAt === "string") ||
    !(candidate.exitCode === null || typeof candidate.exitCode === "number") ||
    !(candidate.lastAttachedAt === null || typeof candidate.lastAttachedAt === "string") ||
    !isAttachState(candidate.attach) ||
    !isSnapshot(candidate.snapshot) ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    throw new Error(`Craig session record at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`);
  }

  return candidate;
}

function isSnapshot(value: SessionRecord["snapshot"] | undefined): boolean {
  return (
    value === null ||
    (typeof value === "object" &&
      value !== null &&
      typeof value.paneId === "string" &&
      (typeof value.windowTarget === "string" || value.windowTarget === null) &&
      typeof value.alive === "boolean" &&
      typeof value.capturedAt === "string")
  );
}

function isAttachState(value: SessionRecord["attach"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value.detachChord === "ctrl+]" &&
    (value.lastSize === null ||
      (typeof value.lastSize === "object" &&
        value.lastSize !== null &&
        typeof value.lastSize.columns === "number" &&
        typeof value.lastSize.rows === "number"))
  );
}

function normalizeSessionRecord(value: unknown): SessionRecord {
  const candidate = (typeof value === "object" && value !== null ? value : {}) as Partial<SessionRecord> & {
    pageNumber?: number | null;
    layoutSlot?: number | null;
  };

  return {
    id: candidate.id ?? "",
    taskId: candidate.taskId ?? "",
    repoId: candidate.repoId ?? "",
    workspaceId: candidate.workspaceId ?? "",
    substrate: candidate.substrate ?? "tmux",
    sessionName: candidate.sessionName ?? "",
    paneId: candidate.paneId ?? "",
    windowTarget: typeof candidate.windowTarget === "string" ? candidate.windowTarget : null,
    worktreePath: candidate.worktreePath ?? "",
    logPath: typeof candidate.logPath === "string" ? candidate.logPath : null,
    command: Array.isArray(candidate.command) ? candidate.command.filter((entry): entry is string => typeof entry === "string") : [],
    status: candidate.status ?? "starting",
    startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : null,
    exitedAt: typeof candidate.exitedAt === "string" ? candidate.exitedAt : null,
    exitCode: typeof candidate.exitCode === "number" ? candidate.exitCode : null,
    lastAttachedAt: typeof candidate.lastAttachedAt === "string" ? candidate.lastAttachedAt : null,
    attach: {
      detachChord: "ctrl+]",
      lastSize:
        typeof candidate.attach === "object" &&
        candidate.attach !== null &&
        candidate.attach.lastSize &&
        typeof candidate.attach.lastSize.columns === "number" &&
        typeof candidate.attach.lastSize.rows === "number"
          ? candidate.attach.lastSize
          : null,
    },
    snapshot:
      candidate.snapshot && typeof candidate.snapshot === "object"
        ? {
            paneId: typeof candidate.snapshot.paneId === "string" ? candidate.snapshot.paneId : candidate.paneId ?? "",
            windowTarget:
              typeof candidate.snapshot.windowTarget === "string" ? candidate.snapshot.windowTarget : null,
            alive: Boolean(candidate.snapshot.alive),
            capturedAt:
              typeof candidate.snapshot.capturedAt === "string"
                ? candidate.snapshot.capturedAt
                : new Date().toISOString(),
          }
        : null,
    createdAt: candidate.createdAt ?? "",
    updatedAt: candidate.updatedAt ?? "",
  };
}
