import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { openTask } from "../src/services/open-task.js";
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

describe("openTask", () => {
  test("prints the worktree path when no opener config exists", async () => {
    const repoRoot = await createRepoRoot("craig-open-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });

    const result = await openTask(paths, "task_1");

    expect(result.launched).toBe(false);
    expect(result.worktreePath).toBe(worktreePath);
  });

  test("launches the configured opener with the worktree path appended", async () => {
    const repoRoot = await createRepoRoot("craig-open-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });
    await writeFile(paths.configFile, JSON.stringify({ open: { command: ["echo", "open"] } }), "utf8");

    const child = new EventEmitter();
    spawnMock.mockReturnValueOnce(child);

    const resultPromise = openTask(paths, "task_1");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.emit("exit", 0);
    const result = await resultPromise;

    expect(result.launched).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "echo",
      ["open", worktreePath],
      expect.objectContaining({ cwd: repoRoot, stdio: "inherit" }),
    );
  });

  test("fails on malformed config", async () => {
    const repoRoot = await createRepoRoot("craig-open-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });
    await writeFile(paths.configFile, JSON.stringify({ open: { command: "bad" } }), "utf8");

    await expect(openTask(paths, "task_1")).rejects.toThrow(/"open.command" must be an array of strings/);
  });

  test("fails when the opener exits non-zero", async () => {
    const repoRoot = await createRepoRoot("craig-open-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });
    await writeFile(paths.configFile, JSON.stringify({ open: { command: ["echo", "open"] } }), "utf8");

    const child = new EventEmitter();
    spawnMock.mockReturnValueOnce(child);

    const resultPromise = openTask(paths, "task_1");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.emit("exit", 1);

    await expect(resultPromise).rejects.toThrow(/failed with exit code 1/);
  });

  test("fails when the worktree path is missing", async () => {
    const repoRoot = await createRepoRoot("craig-open-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);

    await writeTaskRecord(repoRoot, {
      id: "task_1",
      worktreePath: `${repoRoot}/missing-worktree`,
    });

    await expect(openTask(paths, "task_1")).rejects.toThrow(/worktree does not exist/);
  });
});
