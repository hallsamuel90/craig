import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/shell/pty-daemon-orchestration.js", () => ({
  disposeDaemonSessions: vi.fn(async () => true),
  ensureDaemonAgentSession: vi.fn(async () => undefined),
  wakeOrchestrationSupervisor: vi.fn(async () => false),
}));

import { configService } from "../src/domain/config/index.js";
import { taskService } from "../src/domain/task/index.js";
import {
  listPromptCommands,
  listFuryReviews,
  listPendingFuryPlans,
  mutateFuryRun,
  furyDirs,
  readFuryRun,
} from "../src/domain/orchestration/index.js";
import {
  actOnReview,
  approvePlan,
  completeFuryStep,
  createPlan,
  reconcileFuryRun,
  runFury,
} from "../src/shell/fury-runtime.js";
import { createCraigState, createStubCommands, writeRepoRecord, writeTaskRecord } from "./test-helpers.js";

const roots: string[] = [];
const human = { type: "human" as const, source: "cli" as const, processId: process.pid };
const originalPath = process.env.PATH ?? "";

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.CRAIG_TEST_TMUX_COMMAND_LOG;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable fury runtime", () => {
  test("creates sequentially dependent Fury tasks as direct siblings beneath the planning task", async () => {
    const fixture = await setupChildGraph();
    const plan = await createPlan(fixture.paths, fixture.file, {}, "task_planning", human);
    await approvePlan(fixture.paths, plan.plan.id, human);
    let run = (await runFury(fixture.paths, plan.plan.id, human)).run;
    const firstTaskId = run.stepRuns.first!.taskId!;
    await completeFuryStep(fixture.paths, run.id, "first", null, human);
    run = await readFuryRun(fixture.paths, run.id);
    const secondTaskId = run.stepRuns.second!.taskId!;
    const tasks = (await taskService.listTasks(fixture.paths, { includeClosed: true })).tasks;
    expect(tasks.filter((task) => [firstTaskId, secondTaskId].includes(task.id))).toMatchObject([
      { parentTaskId: "task_planning", rootTaskId: "task_planning", delegationDepth: 1, furyStepId: "first" },
      { parentTaskId: "task_planning", rootTaskId: "task_planning", delegationDepth: 1, furyStepId: "second" },
    ]);
  });

  test("requires human approval of the exact immutable plan before execution", async () => {
    const fixture = await setup();
    const plan = await createPlan(fixture.paths, fixture.file, { task_id: "task_root" }, "task_root", human);
    expect(await listPendingFuryPlans(fixture.paths)).toMatchObject([{ id: plan.plan.id }]);
    await expect(runFury(fixture.paths, plan.plan.id, human)).rejects.toMatchObject({ code: "FURY_APPROVAL_REQUIRED" });
    await expect(approvePlan(fixture.paths, plan.plan.id, {
      type: "agent", taskId: "task_root", agentTabId: "agent-task_root", capabilityId: "redacted",
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await approvePlan(fixture.paths, plan.plan.id, human);
    expect(await listPendingFuryPlans(fixture.paths)).toEqual([]);

    const planFile = path.join(furyDirs(fixture.paths).plans, `${plan.plan.id}.json`);
    const tampered = JSON.parse(await readFile(planFile, "utf8")) as Record<string, unknown>;
    await writeFile(planFile, JSON.stringify({ ...tampered, name: "tampered" }), "utf8");
    await expect(runFury(fixture.paths, plan.plan.id, human)).rejects.toMatchObject({ code: "FURY_RECORD_INVALID" });
  });

  test("reuses an unchanged plan and surfaces only the latest unapproved revision", async () => {
    const fixture = await setup();
    const first = await createPlan(fixture.paths, fixture.file, { task_id: "task_root" }, "task_root", human);
    const replay = await createPlan(fixture.paths, fixture.file, { task_id: "task_root" }, "task_root", human);
    expect(replay.plan.id).toBe(first.plan.id);
    await writeFile(fixture.file, (await readFile(fixture.file, "utf8")).replace("Inspect the task.", "Inspect carefully."), "utf8");
    const revised = await createPlan(fixture.paths, fixture.file, { task_id: "task_root" }, "task_root", human);
    expect(revised.plan.id).not.toBe(first.plan.id);
    expect(await listPendingFuryPlans(fixture.paths)).toMatchObject([{ id: revised.plan.id }]);
  });

  test("only plans definitions under .craig/fury and binds concrete task targets to the planning task", async () => {
    const fixture = await setup();
    const outside = path.join(fixture.root, "outside.yaml");
    await writeFile(outside, await readFile(fixture.file, "utf8"), "utf8");
    await expect(createPlan(fixture.paths, outside, { task_id: "task_root" }, "task_root", human))
      .rejects.toMatchObject({ code: "FURY_DEFINITION_INVALID" });
    await expect(createPlan(fixture.paths, fixture.file, { task_id: "task_other" }, "task_root", human))
      .rejects.toMatchObject({ code: "FURY_DEFINITION_INVALID" });
    const unsafe = path.join(path.dirname(fixture.file), "unsafe-target.yaml");
    await writeFile(unsafe, (await readFile(fixture.file, "utf8"))
      .replace("steps.inspect.task_id", "steps.inspect.output.findings"), "utf8");
    await expect(createPlan(fixture.paths, unsafe, { task_id: "task_root" }, "task_root", human))
      .rejects.toMatchObject({ code: "FURY_DEFINITION_INVALID" });
  });

  test("executes explicit completion into a durable review gate and approval", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    expect(started.run).toMatchObject({ state: "running", stepRuns: { inspect: { state: "running", taskId: "task_root" } } });
    expect(await listPromptCommands(fixture.paths)).toHaveLength(1);

    await expect(completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: 3 }, human))
      .rejects.toMatchObject({ code: "FURY_OUTPUT_INVALID" });
    const completed = await completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: ["one"] }, human);
    expect(completed.run.state).toBe("waiting_for_review");
    const [review] = await listFuryReviews(fixture.paths);
    expect(review).toMatchObject({ state: "waiting_for_review", feedbackTarget: { taskId: "task_root" }, round: 1 });

    await expect(actOnReview(fixture.paths, review!.id, "approve", null, {
      type: "agent", taskId: "task_root", agentTabId: "agent-task_root", capabilityId: "redacted",
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    const approved = await actOnReview(fixture.paths, review!.id, "approve", "looks good", human);
    expect(approved.run.state).toBe("succeeded");
    expect(approved.review.history).toHaveLength(1);
  });

  test("creates exactly one run for concurrent replay of an approved plan", async () => {
    const fixture = await setup();
    const plan = await createPlan(fixture.paths, fixture.file, { task_id: "task_root" }, "task_root", human);
    await Promise.all([approvePlan(fixture.paths, plan.plan.id, human), approvePlan(fixture.paths, plan.plan.id, human)]);
    const [first, second] = await Promise.all([
      runFury(fixture.paths, plan.plan.id, human),
      runFury(fixture.paths, plan.plan.id, human),
    ]);
    await reconcileFuryRun(fixture.paths, first.run.id);
    await reconcileFuryRun(fixture.paths, first.run.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(second.run.id).toBe(first.run.id);
    expect(await listPromptCommands(fixture.paths)).toHaveLength(1);
  });

  test("recovers a claimed-but-not-recorded dispatch without duplicating commands", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await mutateFuryRun(fixture.paths, started.run.id, (run) => ({
      ...run,
      stepRuns: { ...run.stepRuns, inspect: { ...run.stepRuns.inspect!, taskId: null, agentTabId: null, commandId: null } },
    }));
    await reconcileFuryRun(fixture.paths, started.run.id);
    const recovered = await readFuryRun(fixture.paths, started.run.id);
    expect(recovered.stepRuns.inspect).toMatchObject({ state: "running", taskId: "task_root", commandId: expect.any(String) });
    expect(await listPromptCommands(fixture.paths)).toHaveLength(1);
  });

  test("accepts exactly one concurrent explicit completion", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    const completions = await Promise.allSettled([
      completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: ["first"] }, human),
      completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: ["second"] }, human),
    ]);
    expect(completions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(completions.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readFuryRun(fixture.paths, started.run.id)).stepRuns.inspect?.state).toBe("succeeded");
  });

  test("persists requested changes and resubmission without releasing downstream work", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    const requested = await actOnReview(fixture.paths, review!.id, "request_changes", "Add detail", human);
    expect(requested.run).toMatchObject({ state: "waiting_for_review", stepRuns: { review: { state: "changes_requested" } } });
    expect(requested.review.history[0]).toMatchObject({ action: "request_changes", feedbackCommandId: expect.any(String) });
    const resubmitted = await actOnReview(fixture.paths, review!.id, "resubmit", "updated", human);
    expect(resubmitted.review).toMatchObject({ state: "waiting_for_review", round: 2 });
    expect(resubmitted.review.history).toHaveLength(2);
  });

  test("serializes concurrent human decisions", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    const decisions = await Promise.allSettled([
      actOnReview(fixture.paths, review!.id, "approve", null, human),
      actOnReview(fixture.paths, review!.id, "reject", "not ready", human),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("times out durable review state and fails the run", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    await mutateFuryRun(fixture.paths, started.run.id, (run) => ({
      ...run,
      stepRuns: { ...run.stepRuns, review: { ...run.stepRuns.review!, deadlineAt: new Date(0).toISOString() } },
    }));
    await reconcileFuryRun(fixture.paths, started.run.id);
    expect(await readFuryRun(fixture.paths, started.run.id)).toMatchObject({ state: "failed", stepRuns: { review: { state: "timed_out" } } });
    expect((await listFuryReviews(fixture.paths))[0]).toMatchObject({ state: "timed_out" });
  });

  test("reconciles expired runs to timed out without replaying succeeded steps", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await mutateFuryRun(fixture.paths, started.run.id, (run) => ({ ...run, deadlineAt: new Date(0).toISOString() }));
    await reconcileFuryRun(fixture.paths, started.run.id);
    expect(await readFuryRun(fixture.paths, started.run.id)).toMatchObject({ state: "timed_out", stepRuns: { inspect: { state: "timed_out" } } });
  });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "craig-fury-runtime-"));
  roots.push(root);
  const paths = await createCraigState(root, ["task_root"]);
  await writeTaskRecord(root, { id: "task_root" });
  await configService.save(paths, { previews: { agentOrchestration: true } });
  const file = path.join(root, ".craig", "fury", "runtime-test.yaml");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `
version: 1
name: runtime-test
limits: { max_concurrency: 2, max_tasks: 4, timeout: 1h }
inputs:
  task_id: { type: string, required: true }
steps:
  inspect:
    task: "\${{ inputs.task_id }}"
    agent: { runner: codex }
    prompt: Inspect the task.
    output:
      schema:
        type: object
        properties:
          findings:
            type: array
            items: { type: string }
        required: [findings]
        additionalProperties: false
  review:
    needs: [inspect]
    human_review:
      title: Review findings
      summary: "Review \${{ steps.inspect.output.findings }}"
      feedback_target: { task: "\${{ steps.inspect.task_id }}" }
      timeout: 1h
`, "utf8");
  return { root, paths, file };
}

