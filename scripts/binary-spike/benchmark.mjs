// Local CLI startup measurements, not sustained TUI/agent performance benchmarks.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "../..");
if (process.version !== "v24.12.0" || process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Use developer Node 24.12.0 on macOS ARM64 for these pinned comparisons");
}
const base = path.join(root, ".craig/binary-spike");
const candidates = [
  { name: "esbuild-node24", command: process.execPath, args: [path.join(root, "packages/cli/dist/cli.js")], artifact: path.join(root, "packages/cli/dist/cli.js") },
  { name: "esbuild-node26", command: path.join(base, "toolchain/node_modules/node/bin/node"), args: [path.join(root, "packages/cli/dist/cli.js")], artifact: path.join(root, "packages/cli/dist/cli.js") },
  ...["node24-disk", "node26-disk", "node26-vfs", "node26-vfs-zip", "node26-vfs-zip-cache", "bun-napi"].map((name) => {
    const command = name === "node24-disk" ? path.join(base, "craig") : path.join(base, name, "craig");
    return { name, command, args: [], artifact: command };
  }),
];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = (value) => Math.round(value * 10) / 10;
const records = [];
for (const candidate of candidates) {
  const home = mkdtempSync(path.join(tmpdir(), "craig-binary-bench-"));
  const env = { ...process.env, HOME: home };
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "CRAIG_AGENT_CAPABILITY", "CRAIG_AGENT_TAB_ID", "CRAIG_TASK_ID", "CRAIG_WORKSPACE_ROOT"]) delete env[key];
  const run = () => {
    const started = performance.now();
    execFileSync(candidate.command, [...candidate.args, "--help"], { env, stdio: "pipe", timeout: 10000 });
    return performance.now() - started;
  };
  try {
    const fresh = [run()];
    for (let index = 0; index < 4; index++) {
      const freshHome = mkdtempSync(path.join(tmpdir(), "craig-binary-bench-"));
      env.HOME = freshHome;
      try { fresh.push(run()); }
      finally { rmSync(freshHome, { recursive: true, force: true }); env.HOME = home; }
    }
    const warm = Array.from({ length: 15 }, run);
    const peakRss = Array.from({ length: 5 }, () => {
      const result = spawnSync("/usr/bin/time", ["-l", candidate.command, ...candidate.args, "--help"], {
        env, encoding: "utf8", timeout: 10000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr);
      const match = result.stderr.match(/(\d+)\s+maximum resident set size/);
      if (!match) throw new Error(`No RSS measurement: ${result.stderr}`);
      return Number(match[1]) / 1024 / 1024;
    });
    const record = { name: candidate.name, bytes: statSync(candidate.artifact).size,
      freshHomeMedianMs: rounded(median(fresh)), freshHomeMinMs: rounded(Math.min(...fresh)),
      freshHomeMaxMs: rounded(Math.max(...fresh)), freshHomeRuns: fresh.length, warmMedianMs: rounded(median(warm)),
      warmMinMs: rounded(Math.min(...warm)), warmMaxMs: rounded(Math.max(...warm)),
      peakRssMiB: rounded(median(peakRss)), runs: warm.length,
    };
    records.push(record);
    console.log(JSON.stringify(record));
  } finally { rmSync(home, { recursive: true, force: true }); }
}
writeFileSync(path.join(base, "benchmark.json"), JSON.stringify({
  measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  driverNode: process.version, command: "--help", results: records,
}, null, 2));
