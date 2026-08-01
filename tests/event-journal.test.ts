import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  appendEvent,
  listEvents,
  readAllEvents,
} from "../src/domain/orchestration/index.js";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { createCraigState } from "./test-helpers.js";

const roots: string[] = [];
const actor = { type: "system" as const, component: "heartbeat" as const };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("event journal", () => {
  test("serializes concurrent appends with monotonic sequences and idempotent ids", async () => {
    const paths = await createPaths();
    const events = await Promise.all(Array.from({ length: 20 }, (_, index) => appendEvent(paths, {
      id: `event-${index}`,
      type: "task.updated",
      taskId: `task_${index}`,
      actor,
      data: { index },
    })));
    const duplicate = await appendEvent(paths, {
      id: "event-3",
      type: "task.updated",
      taskId: "task_3",
      actor,
      data: { index: 999 },
    });

    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(duplicate.data).toEqual({ index: 3 });
    expect((await readAllEvents(paths))).toHaveLength(20);
  });

  test("replays from sequence and event-id cursors with task and glob filters", async () => {
    const paths = await createPaths();
    const first = await appendEvent(paths, { type: "task.created", taskId: "task_1", actor, data: {} });
    await appendEvent(paths, { type: "agent.state.changed", taskId: "task_1", actor, data: {} });
    const third = await appendEvent(paths, { type: "task.updated", taskId: "task_2", actor, data: {} });

    await expect(listEvents(paths, { after: String(first.sequence), taskId: "task_1", typeGlob: "agent.*" }))
      .resolves.toMatchObject({ events: [{ type: "agent.state.changed" }], cursor: { sequence: 3 } });
    await expect(listEvents(paths, { after: first.id, typeGlob: "task.*" }))
      .resolves.toMatchObject({ events: [{ id: third.id }], cursor: { sequence: 3 } });
    await expect(listEvents(paths, { after: "99" })).rejects.toMatchObject({ code: "EVENT_CURSOR_INVALID" });
  });

  test("rotates segments, expires retained cursors, and redacts sensitive payload fields", async () => {
    const paths = await createPaths();
    const written = [];
    for (let index = 0; index < 4; index += 1) {
      written.push(await appendEvent(paths, {
        type: "task.updated",
        actor,
        data: { index, prompt: "private", nested: { accessToken: "secret" } },
      }, { maxSegmentBytes: 1, maxSegments: 2 }));
    }
    const available = await listEvents(paths);
    expect(available.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(available.events[0]?.data).toEqual({
      index: 2,
      prompt: "[REDACTED]",
      nested: { accessToken: "[REDACTED]" },
    });
    await expect(listEvents(paths, { after: "0" })).rejects.toMatchObject({
      code: "EVENT_CURSOR_EXPIRED",
      details: { earliestAvailableSequence: 3, resumeAfter: 2 },
    });
    await expect(listEvents(paths, { after: written[0]!.id })).rejects.toMatchObject({
      code: "EVENT_CURSOR_EXPIRED",
    });
    await expect(appendEvent(paths, {
      type: "test.too-large",
      actor,
      data: { value: "x".repeat(200) },
    }, { maxRecordBytes: 100 })).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  test("ignores only a truncated active tail and rejects other corruption", async () => {
    const paths = await createPaths();
    await appendEvent(paths, { type: "task.created", actor, data: {} });
    const segment = path.join(paths.eventsDir, "segment-0000000000000001.jsonl");
    await appendFile(segment, '{"schemaVersion":1', "utf8");
    await expect(listEvents(paths)).resolves.toMatchObject({ events: [{ sequence: 1 }] });
    await appendEvent(paths, { type: "task.updated", actor, data: {} });
    await expect(listEvents(paths)).resolves.toMatchObject({ events: [{ sequence: 1 }, { sequence: 2 }] });

    await writeFile(segment, '{"broken":true}\n', "utf8");
    await expect(listEvents(paths)).rejects.toMatchObject({ code: "EVENT_JOURNAL_CORRUPT" });

    const rotated = await createPaths();
    await appendEvent(rotated, { type: "task.created", actor, data: {} }, { maxSegmentBytes: 1 });
    await appendEvent(rotated, { type: "task.updated", actor, data: {} }, { maxSegmentBytes: 1 });
    await appendFile(path.join(rotated.eventsDir, "segment-0000000000000001.jsonl"), "truncated", "utf8");
    await expect(listEvents(rotated)).rejects.toMatchObject({ code: "EVENT_JOURNAL_CORRUPT" });
  });
});

async function createPaths() {
  const root = await mkdtemp(path.join(tmpdir(), "craig-events-"));
  roots.push(root);
  await createCraigState(root, []);
  return getCraigPaths(root);
}
