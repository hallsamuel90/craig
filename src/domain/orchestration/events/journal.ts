import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";
import { withEventJournalLock } from "../adapters/event-lock.js";
import type {
  CraigEvent,
  CraigEventFilter,
  CraigEventInput,
  CommandEventListResult,
} from "../types.js";

export const DEFAULT_EVENT_SEGMENT_BYTES = 256 * 1024;
export const DEFAULT_EVENT_RETENTION_SEGMENTS = 16;
export const MAX_EVENT_RECORD_BYTES = 64 * 1024;

export interface EventJournalOptions {
  maxSegmentBytes?: number;
  maxSegments?: number;
  maxRecordBytes?: number;
}

export async function appendEvent<TType extends string, TData>(
  paths: CraigPaths,
  input: CraigEventInput<TType, TData>,
  options: EventJournalOptions = {},
): Promise<CraigEvent<TType, TData>> {
  const maxSegmentBytes = requirePositiveInteger(
    options.maxSegmentBytes ?? DEFAULT_EVENT_SEGMENT_BYTES,
    "Event journal segment size",
  );
  const maxSegments = requirePositiveInteger(
    options.maxSegments ?? DEFAULT_EVENT_RETENTION_SEGMENTS,
    "Event journal retention",
  );
  const maxRecordBytes = requirePositiveInteger(
    options.maxRecordBytes ?? MAX_EVENT_RECORD_BYTES,
    "Event record size",
  );
  return withEventJournalLock(paths, async () => {
    await mkdir(paths.eventsDir, { recursive: true });
    await repairTruncatedActiveTail(paths);
    const journal = await readJournal(paths);
    const id = input.id ?? randomUUID();
    const duplicate = journal.events.find((event) => event.id === id);
    if (duplicate) return duplicate as CraigEvent<TType, TData>;

    const sequence = (journal.events.at(-1)?.sequence ?? 0) + 1;
    const event: CraigEvent<TType, TData> = {
      schemaVersion: 1,
      id,
      sequence,
      workspaceId: input.workspaceId ?? null,
      taskId: input.taskId ?? null,
      agentTabId: input.agentTabId ?? null,
      commandId: input.commandId ?? null,
      swarmRunId: input.swarmRunId ?? null,
      swarmStepId: input.swarmStepId ?? null,
      type: input.type,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      actor: input.actor,
      data: redactEventData(input.data) as TData,
    };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > maxRecordBytes) {
      throw new CraigError("CLI_USAGE", `Event record exceeds the ${maxRecordBytes}-byte limit.`, {
        details: { eventType: input.type, maxRecordBytes },
      });
    }

    const segments = await listSegmentFiles(paths);
    let segment = segments.at(-1);
    const creatingSegment = !segment || await shouldRotate(segment.path, line, maxSegmentBytes);
    if (creatingSegment) {
      segment = {
        name: segmentName(sequence),
        path: path.join(paths.eventsDir, segmentName(sequence)),
        startSequence: sequence,
      };
    }
    if (!segment) throw new CraigError("INTERNAL_ERROR", "Failed to select an event journal segment.", {});
    const handle = await open(segment.path, "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (creatingSegment) await syncDirectory(paths.eventsDir);
    await pruneSegments(paths, maxSegments);
    return event;
  });
}

export async function listEvents(
  paths: CraigPaths,
  filter: CraigEventFilter = {},
): Promise<CommandEventListResult> {
  const journal = await readJournal(paths);
  const afterSequence = resolveAfterSequence(
    journal.events,
    filter.after,
    journal.earliestSequence,
    journal.events.at(-1)?.sequence ?? null,
  );
  const matcher = filter.typeGlob ? compileGlob(filter.typeGlob) : null;
  const events = journal.events.filter((event) =>
    event.sequence > afterSequence &&
    (!filter.taskId || event.taskId === filter.taskId) &&
    (!matcher || matcher.test(event.type)));
  const latestSequence = journal.events.at(-1)?.sequence ?? null;
  const scanned = journal.events.filter((event) => event.sequence > afterSequence).at(-1);
  return {
    kind: "listEvents",
    events,
    cursor: {
      after: scanned?.id ?? filter.after ?? null,
      sequence: scanned?.sequence ?? afterSequence,
      earliestAvailableSequence: journal.earliestSequence,
      latestSequence,
    },
  };
}

