// Manual human-gated attachment only: no release creation, overwrite or tap writes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditDistribution, digest } from "./artifact.mjs";
import { validateReleaseTarget } from "./release-plan.mjs";

const repository = "hallsamuel90/craig";
export const approvalFor = (plan) => `${plan.tag}@${plan.commit}:${plan.assets.find((asset) => asset.name.endsWith(".tar.gz")).sha256}`;
export function releaseTarget(gh, tag) {
  const api = (route) => JSON.parse(gh(["api", `repos/${repository}/${route}`]));
  let object = api(`git/ref/tags/${encodeURIComponent(tag)}`).object;
  for (let depth = 0; object.type === "tag" && depth < 8; depth++) object = api(`git/tags/${object.sha}`).object;
  if (object.type !== "commit") throw new Error("Tag does not resolve to a commit");
  const release = api(`releases/tags/${encodeURIComponent(tag)}`);
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== tag) throw new Error("Expected existing published stable release");
  const pages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/releases/${release.id}/assets?per_page=100`]));
  return { tag: release.tag_name, tagCommit: object.sha, assets: pages.flat() };
}
export function attachRelease({ plan, directory, approval, gh, audit, sourceCommit, sourceDirty }) {
  if (approval !== approvalFor(plan)) throw new Error("Human approval must bind exact tag, commit and archive hash");
  if (sourceCommit !== plan.commit || sourceDirty !== false) throw new Error("Checkout must match clean build source");
  // Validate shape before using any supplied filename.
  validateReleaseTarget(plan, { tag: plan.tag, tagCommit: plan.commit, assets: [] });
  const stage = mkdtempSync(path.join(tmpdir(), "craig-release-"));
  try {
    for (const asset of plan.assets) {
      const bytes = readFileSync(path.join(directory, asset.name));
      if (digest(bytes) !== asset.sha256) throw new Error(`Asset checksum mismatch: ${asset.name}`);
      writeFileSync(path.join(stage, asset.name), bytes, { mode: 0o600 });
    }
    const archive = plan.assets.find((asset) => asset.name.endsWith(".tar.gz"));
    const files = new Map(auditDistribution(readFileSync(path.join(stage, archive.name))).map((file) => [file.path, file.bytes]));
    const metadata = JSON.parse(files.get("build.json"));
    for (const key of ["commit", "dirty", "signing", "notarized"]) if (metadata[key] !== plan[key]) throw new Error(`Build metadata mismatch: ${key}`);
    if (metadata.version !== plan.tag.slice("craig-cli@".length) || metadata.target !== "darwin-arm64") throw new Error("Build version/target mismatch");
    if (readFileSync(path.join(stage, "SHA256SUMS"), "utf8") !== `${archive.sha256}  ${archive.name}\n`) throw new Error("Checksum inventory mismatch");
    audit(path.join(stage, archive.name)); // Full embedded payload, licenses, ABI, signature/linkage audit.
    validateReleaseTarget(plan, releaseTarget(gh, plan.tag)); // Fresh inventory immediately before write.
    gh(["release", "upload", plan.tag, ...plan.assets.map((asset) => path.join(stage, asset.name)), "--repo", repository]);
    // No --clobber, deletion or retry. A partial upload requires human investigation.
    const remote = path.join(stage, "download");
    gh(["release", "download", plan.tag, "--repo", repository, "--dir", remote, ...plan.assets.flatMap((asset) => ["--pattern", asset.name])]);
    for (const asset of plan.assets) if (digest(readFileSync(path.join(remote, asset.name))) !== asset.sha256) throw new Error("Remote checksum mismatch; stop publication");
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [planFile, approval, ...extra] = process.argv.slice(2);
  if (!planFile || !approval || extra.length) throw new Error("Usage: attach-release.mjs <release-assets.json> '<tag>@<commit>:<archive-sha256>' (only after human publication review)");
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const root = path.resolve(import.meta.dirname, "../..");
  process.chdir(root);
  attachRelease({ plan: JSON.parse(readFileSync(planFile)), directory: path.resolve(path.dirname(planFile), ".."), approval,
    sourceCommit: run("git", ["rev-parse", "HEAD"]).trim(), sourceDirty: run("git", ["status", "--porcelain"]).trim().length > 0,
    gh: (args) => run("gh", args), audit: (archive) => run(process.execPath, [path.join(root, "scripts/binary/audit.mjs"), archive]) });
  console.log("Attached and downloaded exact reviewed assets; tap publication remains separate.");
}
