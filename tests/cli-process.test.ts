import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { rm } from "node:fs/promises";
import { expect, test } from "vitest";
import { createCraigState, createRepoRoot, writeTaskRecord } from "./test-helpers.js";

const exec = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve("tsx");

test("flushes large JSON success and error envelopes through real process pipes", async () => {
  const root = await createRepoRoot("craig-cli-pipe-");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CRAIG_")));
  const args = ["--import", tsx, path.resolve("src/cli.ts"), "--workspace-root", root, "--json"];
  const marker = "pipe-output-complete";
  const large = "x".repeat(512 * 1024) + marker;
  try {
    await createCraigState(root, ["task_large"]);
    await writeTaskRecord(root, { id: "task_large", title: large });
    const success = await exec(process.execPath, [...args, "task", "list"], {
      cwd: root, env: environment, maxBuffer: 4 * 1024 * 1024,
    });
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout).data.tasks[0].title).toBe(large);
    const failure = await exec(process.execPath, [...args, "y".repeat(80 * 1024) + marker], {
      cwd: root, env: environment, maxBuffer: 4 * 1024 * 1024,
    }).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure.stdout).toBe("");
    const envelope = JSON.parse(failure.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain(marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
