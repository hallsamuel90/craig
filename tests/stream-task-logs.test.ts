import { EventEmitter } from "node:events";
import { rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { taskService } from "../src/domain/task/index.js";
const { prepareTaskLogs, streamTaskLogs } = taskService;
import { createCraigState, createRepoRoot, writeTaskRecord } from "./test-helpers.js";

const tempRoots: string[] = [];
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    spawn: spawnMock,
  };
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  spawnMock.mockReset();
});

describe("stream-task-logs", () => {
  test("fails when the task has no log path", async () => {
    const repoRoot = await createRepoRoot("craig-logs-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);

    await writeTaskRecord(repoRoot, {
      id: "task_1",
      artifacts: {
        logPath: null,
        checkSummaryPath: ".craig/artifacts/task_1/check-summary.json",
        prDraftPath: null,
        prStatusPath: ".craig/artifacts/task_1/pr-status.json",
      },
    });

    await expect(prepareTaskLogs(paths, "task_1")).rejects.toThrow(/does not have a Craig-managed log path/);
  });

  test("fails when the log file does not exist", async () => {
    const repoRoot = await createRepoRoot("craig-logs-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);

    await writeTaskRecord(repoRoot, { id: "task_1" });

    await expect(prepareTaskLogs(paths, "task_1")).rejects.toThrow(/log file does not exist yet/);
  });

  test("invokes tail against the resolved log path", async () => {
    const repoRoot = await createRepoRoot("craig-logs-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const logPath = `${paths.logsDir}/task_1.log`;

    await writeFile(logPath, "hello\n", "utf8");
    await writeTaskRecord(repoRoot, { id: "task_1" });

    const prepared = await prepareTaskLogs(paths, "task_1");
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    spawnMock.mockReturnValueOnce(child);

    const streamPromise = streamTaskLogs(prepared.logPath);
    child.emit("exit", 0, null);

    await streamPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "tail",
      ["-n", "+1", "-f", prepared.logPath],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});
