import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { SessionRecord } from "../../../types/session.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../state/atomic-write.js";
import { validateSessionRecord } from "../../../state/session-store.js";

export { validateSessionRecord };

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