async function start(fixture: Awaited<ReturnType<typeof setup>>) {
  const plan = await createPlan(fixture.paths, fixture.file, { task_id: "task_root" }, "task_root", human);
  await approvePlan(fixture.paths, plan.plan.id, human);
  const started = await runFury(fixture.paths, plan.plan.id, human);
  return { plan, started };
}

async function setupChildGraph() {
  const root = await mkdtemp(path.join(tmpdir(), "craig-fury-children-"));
  roots.push(root);
  const paths = await createCraigState(root, ["task_planning"]);
  const repoRoot = path.join(root, "repo-a");
  await mkdir(repoRoot, { recursive: true });
  const timestamp = "2026-08-10T00:00:00.000Z";
  await writeRepoRecord(root, {
    id: "repo_a", name: "repo-a", rootPath: repoRoot, defaultBranch: "main", createdAt: timestamp, updatedAt: timestamp,
  }, {
    id: "workspace_repo_a", primaryRepoId: "repo_a", branch: "main", status: "active", linkedRepoIds: [],
    archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
  });
  await writeTaskRecord(root, {
    id: "task_planning", repoId: "repo_a", workspaceId: "workspace_repo_a", repoRoot, worktreePath: repoRoot,
  });
  await configService.save(paths, { previews: { agentOrchestration: true } });
  const stubDir = await createStubCommands(root);
  process.env.PATH = `${stubDir}:${originalPath}`;
  process.env.CRAIG_TEST_TMUX_COMMAND_LOG = path.join(root, "tmux.log");
  const file = path.join(root, ".craig", "fury", "children.yaml");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `
version: 1
name: direct-children
limits: { max_concurrency: 1, max_tasks: 2, timeout: 1h }
steps:
  first:
    create_child: {}
    agent: { runner: codex }
    prompt: First phase.
  second:
    needs: [first]
    create_child: { repo: repo_a }
    agent: { runner: cursor }
    prompt: Second phase.
`, "utf8");
  return { root, paths, file };
}
