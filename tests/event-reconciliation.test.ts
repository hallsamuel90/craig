import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { appendEvent, readAllEvents } from "../src/domain/orchestration/index.js";
import { reconcileEvents } from "../src/shell/event-reconciliation.js";
import { createCraigState, writeTaskRecord } from "./test-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("event reconciliation", () => {
  test("coalesces task, PR, and agent state changes and repairs concurrent gaps idempotently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-event-reconcile-"));
    roots.push(root);
    const paths = await createCraigState(root, ["task_1"]);
    const task = await writeTaskRecord(root, { id: "task_1" });
    const taskPath = path.join(paths.tasksDir, "task_1.json");

    await Promise.all([reconcileEvents(paths), reconcileEvents(paths)]);
    expect((await readAllEvents(paths)).map((event) => event.type)).toEqual([
      "task.created",
      "agent.state.changed",
    ]);

    await updateTask(taskPath, {
      status: "review",
      updatedAt: "2026-04-21T00:00:01.000Z",
      prs: [pullRequest("open", "2026-04-21T00:00:01.000Z")],
    });
    await reconcileEvents(paths);
    expect((await readAllEvents(paths)).map((event) => event.type)).toEqual([
      "task.created",
      "agent.state.changed",
      "task.updated",
      "task.pr.linked",
    ]);

    await updateTask(taskPath, {
      updatedAt: "2026-04-21T00:00:02.000Z",
      prs: [pullRequest("merged", "2026-04-21T00:00:02.000Z")],
      runnerSession: { ...task.runnerSession, lastKnownState: "failed" },
      lastFailureReason: "runner exited",
    });
    await reconcileEvents(paths);
    expect((await readAllEvents(paths)).map((event) => event.type).slice(-3)).toEqual([
      "task.updated",
      "task.pr.refreshed",
      "agent.state.changed",
    ]);
    expect((await readAllEvents(paths)).at(-1)?.data).toMatchObject({ previousState: "idle", state: "error" });

    await updateTask(taskPath, {
      status: "closed",
      updatedAt: "2026-04-21T00:00:03.000Z",
      prs: [],
    });
    await reconcileEvents(paths);
    const finalEvents = await readAllEvents(paths);
    expect(finalEvents.map((event) => event.type).slice(-2)).toEqual(["task.closed", "task.pr.unlinked"]);
    const count = finalEvents.length;
    await reconcileEvents(paths);
    expect(await readAllEvents(paths)).toHaveLength(count);
  });

  test("does not recreate semantic events after their segments rotate out of retention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-event-projection-"));
    roots.push(root);
    const paths = await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1" });
    await reconcileEvents(paths);
    const taskPath = path.join(paths.tasksDir, "task_1.json");
    await updateTask(taskPath, {
      updatedAt: "2026-04-21T00:00:01.000Z",
      prs: [pullRequest("open", "2026-04-21T00:00:01.000Z")],
    });
    await reconcileEvents(paths);
    for (let index = 0; index < 3; index += 1) {
      await appendEvent(paths, {
        type: "test.rotation",
        actor: { type: "system", component: "heartbeat" },
        data: { index },
      }, { maxSegmentBytes: 1, maxSegments: 1 });
    }
    expect((await readAllEvents(paths)).map((event) => event.type)).toEqual(["test.rotation"]);

    expect(await reconcileEvents(paths)).toEqual([]);
    expect((await readAllEvents(paths)).map((event) => event.type)).toEqual(["test.rotation"]);

    await updateTask(taskPath, {
      status: "closed",
      updatedAt: "2026-04-21T00:00:02.000Z",
      prs: [],
    });
    await reconcileEvents(paths);
    expect((await readAllEvents(paths)).map((event) => event.type).slice(-2)).toEqual([
      "task.closed",
      "task.pr.unlinked",
    ]);
  });
});

async function updateTask(filePath: string, changes: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  await writeFile(filePath, JSON.stringify({ ...current, ...changes }, null, 2), "utf8");
}

function pullRequest(status: "open" | "merged", timestamp: string) {
  return {
    provider: "github",
    owner: "example",
    repo: "repo",
    number: 42,
    url: "https://github.com/example/repo/pull/42",
    title: "Event journal",
    status,
    draft: false,
    baseBranch: "main",
    headBranch: "agent/event-journal",
    mergeable: true,
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    requiredChecks: [],
    comments: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    mergedAt: status === "merged" ? timestamp : null,
    lastSyncedAt: timestamp,
    lastSyncedHeadSha: "abc123",
  };
}
