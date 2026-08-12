/* eslint-disable no-unused-vars */
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { TaskRecord } from "../src/domain/task/types.js";
import { getCraigPaths, type CraigPaths } from "../src/state/craig-paths.js";

const mocks = vi.hoisted(() => ({
  tasks: [] as TaskRecord[],
  order: [] as string[],
  nextId: 1,
  failNextLaunch: false,
  lastCreateOptions: null as null | { allowLinkedProjectRepo?: boolean },
}));

vi.mock("../src/domain/task/index.js", () => ({
    mutateTask: vi.fn(async (_paths: CraigPaths, taskId: string, mutation: (task: TaskRecord) => TaskRecord | Promise<TaskRecord>) => {
      const index = mocks.tasks.findIndex((candidate) => candidate.id === taskId);
      if (index < 0) throw new Error(`missing ${taskId}`);
      const updated = await mutation(mocks.tasks[index]!);
      mocks.tasks[index] = updated;
      return updated;
    }),
    taskService: {
      getTask: vi.fn(async (_paths: CraigPaths, taskId: string) => {
        const task = mocks.tasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error(`missing ${taskId}`);
        return task;
      }),
      listTasks: vi.fn(async () => ({ kind: "listTasks", tasks: [...mocks.tasks], missingTaskIds: [], repoId: null })),
      createTask: vi.fn(async (_paths: CraigPaths, repoId: string, prompt: string, options: {
        runner?: TaskRecord["runner"];
        workspaceId?: string;
        owningWorkspaceId?: string;
        allowLinkedProjectRepo?: boolean;
        lineage?: {
          parentTaskId: string | null;
          rootTaskId?: string;
          delegationDepth: number;
          delegationIdempotencyKey?: string | null;
          furyRunId?: string | null;
          furyStepId?: string | null;
        };
        onProvisioned?: (task: TaskRecord) => Promise<Record<string, string> | void>;
      }) => {
        mocks.lastCreateOptions = options;
        const id = `child_${mocks.nextId++}`;
        const task = taskRecord(id, {
          type: options.workspaceId ? "project" : "repo",
          repoId: options.workspaceId ? "repo_project_primary" : repoId,
          workspaceId: options.workspaceId ?? options.owningWorkspaceId ?? `workspace_${repoId}`,
          title: prompt,
          runner: options.runner ?? "codex",
          parentTaskId: options.lineage?.parentTaskId ?? null,
          rootTaskId: options.lineage?.rootTaskId ?? id,
          delegationDepth: options.lineage?.delegationDepth ?? 0,
          delegationIdempotencyKey: options.lineage?.delegationIdempotencyKey ?? null,
          furyRunId: options.lineage?.furyRunId ?? null,
          furyStepId: options.lineage?.furyStepId ?? null,
        });
        mocks.tasks.push(task);
        await options.onProvisioned?.(task);
        if (mocks.failNextLaunch) {
          mocks.failNextLaunch = false;
          task.status = "draft";
          throw new Error("simulated launch failure");
        }
        return {
          kind: "createTask",
          taskId: id,
          repoId,
          workspaceId: task.workspaceId,
          agentTabId: `${task.id}:agent`,
          status: task.status,
          branch: task.branch,
          worktreePath: task.worktreePath,
          runner: task.runner,
        };
      }),
      cleanupTask: vi.fn(async (_paths: CraigPaths, task: TaskRecord) => {
        mocks.order.push(`cleanup:${task.id}`);
      }),
      closeTask: vi.fn(async (_paths: CraigPaths, taskId: string) => {
        mocks.order.push(`close:${taskId}`);
        const task = mocks.tasks.find((candidate) => candidate.id === taskId)!;
        task.status = "closed";
        return task;
      }),
    },
  }));

import {
  authorizeCapability,
  cancelTaskTree,
  createChildTask,
  ensureTaskCapabilities,
  revokeCapability,
} from "../src/domain/orchestration/index.js";

