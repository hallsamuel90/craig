import { describe, expect, test } from "vitest";

import { getTaskPrimaryPr, isPrTerminal, upsertTaskPr } from "../src/domain/task/prs/state.js";
import { buildTaskRecord } from "./test-helpers.js";

function makePr(number: number, status: "open" | "merged" | "closed"): ReturnType<typeof buildTaskRecord>["prs"][number] {
  return {
    provider: "github",
    owner: null,
    repo: null,
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    title: null,
    status,
    draft: false,
    baseBranch: "main",
    headBranch: "craig/task_1",
    mergeable: false,
    mergeStateStatus: "UNKNOWN",
    requiredChecks: [],
    createdAt: null,
    updatedAt: null,
    mergedAt: null,
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    lastSyncedHeadSha: null,
  };
}

describe("getTaskPrimaryPr", () => {
  test("returns null when task has no PRs", () => {
    const task = buildTaskRecord("/tmp", { id: "task_1", prs: [] });
    expect(getTaskPrimaryPr(task)).toBeNull();
  });

  test("returns the single PR when only one exists", () => {
    const task = buildTaskRecord("/tmp", { id: "task_1", prs: [makePr(10, "open")] });
    expect(getTaskPrimaryPr(task)?.number).toBe(10);
  });

  test("returns the latest non-terminal PR when multiple exist", () => {
    const task = buildTaskRecord("/tmp", {
      id: "task_1",
      prs: [makePr(10, "merged"), makePr(11, "open")],
    });
    expect(getTaskPrimaryPr(task)?.number).toBe(11);
  });

  test("falls back to the last PR when all are terminal", () => {
    const task = buildTaskRecord("/tmp", {
      id: "task_1",
      prs: [makePr(10, "merged"), makePr(11, "closed")],
    });
    expect(getTaskPrimaryPr(task)?.number).toBe(11);
  });

  test("prefers the most recently added non-terminal PR over an older open one", () => {
    const task = buildTaskRecord("/tmp", {
      id: "task_1",
      prs: [makePr(10, "open"), makePr(11, "merged"), makePr(12, "open")],
    });
    expect(getTaskPrimaryPr(task)?.number).toBe(12);
  });
});

describe("isPrTerminal", () => {
  test("returns true for merged PR", () => {
    expect(isPrTerminal(makePr(1, "merged"))).toBe(true);
  });

  test("returns true for closed PR", () => {
    expect(isPrTerminal(makePr(1, "closed"))).toBe(true);
  });

  test("returns false for open PR", () => {
    expect(isPrTerminal(makePr(1, "open"))).toBe(false);
  });
});

describe("upsertTaskPr", () => {
  test("appends a new PR when no matching number exists", () => {
    const task = buildTaskRecord("/tmp", { id: "task_1", prs: [makePr(10, "merged")] });
    const updated = upsertTaskPr(task, makePr(11, "open"));
    expect(updated.prs).toHaveLength(2);
    expect(updated.prs[1]?.number).toBe(11);
  });

  test("updates in place when PR number already exists", () => {
    const task = buildTaskRecord("/tmp", { id: "task_1", prs: [makePr(10, "open")] });
    const updated = upsertTaskPr(task, { ...makePr(10, "merged"), mergeStateStatus: "CLEAN" });
    expect(updated.prs).toHaveLength(1);
    expect(updated.prs[0]?.status).toBe("merged");
  });

  test("keeps same-number PRs from different project repositories distinct", () => {
    const repoA = { ...makePr(10, "open"), owner: "example", repo: "repo-a" };
    const repoB = { ...makePr(10, "open"), owner: "example", repo: "repo-b" };
    const task = buildTaskRecord("/tmp", { id: "task_1", prs: [repoA] });

    const updated = upsertTaskPr(task, repoB);

    expect(updated.prs).toHaveLength(2);
    expect(updated.prs.map((pr) => pr.repo)).toEqual(["repo-a", "repo-b"]);
  });

  test("does not mutate the original task", () => {
    const task = buildTaskRecord("/tmp", { id: "task_1", prs: [makePr(10, "open")] });
    upsertTaskPr(task, makePr(11, "open"));
    expect(task.prs).toHaveLength(1);
  });
});
