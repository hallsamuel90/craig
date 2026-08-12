import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { taskService } from "../src/domain/task/index.js";
import { configService } from "../src/domain/config/index.js";
import { createRootTask } from "../src/domain/orchestration/index.js";
import { createCraigState, createRepoRoot, createStubCommands, getDateSegment, writeRepoRecord } from "./test-helpers.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("taskService.createTask", () => {
  test("launches a task through the injected PTY daemon boundary", async () => {
    const { paths, repoId, workspaceId } = await setup("craig-create-daemon-");
    const launch = vi.fn(async () => undefined);

    const result = await taskService.createTask(paths, repoId, "refactor auth", { launchProvisioned: launch });
    const task = await taskService.getTask(paths, result.taskId);

    expect(result).toMatchObject({ kind: "createTask", repoId, workspaceId, agentTabId: `${task.id}:agent` });
    expect(task).toMatchObject({ status: "running" });
    expect(task.runnerSession).toMatchObject({ command: ["codex", "refactor auth"], lastKnownState: "running" });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), undefined);
  });

  test("passes a scoped capability only through the daemon launch environment", async () => {
    const { paths, repoId } = await setup("craig-create-capability-");
    await configService.save(paths, { previews: { agentOrchestration: true } });
    const launch = vi.fn(async () => undefined);

    const result = await createRootTask(paths, repoId, "delegate safely", { launchProvisioned: launch });
    const task = await taskService.getTask(paths, result.taskId);
    const tab = task.ptyTabs.find((candidate) => candidate.kind === "agent")!;
    const capabilityFile = path.join(paths.orchestrationDir, "capabilities", `${tab.capabilityId}.json`);
    const capability = JSON.parse(await readFile(capabilityFile, "utf8")) as { token: string };

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.objectContaining({
      CRAIG_TASK_ID: task.id,
      CRAIG_AGENT_TAB_ID: tab.id,
      CRAIG_AGENT_CAPABILITY: capability.token,
    }));
  });

  test.each([
    ["cursor", "cursor-agent", "Cursor"],
    ["claude", "claude", "Claude"],
  ] as const)("keeps %s runner metadata independent of the session substrate", async (runner, executable, title) => {
    const { paths, repoId } = await setup(`craig-create-${runner}-`);
    const result = await taskService.createTask(paths, repoId, `${runner} task`, {
      runner,
      launchProvisioned: async () => undefined,
    });
    const task = await taskService.getTask(paths, result.taskId);

    expect(result.runner).toBe(runner);
    expect(task.runnerSession.command).toEqual([executable, `${runner} task`]);
    expect(task.ptyTabs.find((tab) => tab.kind === "agent")).toMatchObject({ title, command: [executable] });
  });

  test("allocates the next task id when the first branch already exists", async () => {
    const { paths, repoId } = await setup("craig-create-collision-");
    process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES = `refs/heads/craig/task_${getDateSegment()}_01`;
    try {
      const result = await taskService.createTask(paths, repoId, "branch collision", { launchProvisioned: async () => undefined });
      expect(result.taskId).toBe(`task_${getDateSegment()}_02`);
    } finally {
      delete process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES;
    }
  });

  test("keeps a durable draft task when daemon launch fails", async () => {
    const { paths, repoId } = await setup("craig-create-fail-");
    await expect(taskService.createTask(paths, repoId, "daemon unavailable", {
      launchProvisioned: async () => { throw new Error("PTY daemon unavailable"); },
    })).rejects.toThrow("PTY daemon unavailable");

    const failed = (await taskService.listTasks(paths)).tasks[0]!;
    expect(failed).toMatchObject({ status: "draft", lastFailureReason: "PTY daemon unavailable" });
    expect(failed.runnerSession.lastKnownState).toBe("failed");
  });
});

async function setup(prefix: string) {
  const root = await createRepoRoot(prefix);
  roots.push(root);
  const paths = await createCraigState(root);
  const stubDir = await createStubCommands(root);
  process.env.PATH = `${stubDir}:${originalPath ?? ""}`;
  const repoRoot = path.join(root, "repo-a");
  await mkdir(repoRoot, { recursive: true });
  const repoId = "repo_a";
  const workspaceId = "workspace_repo_a";
  const timestamp = "2026-08-12T00:00:00.000Z";
  await writeRepoRecord(root, {
    id: repoId, name: "repo-a", rootPath: repoRoot, defaultBranch: "main", createdAt: timestamp, updatedAt: timestamp,
  }, {
    id: workspaceId, primaryRepoId: repoId, branch: "main", status: "active", linkedRepoIds: [],
    archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
  });
  return { paths, repoId, workspaceId };
}
