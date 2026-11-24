// Offline preparation. Attachment is a separate explicitly authorized command.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditDistribution, digest } from "./artifact.mjs";

export function validatePolicy(plan) {
  if (plan.dirty !== false) throw new Error("Release requires clean source qualification");
  if (plan.policy === "unnotarized-preview") {
    if (plan.signing !== "ad-hoc-development-only" || plan.notarized !== false) throw new Error("Preview requires truthful ad-hoc, unnotarized qualification");
  } else if (plan.policy === undefined || plan.policy === "notarized") {
    if (plan.signing !== "developer-id" || plan.notarized !== true) throw new Error("Release requires Developer ID signing and notarization qualification");
  } else throw new Error("Unknown release policy");
}
export function validateReleaseTarget(plan, release) {
  if (!/^craig-cli@\d+\.\d+\.\d+$/.test(plan.tag) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(plan.commit)
      || release.tag !== plan.tag || release.tagCommit !== plan.commit) throw new Error("Release tag/commit does not match the build");
  if (!Array.isArray(release.assets)) throw new Error("Invalid release asset inventory");
  const version = plan.tag.slice("craig-cli@".length);
  const expectedAssets = [`craig-${version}-darwin-arm64.tar.gz`, "SHA256SUMS"];
  if (!Array.isArray(plan.assets) || plan.assets.length !== 2 || new Set(plan.assets.map((asset) => asset?.name)).size !== 2
      || plan.assets.some((asset) => !asset || !expectedAssets.includes(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256))
      || release.assets.some((asset) => !asset || typeof asset.name !== "string")) throw new Error("Invalid release asset inventory");
  if (release.assets.some((asset) => plan.assets.some((candidate) => candidate.name === asset.name))) throw new Error("Release asset already exists; immutable assets must not be overwritten");
  validatePolicy(plan);
}
export function renderFormula(template, version, url, sha256) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256)
      || url !== `https://github.com/hallsamuel90/craig/releases/download/${encodeURIComponent(`craig-cli@${version}`)}/craig-${version}-darwin-arm64.tar.gz`) throw new Error("Unsafe formula inputs");
  return template.replaceAll("@VERSION@", version).replaceAll("@URL@", url).replaceAll("@SHA256@", sha256);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--policy" || !["notarized", "unnotarized-preview"].includes(args[1]))) throw new Error("Use --policy unnotarized-preview or --policy notarized");
  const policy = args[1] ?? "notarized";
  const root = path.resolve(import.meta.dirname, "../..");
  const version = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"))).version;
  const directory = path.join(root, "dist/binary");
  const name = `craig-${version}-darwin-arm64.tar.gz`;
  const bytes = readFileSync(path.join(directory, name));
  const files = new Map(auditDistribution(bytes).map((file) => [file.path, file.bytes]));
  const metadata = JSON.parse(files.get("build.json"));
  if (metadata.version !== version) throw new Error("Build and package versions differ");
  const checksum = digest(bytes);
  if (readFileSync(path.join(directory, "SHA256SUMS"), "utf8") !== `${checksum}  ${name}\n`) throw new Error("Release archive checksum mismatch");
  const tag = `craig-cli@${version}`;
  const url = `https://github.com/hallsamuel90/craig/releases/download/${encodeURIComponent(tag)}/${name}`;
  const plan = { enabled: false, policy, tag, commit: metadata.commit, dirty: metadata.dirty,
    signing: metadata.signing, notarized: metadata.notarized,
    assets: [{ name, sha256: checksum }, { name: "SHA256SUMS", sha256: digest(readFileSync(path.join(directory, "SHA256SUMS"))) }],
    prerequisites: ["Human publication authorization", "Required gates passed", "Document installation evidence and untested hosts", "Verified remote tag commit and non-conflicting assets", policy === "unnotarized-preview" ? "Explicit acceptance of unnotarized preview and Gatekeeper limitations" : "Developer ID and notarization qualification"],
  };
  const draft = path.join(directory, "draft");
  mkdirSync(draft, { recursive: true });
  writeFileSync(path.join(draft, "release-assets.json"), JSON.stringify(plan, null, 2));
  writeFileSync(path.join(draft, "craig.rb"), renderFormula(readFileSync(path.join(root, "packaging/homebrew/craig.rb.in"), "utf8"), version, url, checksum));
  console.log("Prepared offline release intent and Homebrew recipe in dist/binary/draft; publication remains disabled.");
}