describe("capability-scoped delegation", () => {
  let paths: CraigPaths;
  let parent: TaskRecord;

  beforeEach(async () => {
    mocks.tasks.length = 0;
    mocks.order.length = 0;
    mocks.nextId = 1;
    mocks.failNextLaunch = false;
    mocks.lastCreateOptions = null;
    const root = await mkdtemp(path.join(os.tmpdir(), "craig-delegation-"));
    paths = getCraigPaths(root);
    await Promise.all([
      mkdir(paths.orchestrationDir, { recursive: true }),
      mkdir(paths.eventsDir, { recursive: true }),
      mkdir(paths.runtimeDir, { recursive: true }),
    ]);
    parent = taskRecord("parent", { rootTaskId: "parent" });
    mocks.tasks.push(parent);
    await ensureTaskCapabilities(paths, parent);
  });

  test("stores restrictive records and denies unrelated targets, revocation, and expiry", async () => {
    const capabilityId = parent.ptyTabs[0]!.capabilityId!;
    const directory = path.join(paths.orchestrationDir, "capabilities");
    const file = path.join(directory, `${capabilityId}.json`);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const original = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const capabilityToken = String(original.token);
    expect(original.allowedCommandFamilies).toEqual([
      "task.create-child",
      "task.children",
      "task.cancel-tree",
    ]);
    await writeFile(file, JSON.stringify({
      ...original,
      allowedCommandFamilies: [...original.allowedCommandFamilies as string[], "future.command"],
    }));
    await expect(authorizeCapability(paths, capabilityToken, "task.children", parent.id)).resolves.toMatchObject({
      actor: { type: "agent", taskId: parent.id },
    });
    await writeFile(file, JSON.stringify({ ...original, allowedCommandFamilies: ["task.children"] }));
    await expect(authorizeCapability(paths, capabilityToken, "task.create-child", parent.id)).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    await writeFile(file, JSON.stringify(original));
    await expect(authorizeCapability(paths, capabilityToken, "task.create-child", "unrelated")).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    const descendant = taskRecord("descendant", {
      parentTaskId: parent.id,
      rootTaskId: parent.id,
      delegationDepth: 1,
    });
    mocks.tasks.push(descendant);
    await expect(authorizeCapability(paths, capabilityToken, "task.cancel-tree", descendant.id)).resolves.toMatchObject({
      actor: { type: "agent", taskId: parent.id },
    });

    await revokeCapability(paths, capabilityId, { type: "human", source: "cli", processId: 1 });
    await expect(authorizeCapability(paths, capabilityToken, "task.create-child", parent.id)).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });

    const expiring = taskRecord("expiring", { rootTaskId: "expiring" });
    mocks.tasks.push(expiring);
    await ensureTaskCapabilities(paths, expiring);
    const expiringId = expiring.ptyTabs[0]!.capabilityId!;
    const expiringFile = path.join(directory, `${expiringId}.json`);
    const record = JSON.parse(await readFile(expiringFile, "utf8")) as Record<string, unknown>;
    await writeFile(expiringFile, JSON.stringify({ ...record, expiresAt: "2020-01-01T00:00:00.000Z" }));
    await expect(authorizeCapability(paths, String(record.token), "task.create-child", expiring.id)).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
  });

  test("reuses a capability when issuance is repeated from a stale task snapshot", async () => {
    const legacy = taskRecord("legacy", { rootTaskId: "legacy" });
    legacy.ptyTabs = legacy.ptyTabs.map(({ capabilityId: _capabilityId, ...tab }) => tab);
    mocks.tasks.push(legacy);
    const stale = structuredClone(legacy);

    const first = await ensureTaskCapabilities(paths, legacy);
    const second = await ensureTaskCapabilities(paths, stale);
    const current = mocks.tasks.find((task) => task.id === legacy.id)!;
    const capabilityId = current.ptyTabs.find((tab) => tab.kind === "agent")!.capabilityId!;
    const files = await readdir(path.join(paths.orchestrationDir, "capabilities"));

    expect(second).toEqual(first);
    expect(files.filter((name) => name === `${capabilityId}.json`)).toHaveLength(1);
  });

  test("issues distinct scoped capabilities for mixed-runner agent tabs", async () => {
    const mixed = taskRecord("mixed", { rootTaskId: "mixed" });
    mixed.ptyTabs.push({
      id: "mixed:cursor", kind: "agent", runner: "cursor", title: "Cursor", command: ["cursor"],
      createdAt: mixed.createdAt, updatedAt: mixed.updatedAt,
    });
    mocks.tasks.push(mixed);
    const codex = await ensureTaskCapabilities(paths, mixed, undefined, "mixed:agent");
    const cursor = await ensureTaskCapabilities(paths, mixed, undefined, "mixed:cursor");
    expect(cursor.CRAIG_AGENT_CAPABILITY).not.toBe(codex.CRAIG_AGENT_CAPABILITY);
    await expect(authorizeCapability(paths, cursor.CRAIG_AGENT_CAPABILITY!, "fury.step.complete", mixed.id))
      .resolves.toMatchObject({ actor: { taskId: mixed.id, agentTabId: "mixed:cursor" } });
  });

  test("creates a bounded child with durable lineage and replays an idempotency key", async () => {
    const capabilityId = await capabilityToken(paths, parent);
    const input = {
      parentTaskId: parent.id,
      repoId: parent.repoId,
      prompt: "Implement independent phase",
      idempotencyKey: "phase-one",
      capabilityId,
    };
    const created = await createChildTask(paths, input);
    expect(created).toMatchObject({
      parentTaskId: parent.id,
      rootTaskId: parent.id,
      delegationDepth: 1,
      idempotentReplay: false,
    });
    expect(mocks.tasks.find((task) => task.id === created.taskId)).toMatchObject({
      parentTaskId: parent.id,
      rootTaskId: parent.id,
      delegationIdempotencyKey: "phase-one",
    });

    await expect(createChildTask(paths, input)).resolves.toMatchObject({
      taskId: created.taskId,
      idempotentReplay: true,
    });
    expect(mocks.tasks).toHaveLength(2);
  });

  test("inherits project scope and keeps explicit repo children in the project workspace", async () => {
    parent.type = "project";
    parent.workspaceId = "workspace_project";
    parent.linkedRepoIds = ["repo_secondary"];
    parent.repoTargets = [{
      repoId: "repo_secondary", repoRoot: "/repo-secondary", worktreePath: "/worktree-secondary",
      branch: "craig/parent", status: "ready", failureReason: null, checks: parent.checks,
      lastCommit: null,
      pullRequest: {
        provider: "github", number: null, url: null, baseBranch: null, headBranch: null,
        status: null, mergeable: false, mergeStateStatus: null, requiredChecks: [],
        lastSyncedAt: null, lastSyncedHeadSha: null,
      },
      cleanup: parent.cleanup,
    }];
    const capabilityId = await capabilityToken(paths, parent);

    const inherited = await createChildTask(paths, {
      parentTaskId: parent.id,
      prompt: "inherit the whole project",
      capabilityId,
    });
    expect(inherited).toMatchObject({
      targetType: "workspace",
      targetId: "workspace_project",
      workspaceId: "workspace_project",
    });
    expect(mocks.tasks.find((task) => task.id === inherited.taskId)).toMatchObject({ type: "project" });

    const repoChild = await createChildTask(paths, {
      parentTaskId: parent.id,
      repoId: "repo_secondary",
      prompt: "work only in the secondary repo",
      capabilityId,
    });
    expect(repoChild).toMatchObject({
      targetType: "repo",
      targetId: "repo_secondary",
      repoId: "repo_secondary",
      workspaceId: "workspace_project",
    });
    expect(mocks.lastCreateOptions).toMatchObject({
      owningWorkspaceId: "workspace_project",
      allowLinkedProjectRepo: true,
    });
    expect(mocks.tasks.find((task) => task.id === repoChild.taskId)).toMatchObject({ type: "repo" });
  });

  test("rejects an explicit workspace outside the project parent", async () => {
    parent.type = "project";
    parent.workspaceId = "workspace_project";
    await expect(createChildTask(paths, {
      parentTaskId: parent.id,
      workspaceId: "workspace_other",
      prompt: "escape the project",
      capabilityId: await capabilityToken(paths, parent),
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  test("recovers an idempotent child after a partial launch failure", async () => {
    const input = {
      parentTaskId: parent.id,
      repoId: parent.repoId,
      prompt: "recover launch",
      idempotencyKey: "recover-once",
      capabilityId: await capabilityToken(paths, parent),
    };
    mocks.failNextLaunch = true;
    await expect(createChildTask(paths, input)).rejects.toThrow("simulated launch failure");
    await expect(createChildTask(paths, input)).resolves.toMatchObject({
      taskId: "child_1",
      status: "draft",
      agentTabId: "child_1:agent",
      idempotentReplay: true,
    });
    expect(mocks.tasks).toHaveLength(2);
  });

  test("enforces depth and concurrent-child limits", async () => {
    parent.delegationDepth = 4;
    await expect(createChildTask(paths, {
      parentTaskId: parent.id,
      repoId: parent.repoId,
      prompt: "too deep",
      capabilityId: await capabilityToken(paths, parent),
    })).rejects.toMatchObject({ code: "DELEGATION_LIMIT_EXCEEDED" });
    parent.delegationDepth = 0;
    for (let index = 0; index < 4; index += 1) {
      mocks.tasks.push(taskRecord(`active-${index}`, {
        parentTaskId: parent.id,
        rootTaskId: parent.id,
        delegationDepth: 1,
      }));
    }
    await expect(createChildTask(paths, {
      parentTaskId: parent.id,
      repoId: parent.repoId,
      prompt: "too concurrent",
      capabilityId: await capabilityToken(paths, parent),
    })).rejects.toMatchObject({ code: "DELEGATION_LIMIT_EXCEEDED" });
  });

  test("enforces child count and performs idempotent top-down tree cancellation", async () => {
    for (let index = 0; index < 8; index += 1) {
      mocks.tasks.push(taskRecord(`existing_${index}`, {
        parentTaskId: parent.id,
        rootTaskId: parent.id,
        delegationDepth: 1,
        status: "closed",
      }));
    }
    await expect(createChildTask(paths, {
      parentTaskId: parent.id,
      repoId: parent.repoId,
      prompt: "one too many",
      capabilityId: await capabilityToken(paths, parent),
    })).rejects.toMatchObject({ code: "DELEGATION_LIMIT_EXCEEDED" });

    mocks.tasks.splice(1);
    const child = taskRecord("child", { parentTaskId: parent.id, rootTaskId: parent.id, delegationDepth: 1 });
    const grandchild = taskRecord("grandchild", { parentTaskId: child.id, rootTaskId: parent.id, delegationDepth: 2 });
    mocks.tasks.push(child, grandchild);
    await ensureTaskCapabilities(paths, child);
    await ensureTaskCapabilities(paths, grandchild);
    const parentCapabilityId = parent.ptyTabs[0]!.capabilityId!;
    const parentCapabilityFile = path.join(paths.orchestrationDir, "capabilities", `${parentCapabilityId}.json`);
    const orphanId = "capability_orphan-parent";
    const orphanFile = path.join(paths.orchestrationDir, "capabilities", `${orphanId}.json`);
    const parentCapability = JSON.parse(await readFile(parentCapabilityFile, "utf8")) as Record<string, unknown>;
    const orphanToken = `${orphanId}.secret`;
    await writeFile(orphanFile, JSON.stringify({ ...parentCapability, id: orphanId, token: orphanToken }));
    const results = await Promise.all([
      cancelTaskTree(paths, parent.id),
      cancelTaskTree(paths, parent.id),
    ]);
    const first = results.find((result) => result.cancelled.some((entry) => entry.disposition === "cancelled"))!;
    const second = results.find((result) => result.cancelled.every((entry) => entry.disposition === "already-closed"))!;
    expect(first.cancelled.map((entry) => entry.taskId)).toEqual(["parent", "child", "grandchild"]);
    expect(mocks.order).toEqual([
      "cleanup:parent", "close:parent",
      "cleanup:child", "close:child",
      "cleanup:grandchild", "close:grandchild",
    ]);
    expect(second.cancelled.every((entry) => entry.disposition === "already-closed")).toBe(true);
    await expect(authorizeCapability(paths, orphanToken, "task.children", parent.id)).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
  });
});

function taskRecord(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const timestamp = "2026-08-07T00:00:00.000Z";
  return {
    id,
    title: overrides.title ?? id,
    slug: id,
    type: overrides.type ?? "repo",
    status: overrides.status ?? "running",
    runner: overrides.runner ?? "codex",
    repoId: overrides.repoId ?? "repo_test",
    workspaceId: overrides.workspaceId ?? "workspace_test",
    selectedPtyTabId: `${id}:agent`,
    linkedRepoIds: [],
    parentTaskId: overrides.parentTaskId ?? null,
    rootTaskId: overrides.rootTaskId ?? id,
    delegationDepth: overrides.delegationDepth ?? 0,
    delegationIdempotencyKey: overrides.delegationIdempotencyKey ?? null,
    furyRunId: overrides.furyRunId ?? null,
    furyStepId: overrides.furyStepId ?? null,
    repoRoot: "/repo",
    worktreePath: `/worktrees/${id}`,
    branch: `craig/${id}`,
    ptyTabs: [{
      id: `${id}:agent`,
      kind: "agent",
      capabilityId: `capability_${id.replaceAll("_", "-")}`,
      title: "Codex",
      command: ["codex"],
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    runnerSession: { command: ["codex"], pid: null, startedAt: timestamp, lastKnownState: "running", exitCode: null, exitedAt: null },
    prompt: { source: "inline", value: overrides.title ?? id },
    checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
    lastCommit: null,
    prs: [],
    artifacts: { logPath: null, checkSummaryPath: null, prDraftPath: null, prStatusPath: null },
    cleanup: { worktreeRemovedAt: null, preservedWorktree: false, warning: null },
    lastFailureReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function capabilityToken(paths: CraigPaths, task: TaskRecord): Promise<string> {
  const capabilityId = task.ptyTabs.find((tab) => tab.kind === "agent")!.capabilityId!;
  const file = path.join(paths.orchestrationDir, "capabilities", `${capabilityId}.json`);
  return String((JSON.parse(await readFile(file, "utf8")) as { token: unknown }).token);
}
