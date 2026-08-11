import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getCraigPaths } from "../../../state/craig-paths.js";
import { appendLog, readLog } from "./error-store.js";

describe("application log", () => {
  it("returns an empty snapshot when the log does not exist", async () => {
    const paths = getCraigPaths("/workspace");
    const missing = { ...paths, logFile: "/tmp/craig-test-nonexistent-log.jsonl" };
    const snapshot = await readLog(missing);
    expect(snapshot).toEqual({ path: missing.logFile, lines: [], empty: true });
  });

  it("stores structured entries and formats their levels for display", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-log-test-"));
    const paths = getCraigPaths(root);
    try {
      await appendLog(paths, {
        level: "warn",
        component: "daemon",
        event: "upgrade.blocked",
        message: "Preserved live sessions.",
        details: { protocolVersion: 5 },
      });
      expect(JSON.parse(await readFile(paths.logFile, "utf8"))).toMatchObject({
        level: "warn",
        component: "daemon",
        event: "upgrade.blocked",
      });
      expect((await readLog(paths)).lines[0]).toContain(
        "WARN  daemon.upgrade.blocked — Preserved live sessions.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
