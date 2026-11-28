// Shared source selection/verification for the merge-triggered release pipeline.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { releaseTarget } from "./attach-release.mjs";
import { validateReleaseTarget } from "./release-plan.mjs";
import { digest } from "./artifact.mjs";

export function verifySource({ version, tag, commit, head, tagCommit, dirty }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `craig-cli@${version}` || !/^[a-f0-9]{40}$/.test(commit)
      || head !== commit || tagCommit !== commit || dirty !== false) throw new Error("Release source/tag/version must match the exact clean run commit");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...extra] = process.argv.slice(2);
  if (!["--select", "--verify", "--seal"].includes(mode) || extra.length) throw new Error("Use --select, --verify or --seal");
  const root = path.resolve(import.meta.dirname, "../..");
  process.chdir(root);
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
  const version = JSON.parse(readFileSync("packages/cli/package.json")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected stable package version");
  const tag = `craig-cli@${version}`;
  const head = run("git", ["rev-parse", "HEAD"]);
  const commit = process.env.GITHUB_SHA;
  const dirty = run("git", ["status", "--porcelain"]).length > 0;
  const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (mode === "--select") {
    if (head !== commit || dirty) throw new Error("Release selection requires clean run source");
    const target = releaseTarget((args) => run("gh", args), tag);
    // Most main pushes retain the previous npm version/tag. Do not retrofit a
    // binary built from newer source onto that older release.
    output("binary_eligible", String(target.tagCommit === commit));
    output("binary_tag", tag);
    output("binary_commit", commit);
    console.log(target.tagCommit === commit ? "Exact release source eligible" : "Existing version belongs to older source: binary CD skipped");
  } else {
    verifySource({ version, tag: process.env.BINARY_RELEASE_TAG, commit, head, tagCommit: run("git", ["rev-parse", `${tag}^{commit}`]), dirty });
    if (mode === "--seal") {
      const bytes = readFileSync("dist/binary/draft/release-assets.json");
      const plan = JSON.parse(bytes);
      if (plan.tag !== tag || plan.commit !== commit || plan.policy !== "unnotarized-preview") throw new Error("Audited plan source/policy mismatch");
      validateReleaseTarget(plan, { tag, tagCommit: commit, assets: [] });
      output("plan_sha", digest(bytes));
      output("attempt", process.env.GITHUB_RUN_ATTEMPT);
    }
  }
}
