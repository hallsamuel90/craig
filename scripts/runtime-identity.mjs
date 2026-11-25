import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

/** Content identities shared by npm and SEA; use the target native ABI for hosts. */
export async function runtimeBuildDefinitions(repoRoot, { nodeAbi = process.versions.modules, channel = "npm", nativeAddon } = {}) {
  const identityHash = createHash("sha256");
  async function hashTree(relative) {
    for (const entry of (await readdir(resolve(repoRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await hashTree(name);
      else if (entry.isFile()) identityHash.update(name).update(await readFile(resolve(repoRoot, name)));
    }
  }
  await hashTree("src");
  identityHash.update(channel);
  for (const name of ["package.json", "packages/cli/package.json", "pnpm-lock.yaml", "tsconfig.json", "scripts/build-npm.mjs", "scripts/runtime-identity.mjs", "scripts/binary/build.mjs", "scripts/binary/toolchain.json"]) identityHash.update(name).update(await readFile(resolve(repoRoot, name)));

  const hostGraph = await build({ entryPoints: [resolve(repoRoot, "src/shell/runtime/session-host.ts")], bundle: true, write: false, metafile: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const hostHash = createHash("sha256");
  for (const name of Object.keys(hostGraph.metafile.inputs).sort()) hostHash.update(name).update(await readFile(resolve(repoRoot, name)));
  const dependencyRequire = createRequire(import.meta.url);
  for (const name of ["node-pty", "@xterm/headless"]) hostHash.update(name).update(await readFile(dependencyRequire.resolve(name)));
  async function hashHostDependency(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue;
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) await hashHostDependency(file);
      else if (entry.isFile()) hostHash.update(entry.name).update(await readFile(file));
    }
  }
  for (const name of ["node-pty", "@xterm/headless"]) await hashHostDependency(dirname(dependencyRequire.resolve(`${name}/package.json`)));
  hostHash.update(nodeAbi ?? "");
  if (nativeAddon) hostHash.update(await readFile(nativeAddon));

  return { __CRAIG_BUILD_ID__: JSON.stringify(identityHash.digest("hex")), __CRAIG_HOST_REVISION__: JSON.stringify(hostHash.digest("hex")) };
}
