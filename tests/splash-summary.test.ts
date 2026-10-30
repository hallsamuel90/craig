import { describe, expect, test } from "vitest";
import { buildSplashSummary } from "../src/ui/splash.js";
import type { WorkspaceShellModel } from "../src/ui/shell/data.js";
import { buildTaskRecord } from "./test-helpers.js";

describe("splash summary", () => {
  const tasks = ["working", "ready", "error", "closed", "merged"].map((id) => buildTaskRecord("/tmp/craig", {
    id, status: id === "closed" ? "closed" : id === "merged" ? "merged" : "running",
  }));
  const model: WorkspaceShellModel = {
    workspaceRoot: "/tmp/craig", tasks, inspection: null,
    repos: [{ id: "repo", name: "craig", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
  };
  const now = 10_000;
  const snapshots = tasks.flatMap((task) => task.ptyTabs.map((tab) => ({
    taskId: task.id, tabId: tab.id,
    sessionState: task.id === "error" ? "failed" as const : "running" as const,
    lastActivityAt: task.id === "ready" ? 0 : now,
    exitCode: null, error: task.id === "error" ? "launch failed" : null,
  })));

  test("counts agent tabs without counting terminals or finished tasks", () => {
    expect(buildSplashSummary(model, snapshots, now, true)).toEqual({
      workspaceCount: 1, taskCount: 3, workingAgents: 1, readyAgents: 1, attentionAgents: 1, activityKnown: true,
    });
  });

  test("keeps activity unknown until hydration finishes", () => {
    expect(buildSplashSummary(model, snapshots, now, false)).toMatchObject({
      taskCount: 3, workingAgents: 0, readyAgents: 0, attentionAgents: 0, activityKnown: false,
    });
  });
});
