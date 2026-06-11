#!/usr/bin/env node

import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";

const repoRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(repoRoot, "packages/cli/dist/cli.js");
const pkgJson = JSON.parse(await readFile(resolve(repoRoot, "packages/cli/package.json"), "utf8"));

await rm(dirname(outfile), { recursive: true, force: true });
await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(repoRoot, "src/cli.ts")],
  outfile,
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: true,
  minify: true,
  sourcemap: false,
  external: ["@xterm/headless", "node-pty", "picocolors", "terminal-kit"],
  logLevel: "info",
  define: {
    __CRAIG_VERSION__: JSON.stringify(pkgJson.version),
  },
});

await chmod(outfile, 0o755);
