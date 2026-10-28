import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/shell/pty-daemon-orchestration.js", () => ({
  disposeDaemonSessions: vi.fn(async () => true),
  ensureDaemonAgentSession: vi.fn(async () => undefined),
  wakeOrchestrationSupervisor: vi.fn(async () => true),
}));

import { configService } from "../src/domain/config/index.js";
import { taskService } from "../src/domain/task/index.js";
import {
  listPromptCommands,
  listFuryReviews,
  listPendingFuryPlans,
  mutateFuryRun,
  mutateFuryReview,
  furyDirs,
  readFuryRun,
} from "../src/domain/orchestration/index.js";
import {
  actOnReview,
  cancelFury,
  showFury,
  showReview,
  listReviews,
  watchFury,
  reconcileFuryRuns,
  approvePlan,
  completeFuryStep,
  createPlan,
  reconcileFuryRun,
  runFury,
} from "../src/shell/fury-runtime.js";
import { loadWorkspaceShellModel } from "../src/ui/shell/loader.js";
import { disposeDaemonSessions, wakeOrchestrationSupervisor } from "../src/shell/pty-daemon-orchestration.js";
import { createCraigState, createStubCommands, writeRepoRecord, writeTaskRecord } from "./test-helpers.js";

const roots: string[] = [];
const human = { type: "human" as const, source: "cli" as const, processId: process.pid };
const originalPath = process.env.PATH ?? "";

