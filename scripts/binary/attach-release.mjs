// Human or policy-authorized CI attachment: no release creation, overwrite or tap writes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditDistribution, digest } from "./artifact.mjs";
import { validateReleaseTarget } from "./release-plan.mjs";
import { ciContext, validateCIContext, verifyCIProvenance } from "./ci-authorization.mjs";

const repository = "hallsamuel90/craig";
export const approvalFor = (plan) => `${plan.tag}@${plan.commit}:${plan.assets.find((asset) => asset.name.endsWith(".tar.gz")).sha256}`;
export function releaseTarget(gh, tag) {
  const api = (route) => JSON.parse(gh(["api", "--hostname", "github.com", `repos/${repository}/${route}`]));
  let object = api(`git/ref/tags/${encodeURIComponent(tag)}`).object;
  for (let depth = 0; object.type === "tag" && depth < 8; depth++) object = api(`git/tags/${object.sha}`).object;
  if (object.type !== "commit") throw new Error("Tag does not resolve to a commit");
  const release = api(`releases/tags/${encodeURIComponent(tag)}`);
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== tag) throw new Error("Expected existing published stable release");
  const pages = JSON.parse(gh(["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${repository}/releases/${release.id}/assets?per_page=100`]));
  return { tag: release.tag_name, tagCommit: object.sha, assets: pages.flat() };
}
export function attachRelease({ plan, directory, approval, gh, audit, sourceCommit, sourceDirty, ci, planSha256, sourceVersion }) {
  if (ci) {
    if (approval !== undefined) throw new Error("CI authorization must not impersonate human approval");
    validateCIContext(ci, plan, planSha256, sourceVersion);
    verifyCIProvenance(ci, gh);
  } else if (approval !== approvalFor(plan)) throw new Error("Human approval must bind exact tag, commit and archive hash");
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
    const target = releaseTarget(gh, plan.tag); // Fresh inventory immediately before write.
    validateReleaseTarget(plan, { ...target, assets: [] });
    const existing = target.assets.filter((asset) => plan.assets.some((candidate) => candidate.name === asset.name));
    const reuse = ci && existing.length === plan.assets.length;
    // Only CI can verify an already complete release. Partial/mismatched assets
    // fail visibly. Manual publication retains its strict conflict contract.
    if (!reuse) {
      validateReleaseTarget(plan, target);
      gh(["release", "upload", plan.tag, ...plan.assets.map((asset) => path.join(stage, asset.name)), "--repo", `github.com/${repository}`]);
    }
    if (releaseTarget(gh, plan.tag).tagCommit !== plan.commit) throw new Error("Remote tag moved after upload; stop publication");
    // No --clobber, deletion or retry. A partial upload requires human investigation.
    const remote = path.join(stage, "download");
    gh(["release", "download", plan.tag, "--repo", `github.com/${repository}`, "--dir", remote, ...plan.assets.flatMap((asset) => ["--pattern", asset.name])]);
    for (const asset of plan.assets) if (digest(readFileSync(path.join(remote, asset.name))) !== asset.sha256) throw new Error("Remote checksum mismatch; stop publication");
    if (releaseTarget(gh, plan.tag).tagCommit !== plan.commit) throw new Error("Remote tag moved during verification; stop publication");
    return reuse ? "verified-existing" : "uploaded";
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const ciMode = args[0] === "--ci";
  if (ciMode) args.shift();
  const [planFile, approval, ...extra] = args;
  if (!planFile || (ciMode ? approval !== undefined : !approval) || extra.length) throw new Error("Usage: attach-release.mjs <release-assets.json> '<tag>@<commit>:<archive-sha256>' (only after human publication review)");
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const root = path.resolve(import.meta.dirname, "../..");
  process.chdir(root);
  const planBytes = readFileSync(planFile);
  const result = attachRelease({ plan: JSON.parse(planBytes), directory: path.resolve(path.dirname(planFile), ".."), approval,
    ...(ciMode ? { ci: ciContext(process.env), planSha256: digest(planBytes), sourceVersion: JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"))).version } : {}),
    sourceCommit: run("git", ["rev-parse", "HEAD"]).trim(), sourceDirty: run("git", ["status", "--porcelain"]).trim().length > 0,
    gh: (args) => run("gh", args), audit: (archive) => run(process.execPath, [path.join(root, "scripts/binary/audit.mjs"), archive]) });
  console.log(`Release assets ${result} and hash-verified; tap publication remains separate.`);
}
