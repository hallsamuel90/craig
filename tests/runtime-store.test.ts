import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createCraigState, createRepoRoot } from "./test-helpers.js";
import { readSessionRuntime, writeSessionRuntime } from "../src/state/runtime-store.js";

describe("runtime-store", () => {
  test("normalizes legacy runtime files without ui state", async () => {
    const repoRoot = await createRepoRoot("craig-runtime-");
    const paths = await createCraigState(repoRoot);

    await writeFile(
      paths.sessionFile,
      JSON.stringify({
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [{ pageNumber: 1, windowTarget: "@1", isPrimary: true }],
        updatedAt: "2026-04-22T00:00:00.000Z",
      }),
      "utf8",
    );

    const runtime = await readSessionRuntime({ sessionFile: paths.sessionFile });

    expect(runtime?.ui.selectedTaskId).toBeNull();
    expect(runtime?.ui.workSurfaceMode).toBe("command");
    expect(runtime?.ui.lastOutputLines).toEqual([]);
  });

  test("writes ui state alongside tmux runtime metadata", async () => {
    const repoRoot = await createRepoRoot("craig-runtime-");
    const paths = await createCraigState(repoRoot);

    await writeSessionRuntime(
      { sessionFile: paths.sessionFile },
      {
        sessionName: "craig-test",
        controlPaneTarget: "%1",
        primaryWindowTarget: "@1",
        managedPages: [{ pageNumber: 1, windowTarget: "@1", isPrimary: true }],
        ui: {
          selectedTaskId: "task_2",
          workSurfaceMode: "command",
          lastContextView: "summary",
          lastCommandBuffer: "show task_2",
          lastOutputLines: ["task output"],
        },
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    );

    const raw = JSON.parse(await readFile(path.join(paths.runtimeDir, "session.json"), "utf8")) as {
      ui: { selectedTaskId: string; lastCommandBuffer: string; lastOutputLines: string[] };
    };

    expect(raw.ui.selectedTaskId).toBe("task_2");
    expect(raw.ui.lastCommandBuffer).toBe("show task_2");
    expect(raw.ui.lastOutputLines).toEqual(["task output"]);
  });
});
