import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { build, version as esbuildVersion } from "esbuild";
import { archiveFiles, auditDistribution, auditResource, digest, makePayload, manifestOf } from "./artifact.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const config = JSON.parse(readFileSync(new URL("./toolchain.json", import.meta.url)));
const allowlist = JSON.parse(readFileSync(new URL("./payload-allowlist.json", import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--sign-identity" || !args[1])) throw new Error("Usage: build.mjs [--sign-identity <Developer ID identity>]");
const signingIdentity = args[1] ?? "-";
const output = path.join(root, ".craig/binary-build");
const capture = (file, args, options = {}) => execFileSync(file, args, { cwd: root, encoding: "utf8", ...options }).trim();
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, stdio: "inherit", ...options });
if (`${process.platform}-${process.arch}` !== config.target) throw new Error(`Build on ${config.target}; cross-compilation is not supported`);
if (process.versions.node !== config.buildNode) throw new Error(`Use pinned build-driver Node ${config.buildNode}`);
if (capture("pnpm", ["--version"]) !== config.pnpm) throw new Error("Install the pinned pnpm version");
if (esbuildVersion !== config.esbuild) throw new Error("Review the pinned esbuild version");
const clang = capture("xcrun", ["clang", "--version"]).split("\n")[0];
const sdk = capture("xcrun", ["--show-sdk-version"]);
if (clang !== config.clang || sdk !== config.sdk) throw new Error(`Select the pinned Apple toolchain: ${config.clang}, SDK ${config.sdk}`);
mkdirSync(path.join(output, "downloads"), { recursive: true });
const archiveName = `node-v${config.node}-${config.target}.tar.gz`;
const archivePath = path.join(output, "downloads", archiveName);
if (!existsSync(archivePath)) {
  const response = await fetch(`https://nodejs.org/dist/v${config.node}/${archiveName}`);
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
}
if (digest(readFileSync(archivePath)) !== config.nodeArchiveSha256) throw new Error("Downloaded Node checksum mismatch; remove the corrupt download and retry");
// Always extract from the verified distribution, never trust a mutable cached Node.
const toolchain = path.join(output, "toolchain");
rmSync(toolchain, { recursive: true, force: true });
mkdirSync(toolchain, { recursive: true });
run("/usr/bin/tar", ["-xzf", archivePath, "-C", toolchain, "--strip-components=1"]);
const node = path.join(toolchain, "bin/node");
const npm = path.join(toolchain, "lib/node_modules/npm");
if (capture(node, ["-p", "process.versions.node + ':' + process.versions.modules"]) !== `${config.node}:${config.nodeAbi}`
    || JSON.parse(readFileSync(path.join(npm, "node_modules/node-gyp/package.json"))).version !== config.nodeGyp) throw new Error("Unexpected Node/native build toolchain");
const packageSources = new Map([[".", root]]);
function resolvePackage(name, parent) {
  const require = createRequire(path.join(parent, "package.json"));
  let directory;
  try { directory = path.dirname(require.resolve(`${name}/package.json`)); }
  catch {
    directory = path.dirname(require.resolve(name));
    while (!existsSync(path.join(directory, "package.json")) || JSON.parse(readFileSync(path.join(directory, "package.json"))).name !== name) {
      if (path.dirname(directory) === directory) throw new Error(`Cannot locate ${name}`);
      directory = path.dirname(directory);
    }
  }
  return realpathSync(directory);
}
for (const pkg of allowlist) {
  const source = resolvePackage(pkg.name, packageSources.get(pkg.parent));
  if (JSON.parse(readFileSync(path.join(source, "package.json"))).version !== pkg.version) throw new Error(`Review the allowlist for changed dependency ${pkg.name}`);
  packageSources.set(pkg.path, source);
}
const pty = packageSources.get("node_modules/node-pty");
const native = path.join(output, "native/node-pty");
rmSync(path.dirname(native), { recursive: true, force: true });
mkdirSync(native, { recursive: true });
for (const entry of ["src", "deps", "binding.gyp", "package.json"]) cpSync(path.join(pty, entry), path.join(native, entry), { recursive: true });
const nan = resolvePackage("nan", pty);
if (JSON.parse(readFileSync(path.join(nan, "package.json"))).version !== config.nan) throw new Error("Unexpected native header version");
cpSync(nan, path.join(native, "node_modules/nan"), { recursive: true });
run(node, [path.join(npm, "node_modules/node-gyp/bin/node-gyp.js"), "rebuild", `--nodedir=${toolchain}`], {
  cwd: native,
  env: { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH ?? ""}`,
    CXXFLAGS: `-g0 -ffile-prefix-map=${root}=. -fdebug-prefix-map=${root}=.`,
    CFLAGS: `-g0 -ffile-prefix-map=${root}=. -fdebug-prefix-map=${root}=.`,
  },
});
const addon = path.join(native, "build/Release/pty.node");
run("/usr/bin/strip", ["-S", "-x", addon]);
run("/usr/bin/codesign", ["--force", "--sign", signingIdentity, ...(signingIdentity === "-" ? [] : ["--timestamp", "--options", "runtime"]), addon]);
if (signingIdentity !== "-") run("/usr/bin/codesign", ["--verify", "--strict", "-R", "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", addon]);
run(node, ["-e", "require(process.argv[1])", addon]);
const linkage = capture("/usr/bin/otool", ["-L", addon]).split("\n").slice(1).map((line) => line.trim().split(" ")[0]);
if (linkage.some((lib) => !lib.startsWith("/usr/lib/") && !lib.startsWith("/System/Library/"))) throw new Error("Unexpected native library linkage");
const pkg = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json")));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Standalone artifacts require an exact stable package version");
const staging = path.join(output, "staging");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
await build({ entryPoints: [path.join(root, "src/cli.ts")], outfile: path.join(staging, "cli.js"),
  platform: "node", format: "esm", target: "node26", bundle: true, minify: true, sourcemap: false,
  external: Object.keys(pkg.dependencies), define: { __CRAIG_VERSION__: JSON.stringify(pkg.version) },
  alias: { yaml: path.join(root, "node_modules/yaml/browser/index.js") },
});
const files = [];
const add = (name, bytes, mode = 0o600) => files.push({ path: name, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mode });
add("cli.js", readFileSync(path.join(staging, "cli.js")));
add("package.json", '{"type":"module"}\n');
add("launch.cjs", 'import("./cli.js").catch(error => { console.error(error); process.exitCode = 1; });\n');
const notices = [`Craig\n${readFileSync(path.join(root, "LICENSE"), "utf8")}`, `Node ${config.node}\n${readFileSync(path.join(toolchain, "LICENSE"), "utf8")}`];
for (const item of allowlist) {
  const source = packageSources.get(item.path);
  if (!item.files.some((file) => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(file))
      && !["@xterm/headless", "node-bitmap", "omggif"].includes(item.name)) throw new Error(`Missing license inventory: ${item.name}`);
  for (const name of item.files) {
    const location = path.join(source, name);
    const stat = lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Allowlisted resource is not a regular file: ${item.name}/${name}`);
    let bytes = readFileSync(location);
    if (name === "package.json") {
      const original = JSON.parse(bytes);
      bytes = Buffer.from(JSON.stringify(Object.fromEntries(["name", "version", "main", "type", "exports", "browser"].filter((key) => original[key] !== undefined).map((key) => [key, original[key]]))));
    } else if (/\.(?:js|mjs|cjs)$/.test(name)) bytes = Buffer.from(bytes.toString("utf8").replace(/\/\/[#@] sourceMappingURL=[^\r\n]*/g, ""));
    add(`${item.path}/${name}`, bytes);
    if (/^(?:LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(name)) notices.push(`${item.name} ${item.version}\n${bytes.toString("utf8")}`);
  }
  if (item.name === "@xterm/headless") notices.push(`@xterm/headless ${item.version}\n${readFileSync(new URL("./licenses/xterm-LICENSE", import.meta.url), "utf8")}`);
  if (item.name === "omggif") notices.push(`omggif ${item.version}\n${readFileSync(path.join(source, "omggif.js"), "utf8").split('"use strict"')[0]}`);
  if (item.name === "node-bitmap") {
    const readme = readFileSync(path.join(source, "README.md"), "utf8");
    const index = readme.indexOf("## License");
    if (index < 0) throw new Error("Missing node-bitmap license");
    notices.push(`node-bitmap ${item.version}\n${readme.slice(index)}`);
  }
}
notices.push(`NAN ${config.nan}\n${readFileSync(path.join(nan, "LICENSE.md"), "utf8")}`);
const yaml = resolvePackage("yaml", root);
if (JSON.parse(readFileSync(path.join(yaml, "package.json"))).version !== config.yaml) throw new Error("Review the bundled YAML version");
notices.push(`yaml ${config.yaml}\n${readFileSync(path.join(yaml, "LICENSE"), "utf8")}`);
add("node_modules/node-pty/build/Release/pty.node", readFileSync(addon));
const thirdParty = notices.join("\n\n----------------------------------------\n\n");
add("THIRD_PARTY_NOTICES", thirdParty);
const payload = makePayload(files);
const payloadFile = path.join(staging, "payload.gz");
writeFileSync(payloadFile, gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
const metadata = { format: 1, version: pkg.version, target: config.target, node: config.node, nodeAbi: config.nodeAbi,
  nodeArchiveSha256: config.nodeArchiveSha256, nodeGyp: config.nodeGyp, nan: config.nan, pnpm: config.pnpm,
  bundledDependencies: { yaml: config.yaml }, esbuild: config.esbuild,
  upstreamRuntimePathInventorySha256: config.upstreamRuntimePathInventorySha256,
  buildNode: config.buildNode, sdk, clang, linkage, payloadIdentity: payload.identity, commit: capture("git", ["rev-parse", "HEAD"]),
  dirty: capture("git", ["status", "--porcelain"]).length > 0,
  dependencies: allowlist.map(({ path: location, name, version }) => ({ path: location, name, version })),
  signing: signingIdentity === "-" ? "ad-hoc-development-only" : "developer-id", notarized: false,
};
writeFileSync(path.join(staging, "build.json"), JSON.stringify(metadata));
await build({ entryPoints: [path.join(root, "scripts/binary/bootstrap.cjs")], outfile: path.join(staging, "bootstrap.cjs"),
  platform: "node", format: "cjs", target: "node26", bundle: true, minify: true, sourcemap: false,
  define: { __CRAIG_PAYLOAD_ID__: JSON.stringify(payload.identity) },
});
const binary = path.join(output, "craig");
writeFileSync(path.join(staging, "sea.json"), JSON.stringify({ main: "bootstrap.cjs", output: binary,
  disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, execArgvExtension: "none",
  assets: { payload: payloadFile, build: path.join(staging, "build.json") },
}));
run(node, ["--build-sea", "sea.json"], { cwd: staging });
chmodSync(binary, 0o755);
const entitlements = path.join(staging, "node-entitlements.plist");
if (signingIdentity !== "-") {
  // Preserve the checksummed upstream runtime's JIT/hardened-runtime policy.
  const plist = capture("/usr/bin/codesign", ["--display", "--entitlements", ":-", node]);
  if (!plist.includes("<plist")) throw new Error("Review upstream Node entitlements before Developer ID signing");
  writeFileSync(entitlements, plist);
}
run("/usr/bin/codesign", ["--force", "--sign", signingIdentity,
  ...(signingIdentity === "-" ? [] : ["--timestamp", "--options", "runtime", "--entitlements", entitlements]), binary]);
run("/usr/bin/codesign", ["--verify", "--strict", binary]);
if (signingIdentity !== "-") run("/usr/bin/codesign", ["--verify", "--strict", "-R", "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", binary]);
auditResource("craig", readFileSync(binary));
const distribution = [
  { path: "craig", bytes: readFileSync(binary), mode: 0o755 },
  { path: "LICENSE", bytes: readFileSync(path.join(root, "LICENSE")) },
  { path: "THIRD_PARTY_NOTICES", bytes: Buffer.from(thirdParty) },
  { path: "build.json", bytes: Buffer.from(JSON.stringify(metadata, null, 2)) },
  { path: "payload-manifest.json", bytes: Buffer.from(JSON.stringify({ identity: payload.identity, files: manifestOf(payload.files) }, null, 2)) },
];
const dist = path.join(root, "dist/binary");
mkdirSync(dist, { recursive: true });
const name = `craig-${pkg.version}-${config.target}.tar.gz`;
const archive = archiveFiles(distribution);
auditDistribution(archive);
writeFileSync(path.join(dist, name), archive);
writeFileSync(path.join(dist, "SHA256SUMS"), `${digest(archive)}  ${name}\n`);
writeFileSync(path.join(dist, "build.json"), JSON.stringify(metadata, null, 2));
console.log(`Audited development artifact: dist/binary/${name} (${payload.identity})`);