afterEach(async () => {
  process.env.PATH = originalPath;
  vi.mocked(disposeDaemonSessions).mockResolvedValue(true);
  vi.mocked(wakeOrchestrationSupervisor).mockResolvedValue(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable fury runtime", () => {
  test("command mutations only persist intent and never schedule in the calling worker", async () => {
    const fixture = await setupChildGraph();
    const { plan } = await createPlan(fixture.paths, fixture.file, {}, "task_planning", human);
    await approvePlan(fixture.paths, plan.id, human);
    const started = await runFury(fixture.paths, plan.id, human);
    expect(started.run.state).toBe("pending");
    expect((await taskService.listTasks(fixture.paths)).tasks).toHaveLength(1);
    expect(await listPromptCommands(fixture.paths)).toHaveLength(0);
    await reconcileFuryRun(fixture.paths, started.run.id);
    const completed = await completeFuryStep(fixture.paths, started.run.id, "first", null, human);
    expect(completed.step.state).toBe("succeeded");
    expect(completed.run.stepRuns.second?.state).toBe("pending");
    expect((await taskService.listTasks(fixture.paths)).tasks).toHaveLength(2);
    const before = await readFile(path.join(furyDirs(fixture.paths).runs, `${started.run.id}.json`), "utf8");
    await showFury(fixture.paths, started.run.id);
    await watchFury(fixture.paths, started.run.id, undefined, { signal: AbortSignal.abort(), onEvent: () => undefined });
    expect(await readFile(path.join(furyDirs(fixture.paths).runs, `${started.run.id}.json`), "utf8")).toBe(before);
    await reconcileFuryRun(fixture.paths, started.run.id);
    expect((await readFuryRun(fixture.paths, started.run.id)).stepRuns.second?.taskId).toBeTruthy();
  });

  test("reports a persisted run when supervisor notification fails, without launching from the caller", async () => {
    const fixture = await setupChildGraph();
    const { plan } = await createPlan(fixture.paths, fixture.file, {}, "task_planning", human);
    await approvePlan(fixture.paths, plan.id, human);
    vi.mocked(wakeOrchestrationSupervisor).mockResolvedValueOnce(false);
    await expect(runFury(fixture.paths, plan.id, human)).rejects.toMatchObject({
      code: "PARTIAL_RESULT", retryable: true, details: { persisted: true, reason: "ORCHESTRATION_UNAVAILABLE" },
    });
    expect((await taskService.listTasks(fixture.paths)).tasks).toHaveLength(1);
    const replay = await runFury(fixture.paths, plan.id, human);
    expect(replay).toMatchObject({ created: false, run: { state: "pending" } });
  });

  test("keeps reviews inspectable and visible after preview disablement and pauses new agent steps", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    await configService.save(fixture.paths, { previews: { agentOrchestration: false } });
    expect((await showFury(fixture.paths, started.run.id)).run.state).toBe("waiting_for_review");
    expect((await listReviews(fixture.paths)).reviews).toHaveLength(1);
    expect((await showReview(fixture.paths, review!.id)).review.id).toBe(review!.id);
    await writeFile(path.join(furyDirs(fixture.paths).plans, "plan_disabled.json"), "invalid JSON");
    expect((await loadWorkspaceShellModel(fixture.root)).furyApprovalCount).toBe(1);
    await actOnReview(fixture.paths, review!.id, "request_changes", "Explain the tests", human);
    const feedback = (await listPromptCommands(fixture.paths)).find((command) => command.idempotencyKey?.startsWith("fury-review:"));
    expect(feedback?.prompt.text).toContain(`craig fury review resubmit ${review!.id}`);
    expect((await loadWorkspaceShellModel(fixture.root)).furyApprovalCount).toBe(1);

    const children = await setupChildGraph();
    const { plan } = await createPlan(children.paths, children.file, {}, "task_planning", human);
    await approvePlan(children.paths, plan.id, human);
    const pending = await runFury(children.paths, plan.id, human);
    await configService.save(children.paths, { previews: { agentOrchestration: false } });
    await reconcileFuryRuns(children.paths);
    expect((await taskService.listTasks(children.paths)).tasks).toHaveLength(1);
    expect((await readFuryRun(children.paths, pending.run.id)).stepRuns.first?.state).toBe("pending");
    await mutateFuryRun(children.paths, pending.run.id, (run) => ({ ...run, deadlineAt: new Date(0).toISOString() }));
    await reconcileFuryRuns(children.paths);
    expect((await readFuryRun(children.paths, pending.run.id)).state).toBe("timed_out");
  });

  test("retries failed cancellation cleanup without replaying tasks or claiming stopped sessions", async () => {
    const fixture = await setupChildGraph();
    const { plan } = await createPlan(fixture.paths, fixture.file, {}, "task_planning", human);
    await approvePlan(fixture.paths, plan.id, human);
    const { run } = await runAndReconcile(fixture.paths, plan.id, human);
    const taskId = run.stepRuns.first!.taskId!;
    const cancelled = await cancelFury(fixture.paths, run.id, human);
    expect(cancelled.run).toMatchObject({ state: "cancelled", cleanupPending: true });
    vi.mocked(disposeDaemonSessions).mockResolvedValue(false);
    await reconcileFuryRun(fixture.paths, run.id);
    expect((await showFury(fixture.paths, run.id)).run).toMatchObject({
      state: "cancelled", cleanupPending: true, cleanupError: expect.stringContaining("could not stop"),
    });
    vi.mocked(disposeDaemonSessions).mockResolvedValue(true);
    await cancelFury(fixture.paths, run.id, human);
    await reconcileFuryRun(fixture.paths, run.id);
    expect((await showFury(fixture.paths, run.id)).run).toMatchObject({ state: "cancelled", cleanupPending: false, cleanupError: null });
    expect((await taskService.getTask(fixture.paths, taskId)).status).toBe("closed");
    expect((await taskService.listTasks(fixture.paths, { includeClosed: true })).tasks).toHaveLength(2);
  });

  test("fails a dependent step explicitly when an optional referenced output was omitted", async () => {
    const fixture = await setupChildGraph();
    await writeFile(fixture.file, (await readFile(fixture.file, "utf8"))
      .replace("prompt: First phase.", `prompt: First phase.
    output:
      schema:
        type: object
        properties:
          summary: { type: string }`)
      .replace("prompt: Second phase.", 'prompt: "Use ${{ steps.first.output.summary }}"'));
    const { plan } = await createPlan(fixture.paths, fixture.file, {}, "task_planning", human);
    await approvePlan(fixture.paths, plan.id, human);
    const { run } = await runAndReconcile(fixture.paths, plan.id, human);
    const completed = await completeAndReconcile(fixture.paths, run.id, "first", {}, human);
    expect(completed.run).toMatchObject({
      state: "failed", stepRuns: { second: { state: "failed", error: expect.stringContaining("has no output") } },
    });
    expect((await taskService.listTasks(fixture.paths)).tasks).toHaveLength(2);
  });

  test("rejects late completion and review approval before the next heartbeat can enforce deadlines", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await mutateFuryRun(fixture.paths, started.run.id, (run) => ({ ...run, deadlineAt: new Date(0).toISOString() }));
    await expect(completeFuryStep(fixture.paths, started.run.id, "inspect", { findings: [] }, human))
      .rejects.toMatchObject({ code: "FURY_STATE_CONFLICT" });
    await mutateFuryRun(fixture.paths, started.run.id, (run) => ({ ...run, deadlineAt: new Date(Date.now() + 60_000).toISOString() }));
    await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    await mutateFuryReview(fixture.paths, review!.id, (current) => ({ ...current, deadlineAt: new Date(0).toISOString() }));
    await expect(actOnReview(fixture.paths, review!.id, "approve", null, human))
      .rejects.toMatchObject({ code: "FURY_STATE_CONFLICT" });
    expect((await showReview(fixture.paths, review!.id)).review.state).toBe("waiting_for_review");
  });

  test("preserves review history when a crash occurred before binding its checkpoint to the step", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    await actOnReview(fixture.paths, review!.id, "approve", "accepted", human);
    await mutateFuryRun(fixture.paths, started.run.id, (run) => ({
      ...run, stepRuns: { ...run.stepRuns, review: {
        ...run.stepRuns.review!, state: "pending", reviewId: null, completedAt: null, completedBy: null,
      } },
    }));
    await reconcileFuryRun(fixture.paths, started.run.id);
    await reconcileFuryRun(fixture.paths, started.run.id);
    expect((await readFuryRun(fixture.paths, started.run.id)).state).toBe("succeeded");
    expect((await showReview(fixture.paths, review!.id)).review).toMatchObject({ state: "approved", history: [{ message: "accepted" }] });
  });

  test("recovers a durable review decision when its run update was interrupted", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    await mutateFuryReview(fixture.paths, review!.id, (current) => ({
      ...current, state: "approved", version: current.version + 1,
    }));
    await reconcileFuryRun(fixture.paths, started.run.id);
    expect((await readFuryRun(fixture.paths, started.run.id)).state).toBe("succeeded");
  });

  test("creates sequentially dependent Fury tasks as direct siblings beneath the planning task", async () => {
    const fixture = await setupChildGraph();
    const plan = await createPlan(fixture.paths, fixture.file, {}, "task_planning", human);
    await approvePlan(fixture.paths, plan.plan.id, human);
    let run = (await runAndReconcile(fixture.paths, plan.plan.id, human)).run;
    const firstTaskId = run.stepRuns.first!.taskId!;
    await completeAndReconcile(fixture.paths, run.id, "first", null, human);
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
    await expect(runAndReconcile(fixture.paths, plan.plan.id, human)).rejects.toMatchObject({ code: "FURY_APPROVAL_REQUIRED" });
    await expect(approvePlan(fixture.paths, plan.plan.id, {
      type: "agent", taskId: "task_root", agentTabId: "agent-task_root", capabilityId: "redacted",
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await approvePlan(fixture.paths, plan.plan.id, human);
    expect(await listPendingFuryPlans(fixture.paths)).toEqual([]);

    const planFile = path.join(furyDirs(fixture.paths).plans, `${plan.plan.id}.json`);
    const tampered = JSON.parse(await readFile(planFile, "utf8")) as Record<string, unknown>;
    await writeFile(planFile, JSON.stringify({ ...tampered, name: "tampered" }), "utf8");
    await expect(runAndReconcile(fixture.paths, plan.plan.id, human)).rejects.toMatchObject({ code: "FURY_RECORD_INVALID" });
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

    await expect(completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: 3 }, human))
      .rejects.toMatchObject({ code: "FURY_OUTPUT_INVALID" });
    const completed = await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: ["one"] }, human);
    expect(completed.run.state).toBe("waiting_for_review");
    const [review] = await listFuryReviews(fixture.paths);
    expect(review).toMatchObject({ state: "waiting_for_review", feedbackTarget: { taskId: "task_root" }, round: 1 });

    await expect(reviewAndReconcile(fixture.paths, review!.id, "approve", null, {
      type: "agent", taskId: "task_root", agentTabId: "agent-task_root", capabilityId: "redacted",
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    const approved = await reviewAndReconcile(fixture.paths, review!.id, "approve", "looks good", human);
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
      completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: ["first"] }, human),
      completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: ["second"] }, human),
    ]);
    expect(completions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(completions.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readFuryRun(fixture.paths, started.run.id)).stepRuns.inspect?.state).toBe("succeeded");
  });

  test("persists requested changes and resubmission without releasing downstream work", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    const requested = await reviewAndReconcile(fixture.paths, review!.id, "request_changes", "Add detail", human);
    expect(requested.run).toMatchObject({ state: "waiting_for_review", stepRuns: { review: { state: "changes_requested" } } });
    expect(requested.review.history[0]).toMatchObject({ action: "request_changes", feedbackCommandId: expect.any(String) });
    const resubmitted = await reviewAndReconcile(fixture.paths, review!.id, "resubmit", "updated", human);
    expect(resubmitted.review).toMatchObject({ state: "waiting_for_review", round: 2 });
    expect(resubmitted.review.history).toHaveLength(2);
  });

  test("serializes concurrent human decisions", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
    const [review] = await listFuryReviews(fixture.paths);
    const decisions = await Promise.allSettled([
      reviewAndReconcile(fixture.paths, review!.id, "approve", null, human),
      reviewAndReconcile(fixture.paths, review!.id, "reject", "not ready", human),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("times out durable review state and fails the run", async () => {
    const fixture = await setup();
    const { started } = await start(fixture);
    await completeAndReconcile(fixture.paths, started.run.id, "inspect", { findings: [] }, human);
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
  const started = await runAndReconcile(fixture.paths, plan.plan.id, human);
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

async function runAndReconcile(...args: Parameters<typeof runFury>) {
  const result = await runFury(...args);
  await reconcileFuryRun(args[0], result.run.id);
  return { ...result, run: await readFuryRun(args[0], result.run.id) };
}
async function completeAndReconcile(...args: Parameters<typeof completeFuryStep>) {
  const result = await completeFuryStep(...args);
  await reconcileFuryRun(args[0], result.run.id);
  return { ...result, run: await readFuryRun(args[0], result.run.id) };
}
async function reviewAndReconcile(...args: Parameters<typeof actOnReview>) {
  const result = await actOnReview(...args);
  await reconcileFuryRun(args[0], result.run.id);
  return { ...result, run: await readFuryRun(args[0], result.run.id) };
}