export async function readAllEvents(paths: CraigPaths): Promise<CraigEvent[]> {
  return (await readJournal(paths)).events;
}

interface SegmentFile {
  name: string;
  path: string;
  startSequence: number;
}

async function readJournal(paths: CraigPaths): Promise<{
  events: CraigEvent[];
  earliestSequence: number | null;
}> {
  await mkdir(paths.eventsDir, { recursive: true });
  const segments = await listSegmentFiles(paths);
  const events: CraigEvent[] = [];
  const eventIds = new Set<string>();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const payload = await readFile(segment.path, "utf8");
    const finalSegment = index === segments.length - 1;
    const lines = payload.split("\n");
    if (!payload.endsWith("\n")) {
      if (!finalSegment) throw corruption(segment.name, "segment has a truncated tail");
      lines.pop();
    } else {
      lines.pop();
    }
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      if (line.length === 0) throw corruption(segment.name, `empty record at line ${lineIndex + 1}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw corruption(segment.name, `invalid JSON at line ${lineIndex + 1}`);
      }
      const event = validateEvent(parsed, segment.name, lineIndex + 1);
      if (lineIndex === 0 && event.sequence !== segment.startSequence) {
        throw corruption(segment.name, `first record sequence ${event.sequence} does not match segment name`);
      }
      if (eventIds.has(event.id)) throw corruption(segment.name, `duplicate event id ${event.id}`);
      eventIds.add(event.id);
      const previous = events.at(-1);
      if (previous && event.sequence !== previous.sequence + 1) {
        throw corruption(segment.name, `non-monotonic sequence ${event.sequence} after ${previous.sequence}`);
      }
      events.push(event);
    }
  }
  return { events, earliestSequence: events[0]?.sequence ?? null };
}

async function listSegmentFiles(paths: CraigPaths): Promise<SegmentFile[]> {
  const names = await readdir(paths.eventsDir).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  return names.flatMap((name): SegmentFile[] => {
    const match = /^segment-(\d{16})\.jsonl$/.exec(name);
    if (!match) return [];
    return [{ name, path: path.join(paths.eventsDir, name), startSequence: Number(match[1]) }];
  }).sort((left, right) => left.startSequence - right.startSequence);
}

async function shouldRotate(segmentPath: string, line: string, maxBytes: number): Promise<boolean> {
  const metadata = await stat(segmentPath).catch(() => null);
  return metadata !== null && metadata.size > 0 && metadata.size + Buffer.byteLength(line) > maxBytes;
}

async function pruneSegments(paths: CraigPaths, maxSegments: number): Promise<void> {
  const segments = await listSegmentFiles(paths);
  const removed = segments.slice(0, Math.max(0, segments.length - maxSegments));
  for (const segment of removed) {
    await rm(segment.path, { force: true });
  }
  if (removed.length > 0) await syncDirectory(paths.eventsDir);
}

async function repairTruncatedActiveTail(paths: CraigPaths): Promise<void> {
  const active = (await listSegmentFiles(paths)).at(-1);
  if (!active) return;
  const payload = await readFile(active.path);
  if (payload.length === 0 || payload[payload.length - 1] === 0x0a) return;
  const newline = payload.lastIndexOf(0x0a);
  const handle = await open(active.path, "r+");
  try {
    await handle.truncate(newline + 1);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveAfterSequence(
  events: CraigEvent[],
  cursor: string | undefined,
  earliest: number | null,
  latest: number | null,
): number {
  if (cursor === undefined) return 0;
  if (/^\d+$/.test(cursor)) {
    const sequence = Number(cursor);
    if (!Number.isSafeInteger(sequence)) throw invalidCursor(cursor);
    if ((latest === null && sequence !== 0) || (latest !== null && sequence > latest)) throw invalidCursor(cursor);
    assertCursorAvailable(cursor, sequence, earliest);
    return sequence;
  }
  const event = events.find((candidate) => candidate.id === cursor);
  if (!event) {
    if (earliest !== null && earliest > 1) {
      throw new CraigError("EVENT_CURSOR_EXPIRED", `Event cursor ${cursor} has expired.`, {
        details: { cursor, earliestAvailableSequence: earliest, resumeAfter: earliest - 1 },
      });
    }
    throw invalidCursor(cursor);
  }
  assertCursorAvailable(cursor, event.sequence, earliest);
  return event.sequence;
}

function assertCursorAvailable(cursor: string, sequence: number, earliest: number | null): void {
  if (earliest !== null && sequence < earliest - 1) {
    throw new CraigError("EVENT_CURSOR_EXPIRED", `Event cursor ${cursor} has expired.`, {
      details: { cursor, earliestAvailableSequence: earliest, resumeAfter: earliest - 1 },
    });
  }
}

function compileGlob(glob: string): RegExp {
  if (glob.length === 0 || glob.length > 256) {
    throw new CraigError("CLI_USAGE", "Event type glob must contain between 1 and 256 characters.", {});
  }
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

function redactEventData<T>(data: T): T {
  const payload = JSON.stringify(data, (key, value: unknown) =>
    /prompt|token|secret|password|authorization|capability/i.test(key) ? "[REDACTED]" : value);
  if (payload === undefined) return null as T;
  return JSON.parse(payload) as T;
}

function validateEvent(value: unknown, segment: string, line: number): CraigEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corruption(segment, `record at line ${line} is not an object`);
  }
  const event = value as Partial<CraigEvent>;
  if (
    event.schemaVersion !== 1 ||
    typeof event.id !== "string" || event.id.length === 0 || event.id.length > 256 ||
    !Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) < 1 ||
    typeof event.type !== "string" || event.type.length === 0 || event.type.length > 256 ||
    typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt)) ||
    !isNullableString(event.workspaceId) ||
    !isNullableString(event.taskId) ||
    !isNullableString(event.agentTabId) ||
    !isNullableString(event.commandId) ||
    !isNullableString(event.swarmRunId) ||
    !isNullableString(event.swarmStepId) ||
    !isActor(event.actor) ||
    !("data" in event)
  ) {
    throw corruption(segment, `record at line ${line} has an invalid schema`);
  }
  return event as CraigEvent;
}

function isActor(actor: unknown): boolean {
  if (typeof actor !== "object" || actor === null || Array.isArray(actor) || !("type" in actor)) return false;
  const value = actor as Record<string, unknown>;
  if (value.type === "human") {
    return (value.source === "cli" || value.source === "tui") && Number.isInteger(value.processId);
  }
  if (value.type === "agent") {
    return typeof value.taskId === "string" && typeof value.agentTabId === "string" && typeof value.capabilityId === "string";
  }
  return value.type === "system" &&
    (value.component === "orchestration-supervisor" || value.component === "heartbeat");
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

const segmentName = (sequence: number) => `segment-${String(sequence).padStart(16, "0")}.jsonl`;

const corruption = (segment: string, reason: string) => new CraigError(
  "EVENT_JOURNAL_CORRUPT",
  `Event journal segment ${segment} is corrupt: ${reason}.`,
  { details: { segment, reason } },
);

const invalidCursor = (cursor: string) => new CraigError(
  "EVENT_CURSOR_INVALID",
  `Event cursor ${cursor} was not found.`,
  { details: { cursor } },
);

const isMissing = (error: unknown): error is { code: "ENOENT" } =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CraigError("CLI_USAGE", `${label} must be a positive integer.`, { details: { value } });
  }
  return value;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
