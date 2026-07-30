import { describe, expect, test } from "vitest";

import { buildTaskRecord } from "./test-helpers.js";
import { resolvePtySessionSpec } from "../src/ui/pty/session.js";

describe("PTY session context", () => {
  test("injects workspace, task, and agent-tab identity into agent sessions", () => {
    const workspaceRoot = "/tmp/craig";
    const task = buildTaskRecord(workspaceRoot, { id: "task_1" });
    const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent")!;

    expect(
      resolvePtySessionSpec(
        {
          workspaceRoot,
          repos: [],
          tasks: [task],
          inspection: null,
        },
        agentTab.id,
        workspaceRoot,
      ),
    ).toMatchObject({
      cwd: task.worktreePath,
      env: {
        CRAIG_WORKSPACE_ROOT: workspaceRoot,
        CRAIG_TASK_ID: task.id,
        CRAIG_AGENT_TAB_ID: agentTab.id,
      },
    });
  });

  test("does not claim an agent-tab identity for a terminal tab", () => {
    const workspaceRoot = "/tmp/craig";
    const task = buildTaskRecord(workspaceRoot, { id: "task_1" });
    const terminalTab = task.ptyTabs.find((tab) => tab.kind === "terminal")!;
    const spec = resolvePtySessionSpec(
      {
        workspaceRoot,
        repos: [],
        tasks: [task],
        inspection: null,
      },
      terminalTab.id,
      workspaceRoot,
    );

    expect(spec.env).toMatchObject({
      CRAIG_WORKSPACE_ROOT: workspaceRoot,
      CRAIG_TASK_ID: task.id,
    });
    expect(spec.env).not.toHaveProperty("CRAIG_AGENT_TAB_ID");
  });
});
