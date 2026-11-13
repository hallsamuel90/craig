import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CraigPaths } from "../../state/craig-paths.js";
import { acquireRuntimeLock } from "./ownership.js";

declare const __CRAIG_BUILD_ID__: string | undefined;
const execute = promisify(execFile);
const PRODUCTION_DEPENDENCIES = ["@xterm/headless", "node-pty", "picocolors", "terminal-kit"];
export interface ArtifactManifest {
  schemaVersion: 1;
  artifactId: string;
  nodeExecutable: string;
  nodeAbi: string;
  platform: string;
  architecture: string;
  files: Record<string, string>;
}
export async function runtimeCacheRoot(): Promise<string> {
  return path.resolve(process.env.CRAIG_RUNTIME_CACHE ?? path.join(homedir(), ".cache", "craig", "runtimes"));
}
async function packageManifest(name: string, from: string): Promise<string> {
  const require = createRequire(from);
  try { return require.resolve(`${name}/package.json`); }
  catch {
    let directory = path.dirname(require.resolve(name));
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, "package.json");
      const value = await readFile(manifest, "utf8").then((text) => JSON.parse(text) as { name?: string }).catch(() => null);
      if (value?.name === name) return manifest;
      directory = path.dirname(directory);
    }
    throw new Error(`Cannot resolve production dependency ${name}.`);
  }
}
async function copyPackage(manifestPath: string, destination: string, ancestry = new Map<string, string>()): Promise<void> {
  const source = await realpath(path.dirname(manifestPath));
  const previous = ancestry.get(source);
  if (previous) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await symlink(path.relative(path.dirname(destination), previous), destination, "dir"); return;
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, dereference: true, filter: (entry) => entry === source || path.basename(entry) !== "node_modules" });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  const next = new Map(ancestry).set(source, destination);
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
    let resolved: string;
    try { resolved = await packageManifest(dependency, manifestPath); }
    catch (error) { if (dependency in (manifest.optionalDependencies ?? {})) continue; throw error; }
    await copyPackage(resolved, path.join(destination, "node_modules", dependency), next);
  }
}
export async function materializeRuntimeDependencies(bundle: string, destination: string): Promise<void> {
  for (const dependency of PRODUCTION_DEPENDENCIES) await copyPackage(await packageManifest(dependency, bundle), path.join(destination, "node_modules", dependency));
}

async function contentManifest(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (name === "manifest.json") continue;
      if (entry.isSymbolicLink()) {
        const target = await realpath(path.join(root, name));
        if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Artifact contains an external dependency link.");
        // Internal cycles are represented by a verified relative reference.
        result[name] = `link:${path.relative(root, target)}`;
      } else if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) result[name] = createHash("sha256").update(await readFile(path.join(root, name))).digest("hex");
      else throw new Error("Unsupported artifact filesystem entry.");
    }
  };
  await visit(""); return result;
}
export async function verifyRuntimeArtifact(directory: string): Promise<ArtifactManifest> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe runtime artifact ownership.");
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as ArtifactManifest;
  if (manifest.schemaVersion !== 1 || manifest.nodeAbi !== process.versions.modules || manifest.nodeExecutable !== await realpath(process.execPath) || manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new Error("Pinned runtime Node/ABI/platform mismatch.");
  const files = await contentManifest(directory);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error("Pinned runtime content verification failed.");
  const expected = createHash("sha256").update(JSON.stringify(files)).update(manifest.nodeAbi).update(manifest.platform).update(manifest.architecture).digest("hex");
  if (expected !== manifest.artifactId) throw new Error("Pinned runtime manifest identity mismatch.");
  return manifest;
}

/** Publishes a complete private bundle/dependency closure before any runtime launch. */
export async function pinRuntimeArtifact(paths: CraigPaths, bundleOverride?: string): Promise<string> {
  const cacheRoot = await runtimeCacheRoot();
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(cacheRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe runtime cache ownership.");
  const release = await acquireRuntimeLock({ ...paths, runtimeDir: cacheRoot }, "cache");
  const temporary = path.join(cacheRoot, `.creating-${randomUUID()}`);
  const buildDirectory = path.join(cacheRoot, `.bundling-${randomUUID()}`);
  try {
    let bundle = bundleOverride ?? process.argv[1];
    if (!bundle) throw new Error("Cannot resolve the runtime executable.");
    let dependencyBase = bundle;
    if (!bundleOverride && typeof __CRAIG_BUILD_ID__ === "undefined") {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
      bundle = path.join(buildDirectory, "cli.js");
      await execute(process.execPath, [path.join(root, "scripts", "build-npm.mjs")], { cwd: root, env: { ...process.env, CRAIG_BUILD_OUTFILE: bundle } });
      dependencyBase = path.join(root, "package.json");
    }
    bundle = await realpath(bundle);
    await mkdir(temporary, { mode: 0o700 });
    await cp(bundle, path.join(temporary, "cli.js"));
    await writeFile(path.join(temporary, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
    await materializeRuntimeDependencies(dependencyBase, temporary);
    const files = await contentManifest(temporary);
    const nodeAbi = process.versions.modules!;
    const artifactId = createHash("sha256").update(JSON.stringify(files)).update(nodeAbi).update(process.platform).update(process.arch).digest("hex");
    const manifest: ArtifactManifest = { schemaVersion: 1, artifactId, nodeExecutable: await realpath(process.execPath), nodeAbi, platform: process.platform, architecture: process.arch, files };
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const destination = path.join(cacheRoot, artifactId);
    if (await lstat(destination).catch(() => null)) { await verifyRuntimeArtifact(destination); return destination; }
    await rename(temporary, destination);
    await verifyRuntimeArtifact(destination);
    return destination;
  } finally { await rm(buildDirectory, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true }); await release(); }
}
