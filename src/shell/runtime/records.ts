import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";

export interface RuntimeRecord {
  schemaVersion: 1;
  role: "host" | "control" | "guard";
  workspaceId: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  endpoint: string;
  artifact: string;
  credential: string;
  ready: boolean;
  hostRevision?: string;
  handoffId?: string;
  retired?: boolean;
}
export async function workspaceRuntimeId(paths: CraigPaths): Promise<string> {
  return createHash("sha256").update(await realpath(paths.workspaceRoot)).digest("hex").slice(0, 16);
}
export async function privateRuntimeDirectory(paths: CraigPaths): Promise<string> {
  const dir = path.join(process.platform === "win32" ? tmpdir() : "/tmp", `craig-runtime-${process.getuid?.() ?? "user"}-${await workspaceRuntimeId(paths)}`);
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => { if ((error as { code?: string }).code !== "EEXIST") throw error; });
  const metadata = await lstat(dir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe private runtime directory.");
  return dir;
}
export async function readPrivateRecord<T>(file: string): Promise<T | null> {
  const metadata = await lstat(file).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe runtime record ownership.");
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function writePrivateRecord(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
export async function newRuntimeRecord(paths: CraigPaths, role: RuntimeRecord["role"], artifact: string): Promise<RuntimeRecord> {
  const instanceId = randomUUID();
  return { schemaVersion: 1, role, workspaceId: await workspaceRuntimeId(paths), instanceId, pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), endpoint: path.join(await privateRuntimeDirectory(paths), `${role}-${instanceId.slice(0, 8)}.sock`), artifact, credential: randomUUID(), ready: false };
}
