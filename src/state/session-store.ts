import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { SessionRecord } from "../types/session.js";
import type { CraigPaths } from "./craig-paths.js";
import { atomicWriteJson } from "./atomic-write.js";

export async function readSession(paths: CraigPaths, sessionId: string): Promise<SessionRecord> {
  const raw = await readFile(getSessionFilePath(paths, sessionId), "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return validateSessionRecord(parsed, getSessionFilePath(paths, sessionId));
}

export async function writeSession(paths: CraigPaths, session: SessionRecord): Promise<void> {
  await atomicWriteJson(getSessionFilePath(paths, session.id), {
    ...session,
    updatedAt: new Date().toISOString(),
  });
}

export async function listSessions(paths: CraigPaths): Promise<SessionRecord[]> {
  const entries = await readdir(paths.sessionsDir, { withFileTypes: true });
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readSession(paths, path.basename(entry.name, ".json"))),
  );

  return sessions.sort((left, right) => left.id.localeCompare(right.id));
}

export async function deleteSession(paths: CraigPaths, sessionId: string): Promise<void> {
  await rm(getSessionFilePath(paths, sessionId), { force: true });
}

function getSessionFilePath(paths: CraigPaths, sessionId: string): string {
  return path.join(paths.sessionsDir, `${sessionId}.json`);
}

export function validateSessionRecord(value: unknown, filePath: string): SessionRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Partial<SessionRecord>).id !== "string" ||
    typeof (value as Partial<SessionRecord>).taskId !== "string" ||
    typeof (value as Partial<SessionRecord>).repoId !== "string" ||
    typeof (value as Partial<SessionRecord>).workspaceId !== "string" ||
    (value as Partial<SessionRecord>).substrate !== "tmux" ||
    typeof (value as Partial<SessionRecord>).sessionName !== "string" ||
    typeof (value as Partial<SessionRecord>).paneId !== "string" ||
    !(
      (value as Partial<SessionRecord>).windowTarget === null ||
      typeof (value as Partial<SessionRecord>).windowTarget === "string"
    ) ||
    !(
      (value as Partial<SessionRecord>).pageNumber === null ||
      typeof (value as Partial<SessionRecord>).pageNumber === "number"
    ) ||
    !(
      (value as Partial<SessionRecord>).layoutSlot === null ||
      typeof (value as Partial<SessionRecord>).layoutSlot === "number"
    ) ||
    typeof (value as Partial<SessionRecord>).worktreePath !== "string" ||
    !(
      (value as Partial<SessionRecord>).logPath === null ||
      typeof (value as Partial<SessionRecord>).logPath === "string"
    ) ||
    !Array.isArray((value as Partial<SessionRecord>).command) ||
    !((value as Partial<SessionRecord>).command ?? []).every((entry) => typeof entry === "string") ||
    !["starting", "running", "exited", "failed"].includes((value as Partial<SessionRecord>).status ?? "") ||
    !(
      (value as Partial<SessionRecord>).startedAt === null ||
      typeof (value as Partial<SessionRecord>).startedAt === "string"
    ) ||
    !(
      (value as Partial<SessionRecord>).exitedAt === null ||
      typeof (value as Partial<SessionRecord>).exitedAt === "string"
    ) ||
    !(
      (value as Partial<SessionRecord>).exitCode === null ||
      typeof (value as Partial<SessionRecord>).exitCode === "number"
    ) ||
    !(
      (value as Partial<SessionRecord>).lastAttachedAt === null ||
      typeof (value as Partial<SessionRecord>).lastAttachedAt === "string"
    ) ||
    !isSnapshot((value as Partial<SessionRecord>).snapshot) ||
    typeof (value as Partial<SessionRecord>).createdAt !== "string" ||
    typeof (value as Partial<SessionRecord>).updatedAt !== "string"
  ) {
    throw new Error(`Craig session record at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`);
  }

  return value as SessionRecord;
}

function isSnapshot(value: SessionRecord["snapshot"] | undefined): boolean {
  return (
    value === null ||
    (typeof value === "object" &&
      value !== null &&
      typeof value.paneId === "string" &&
      (typeof value.windowTarget === "string" || value.windowTarget === null) &&
      (typeof value.pageNumber === "number" || value.pageNumber === null) &&
      (typeof value.layoutSlot === "number" || value.layoutSlot === null) &&
      typeof value.alive === "boolean" &&
      typeof value.capturedAt === "string")
  );
}
