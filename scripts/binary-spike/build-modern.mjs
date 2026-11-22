// #309 follow-up: isolated Node 26 direct/VFS builds and Bun with node-pty 1.1.
// Run with developer Node 24; target runtimes and alternate addons stay in .craig.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "../..");
const base = path.join(root, ".craig/binary-spike");
const node26 = path.join(base, "toolchain/node_modules/node/bin/node");
const bun = path.join(base, "toolchain/node_modules/.bin/bun");
const target = process.argv[2];
if (!["node26-disk", "node26-vfs", "node26-vfs-zip", "node26-vfs-zip-cache", "bun-napi"].includes(target)) throw new Error("Choose node26-disk, node26-vfs, node26-vfs-zip, node26-vfs-zip-cache, or bun-napi");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macOS ARM64 only");
const started = performance.now();
const output = path.join(base, target);
const payload = path.join(output, "payload");
const isBun = target === "bun-napi";
const isVfs = target.startsWith("node26-vfs");
const run = (file, args) => execFileSync(file, args, { cwd: root, stdio: "inherit" });
const expectedVersion = isBun ? "1.4.4" : "v26.13.0";
if (execFileSync(isBun ? bun : node26, ["--version"], { encoding: "utf8" }).trim() !== expectedVersion) {
  throw new Error(`Install the pinned ${isBun ? "Bun" : "Node"} ${expectedVersion} toolchain first`);
}
mkdirSync(output, { recursive: true });
rmSync(payload, { recursive: true, force: true });
// Reuse the baseline's staged package graph, then replace the entire PTY package.
// The baseline payload is a prerequisite, but its executable/postject are not used.
cpSync(path.join(base, "payload"), payload, { recursive: true });
const ptySource = path.join(base, isBun ? "pty-napi/node_modules/node-pty" : "pty-node26/node_modules/node-pty");
const ptyTarget = path.join(payload, "node_modules/node-pty");
rmSync(ptyTarget, { recursive: true, force: true });
cpSync(ptySource, ptyTarget, {
  recursive: true,
  filter(file) {
    const relative = path.relative(ptySource, file);
    return !relative || relative === "package.json" || /^LICENSE/.test(relative)
      || (relative.startsWith("lib") && !/\.(map|ts)$|\.test\.js$/.test(relative))
      || (isBun ? relative.startsWith("prebuilds/darwin-arm64") || relative === "prebuilds"
        : ["build", "build/Release", "build/Release/pty.node"].includes(relative));
  },
});
if (isBun) chmodSync(path.join(ptyTarget, "prebuilds/darwin-arm64/spawn-helper"), 0o755);
else run(node26, ["-e", `require(${JSON.stringify(ptyTarget)}); console.log('Node26 addon loads')`]);

const pkg = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
await build({
  entryPoints: [path.join(root, "src/cli.ts")], outfile: path.join(payload, "cli.js"),
  platform: "node", format: "esm", target: "node24", bundle: true, minify: true,
  // Bundle static JS packages in the Bun candidate; keep lazy packages on disk.
  // The compiled loader also needs manifest autoload enabled below.
  external: isBun ? [] : Object.keys(pkg.dependencies), define: { __CRAIG_VERSION__: JSON.stringify(pkg.version) },
  alias: { yaml: path.join(root, "node_modules/yaml/browser/index.js") },
  plugins: [{ name: "standalone-spike-adapters", setup(builder) {
    builder.onLoad({ filter: /[/\\]shell[/\\]craig-update\.ts$/ }, () => ({ loader: "js", contents: `
      export const CRAIG_RESTART_EXIT_CODE = 75;
      export async function installCraigUpdate() { throw new Error("Updates are disabled in the standalone packaging spike."); }
      export async function restartCraig() { throw new Error("Restart after update is disabled in the standalone packaging spike."); }
    ` }));
    builder.onLoad({ filter: /[/\\]shell[/\\]pty-daemon-process\.ts$/ }, (args) => ({
      loader: "ts", contents: readFileSync(args.path, "utf8").replace(/function daemonSpawnCommand\([\s\S]*$/, `
        function daemonSpawnCommand(workspaceRoot: string): { command: string; args: string[] } {
          return { command: process.execPath, args: ["__craig-daemon", workspaceRoot] };
        }
      `),
    }));
  } }],
});

const binary = path.join(output, "craig");
if (isVfs) {
  // A .node library must live on disk. Keep all JS/configs in the VFS and load
  // just the native asset once before importing Craig. These are staging edits.
  for (const file of ["lib/unixTerminal.js", "lib/index.js"]) {
    const location = path.join(ptyTarget, file);
    writeFileSync(location, readFileSync(location, "utf8").replaceAll("require('../build/Release/pty.node')", "globalThis.__CRAIG_NATIVE_ADDON__"));
  }
  const assets = {};
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else assets[path.relative(payload, file)] = file;
    }
  }
  collect(payload);
  const main = path.join(output, "bootstrap.mjs");
  writeFileSync(main, readFileSync(path.join(root, "scripts/binary-spike/bootstrap-vfs.mjs"), "utf8")
    .replace("const cacheNative = false;", `const cacheNative = ${target.endsWith("-cache")};`));
  const config = path.join(output, "sea.json");
  let resourceConfig = { assets };
  if (target.startsWith("node26-vfs-zip")) {
    const archive = path.join(output, "payload.zip");
    rmSync(archive, { force: true });
    execFileSync("/usr/bin/zip", ["-qr", archive, "."], { cwd: payload, stdio: "inherit" });
    resourceConfig = { vfsArchive: archive };
  }
  writeFileSync(config, JSON.stringify({ main, mainFormat: "module", output: binary,
    useVfs: true, useCodeCache: false, useSnapshot: false, execArgvExtension: "none",
    disableExperimentalSEAWarning: true, ...resourceConfig,
  }));
  run(node26, ["--build-sea", config]);
} else {
  const archive = path.join(output, "payload.tgz");
  run("/usr/bin/tar", ["-czf", archive, "-C", payload, "."]);
  const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (isBun) {
    const main = path.join(output, "bootstrap.mjs");
    writeFileSync(main, readFileSync(path.join(root, "scripts/binary-spike/bootstrap-bun.mjs"), "utf8").replace("PAYLOAD_HASH", hash));
    run(bun, ["build", "--compile", "--compile-autoload-package-json", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", main, "--outfile", binary]);
  } else {
    const main = path.join(output, "bootstrap.cjs");
    writeFileSync(main, readFileSync(path.join(root, "scripts/binary-spike/bootstrap.cjs"), "utf8").replace("PAYLOAD_HASH", hash));
    const config = path.join(output, "sea.json");
    writeFileSync(config, JSON.stringify({ main, output: binary, disableExperimentalSEAWarning: true,
      useCodeCache: false, useSnapshot: false, execArgvExtension: "none", assets: { payload: archive },
    }));
    run(node26, ["--build-sea", config]);
  }
}
run("/usr/bin/codesign", ["--sign", "-", binary]);
writeFileSync(path.join(output, "build-metrics.json"), JSON.stringify({ target, buildMs: Math.round(performance.now() - started) }));
console.log(`Built ${target}: ${binary}`);
