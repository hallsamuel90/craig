// Local feasibility experiment for #309. Does not change npm or release builds.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, ".craig/binary-spike");
const payload = path.join(output, "payload");
if (process.platform !== "darwin" || process.arch !== "arm64" || process.versions.node !== "24.12.0") {
  throw new Error("This spike currently requires macOS ARM64 and Node 24.12.0 (including its native addon ABI).");
}
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
// Fail before building if the installed addon does not match this Node runtime.
createRequire(import.meta.url)("node-pty");
rmSync(payload, { recursive: true, force: true });
mkdirSync(payload, { recursive: true });
writeFileSync(path.join(payload, "package.json"), '{"type":"module"}\n');
const pkg = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
await build({
  entryPoints: [path.join(root, "src/cli.ts")],
  outfile: path.join(payload, "cli.js"),
  platform: "node", format: "esm", target: "node24", bundle: true, minify: true,
  external: Object.keys(pkg.dependencies),
  define: { __CRAIG_VERSION__: JSON.stringify(pkg.version) },
  alias: { yaml: path.join(root, "node_modules/yaml/browser/index.js") },
  plugins: [{
    name: "disable-npm-updates-in-spike",
    setup(builder) {
      builder.onLoad({ filter: /[/\\]shell[/\\]craig-update\.ts$/ }, () => ({
        contents: `export const CRAIG_RESTART_EXIT_CODE = 75;
          export async function installCraigUpdate() { throw new Error("Updates are disabled in the standalone packaging spike."); }
          export async function restartCraig() { throw new Error("Restart after update is disabled in the standalone packaging spike."); }`,
        loader: "js",
      }));
    },
  }],
});

// Preserve the installed dependency graph, including runtime-selected termconfigs.
// Do not rebuild or substitute native addons during packaging.
function copyPackage(name, from, destination, ancestors = new Map()) {
  const require = createRequire(from);
  let source;
  try {
    source = path.dirname(require.resolve(`${name}/package.json`));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    source = path.dirname(require.resolve(name));
    while (!existsSync(path.join(source, "package.json")) || JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")).name !== name) {
      if (path.dirname(source) === source) throw new Error(`Cannot find package root for ${name}`);
      source = path.dirname(source);
    }
  }
  source = realpathSync(source);
  if (ancestors.get(name) === source) return;
  const target = path.join(destination, "node_modules", name);
  cpSync(source, target, {
    recursive: true,
    filter(file) {
      const relative = path.relative(source, file);
      if (!relative) return true;
      if (name === "node-pty" && relative.startsWith(`build${path.sep}`)) {
        return relative === "build/Release" || relative === "build/Release/pty.node";
      }
      return !relative.split(path.sep).some((part) => /^(node_modules|test|tests|docs|src|typings|scripts|deps|\.git)$/.test(part))
        && !/\.(map|ts|md)$|\.test\.js$|\.gyp$/.test(relative);
    },
  });
  const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const next = new Map(ancestors).set(name, source);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    // NAN is a build-time dependency of node-pty 0.10.1, never a runtime import.
    if (name === "node-pty" && dependency === "nan") continue;
    copyPackage(dependency, path.join(source, "package.json"), target, next);
  }
}
for (const name of Object.keys(pkg.dependencies)) copyPackage(name, path.join(root, "package.json"), payload);

// Import from an ordinary disk module: SEA's embedded CJS script has no normal
// file-based module loader. The app and its dynamic imports keep their ESM semantics.
writeFileSync(path.join(payload, "launch.cjs"), 'import("./cli.js").catch(error => { console.error(error); process.exitCode = 1; });\n');
if (process.argv.includes("--payload-only")) {
  console.log(`Prepared payload: ${payload}`);
  process.exit(0);
}
const archive = path.join(output, "payload.tgz");
run("/usr/bin/tar", ["-czf", archive, "-C", payload, "."]);
const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
const bootstrap = path.join(output, "bootstrap.cjs");
let source = readFileSync(path.join(root, "scripts/binary-spike/bootstrap.cjs"), "utf8");
source = source.replace("PAYLOAD_HASH", hash);
writeFileSync(bootstrap, source);
const config = path.join(output, "sea.json");
const blob = path.join(output, "sea.blob");
writeFileSync(config, JSON.stringify({
  main: bootstrap, output: blob, disableExperimentalSEAWarning: true,
  useCodeCache: false, useSnapshot: false, execArgvExtension: "none",
  assets: { payload: archive },
}));
run(process.execPath, ["--experimental-sea-config", config]);
const binary = path.join(output, "craig");
copyFileSync(process.execPath, binary);
chmodSync(binary, 0o755);
run("/usr/bin/codesign", ["--remove-signature", binary]);
run(path.join(output, "toolchain/node_modules/.bin/postject"), [
  binary, "NODE_SEA_BLOB", blob,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  "--macho-segment-name", "NODE_SEA",
]);
run("/usr/bin/codesign", ["--sign", "-", binary]);
console.log(`Standalone spike: ${binary}`);
