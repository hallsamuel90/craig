import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

test("actual candidate workflow accepts exact stable tags and rejects mismatched source", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/binary-build.yml", import.meta.url), "utf8"));
  const script = workflow.jobs["macos-arm64"].steps.find((step) => step.name === "Verify candidate source binding").run;
  const cwd = mkdtempSync(path.join(tmpdir(), "craig-workflow-source-"));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const verify = (tag) => execFileSync("/bin/sh", ["-c", script], { cwd, env: { ...process.env, RELEASE_TAG: tag }, stdio: "pipe" });
  try {
    mkdirSync(path.join(cwd, "packages/cli"), { recursive: true });
    writeFileSync(path.join(cwd, "packages/cli/package.json"), JSON.stringify({ version: "1.2.3" }));
    git("init", "-b", "main");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    git("tag", "craig-cli@1.2.3");
    assert.doesNotThrow(() => verify("craig-cli@1.2.3"));
    assert.throws(() => verify("craig-cli@1.2.4"));
    assert.throws(() => verify("craig-cli@1.2.3-beta.1"));
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "different source");
    assert.throws(() => verify("craig-cli@1.2.3"));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
