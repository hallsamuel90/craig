import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReleaseTarget, renderFormula } from "./release-plan.mjs";

test("release preflight rejects wrong commit/tag, existing assets and unqualified artifacts", () => {
  const plan = { tag: "craig-cli@1.2.3", commit: "a".repeat(40), assets: [{ name: "craig-1.2.3-darwin-arm64.tar.gz", sha256: "b".repeat(64) }, { name: "SHA256SUMS", sha256: "c".repeat(64) }], signing: "developer-id", notarized: true, dirty: false };
  const target = { tag: plan.tag, tagCommit: plan.commit, assets: [] };
  assert.doesNotThrow(() => validateReleaseTarget(plan, target));
  assert.throws(() => validateReleaseTarget(plan, { ...target, tag: "latest" }), /tag\/commit/);
  assert.throws(() => validateReleaseTarget(plan, { ...target, tagCommit: "b".repeat(40) }), /tag\/commit/);
  assert.throws(() => validateReleaseTarget(plan, { ...target, assets: [{ name: "craig-1.2.3-darwin-arm64.tar.gz" }] }), /already exists/);
  for (const change of [{ dirty: true }, { notarized: false }, { signing: "ad-hoc-development-only" }]) {
    assert.throws(() => validateReleaseTarget({ ...plan, ...change }, target), /qualification/);
  }
  assert.throws(() => validateReleaseTarget({ ...plan, dirty: undefined }, target), /qualification/);
  assert.throws(() => validateReleaseTarget({ ...plan, assets: [] }, target), /asset inventory/);
  assert.throws(() => validateReleaseTarget({ ...plan, assets: plan.assets.map((asset) => ({ ...asset, sha256: "missing" })) }, target), /asset inventory/);
});
test("Homebrew recipe inputs are versioned and cannot inject Ruby", () => {
  const url = "https://github.com/hallsamuel90/craig/releases/download/craig-cli%401.2.3/craig-1.2.3-darwin-arm64.tar.gz";
  assert.equal(renderFormula("@VERSION@ @URL@ @SHA256@", "1.2.3", url, "a".repeat(64)), `1.2.3 ${url} ${"a".repeat(64)}`);
  assert.throws(() => renderFormula("@VERSION@", '1.2.3"; system("oops")', url, "a".repeat(64)));
  assert.throws(() => renderFormula('@URL@', "1.2.3", `${url}#{system('false')}`, "a".repeat(64)), /Unsafe/);
  assert.throws(() => renderFormula('@URL@', "1.2.4", url, "a".repeat(64)), /Unsafe/);
});

test("unnotarized preview is explicit and preserves truthful signing state", () => {
  const plan = { tag: "craig-cli@1.2.3", commit: "a".repeat(40), assets: [{ name: "craig-1.2.3-darwin-arm64.tar.gz", sha256: "b".repeat(64) }, { name: "SHA256SUMS", sha256: "c".repeat(64) }], policy: "unnotarized-preview", signing: "ad-hoc-development-only", notarized: false, dirty: false };
  const target = { tag: plan.tag, tagCommit: plan.commit, assets: [] };
  assert.doesNotThrow(() => validateReleaseTarget(plan, target));
  for (const change of [{ policy: undefined }, { policy: "preview" }, { signing: "unsigned" }, { signing: "developer-id" }, { notarized: true }, { dirty: true }, { dirty: undefined }]) assert.throws(() => validateReleaseTarget({ ...plan, ...change }, target));
  assert.throws(() => validateReleaseTarget(plan, { ...target, tagCommit: "b".repeat(40) }));
  assert.throws(() => validateReleaseTarget(plan, { ...target, assets: [{name:"SHA256SUMS"}] }));
});

test("proposed tap formula pins the reviewed version/hash and preserves notices", async () => {
  const { readFileSync } = await import("node:fs");
  const template = readFileSync(new URL("../../packaging/homebrew/craig.rb.in", import.meta.url), "utf8");
  const formula = renderFormula(template, "1.2.3", "https://github.com/hallsamuel90/craig/releases/download/craig-cli%401.2.3/craig-1.2.3-darwin-arm64.tar.gz", "a".repeat(64));
  assert.ok(!/@(?:VERSION|URL|SHA256)@/.test(formula));
  assert.match(formula, /hallsamuel90\/homebrew-tap\/Formula\/craig.rb/);
  assert.match(formula, /depends_on arch: :arm64/);
  assert.match(formula, /macos: :sonoma/);
  assert.match(formula, /prefix.install "LICENSE", "THIRD_PARTY_NOTICES"/);
  assert.match(formula, /shell_output\("#\{bin\}\/craig --help"\)/);
});
