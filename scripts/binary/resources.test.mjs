import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { makePayload, archiveFiles, auditDistribution, auditPayload } from "./artifact.mjs";
import resources from "./resources.cjs";

const exec = promisify(execFile);
const payload = () => makePayload([{ path: "cli.js", bytes: Buffer.from("console.log('verified')") }]);
function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "craig-cache-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function deadPid() { return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid; }

test("payload identity ignores listing order, but detects bytes and executable mode changes", () => {
  const files = [{ path: "a.js", bytes: Buffer.from("a") }, { path: "b.js", bytes: Buffer.from("b") }];
  const first = makePayload(files);
  assert.equal(first.identity, makePayload([...files].reverse()).identity);
  assert.notEqual(first.identity, makePayload([files[0], { ...files[1], mode: 0o700 }]).identity);
  assert.notEqual(first.identity, makePayload([files[0], { ...files[1], bytes: Buffer.from("c") }]).identity);
});
test("audit rejects source maps, private paths, development files and unexpected distribution entries", () => {
  for (const file of [
    { path: "../escape", bytes: Buffer.from("x") },
    { path: "node_modules/pkg/test.js.map", bytes: Buffer.from("x") },
    { path: "cli.js", bytes: Buffer.from("const p = '/Users/alice/private/project'") },
    { path: "cli.js", bytes: Buffer.from("//# sourceMappingURL=secret.map") },
    { path: "tests/secret.js", bytes: Buffer.from("x") },
  ]) assert.throws(() => makePayload([file]));
  assert.throws(() => auditDistribution(archiveFiles([{ path: "unexpected", bytes: Buffer.from("secret") }])));
});
test("tampered payload data, identity, duplicate entries and traversal fail before writing", (t) => {
  const directory = fixture(t);
  const original = payload();
  for (const changed of [
    { ...original, identity: "0".repeat(64) },
    { ...original, files: [...original.files, ...original.files] },
    { ...original, files: [{ ...original.files[0], data: Buffer.from("tampered").toString("base64") }] },
    { ...original, files: [{ ...original.files[0], path: "../escape" }] },
  ]) assert.throws(() => resources.prepareCache(path.join(directory, "cache"), changed));
  assert.equal(existsSync(path.join(directory, "cache")), false);
});
test("auditing decoded resources rejects forbidden content even when its manifest and hashes are consistent", () => {
  for (const content of ["//# sourceMappingURL=hidden.map", "const secret='/Users/alice/private/worktree' "]) {
    const bytes = Buffer.from(content);
    const files = [{ path: "cli.js", mode: 0o600, sha256: resources.digest(bytes), data: bytes.toString("base64") }];
    const forged = { format: 1, identity: resources.payloadIdentity(files), files };
    assert.doesNotThrow(() => resources.validatePayload(forged));
    assert.throws(() => auditPayload(forged), /Denied/);
  }
});
test("corrupt and incomplete generations repair without removing a live daemon's generation", (t) => {
  const base = path.join(fixture(t), "cache");
  const original = payload();
  const first = resources.prepareCache(base, original);
  writeFileSync(path.join(first.directory, "cli.js"), "corrupt");
  const second = resources.prepareCache(base, original);
  assert.notEqual(first.directory, second.directory);
  assert.equal(readFileSync(path.join(first.directory, "cli.js"), "utf8"), "corrupt");
  assert.ok(resources.verifyGeneration(second.directory, original));
  assert.ok(resources.pruneCache(base, "0".repeat(64)).retained.includes(path.basename(first.directory)));
  first.release(); second.release();
  assert.equal(resources.pruneCache(base, "0".repeat(64)).removed.length, 2);
  const third = resources.prepareCache(base, original);
  assert.ok(resources.verifyGeneration(third.directory, original));
});
test("cache symlinks are refused and corrupt resource links are not followed during repair", (t) => {
  const directory = fixture(t);
  const outside = path.join(directory, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const linked = path.join(directory, "linked");
  symlinkSync(outside, linked);
  assert.throws(() => resources.prepareCache(linked, payload()), /Unsafe cache ancestor/);
  const base = path.join(directory, "cache");
  const first = resources.prepareCache(base, payload());
  const victim = path.join(outside, "victim");
  writeFileSync(victim, "preserved");
  rmSync(path.join(first.directory, "cli.js"));
  symlinkSync(victim, path.join(first.directory, "cli.js"));
  const second = resources.prepareCache(base, payload());
  assert.notEqual(first.directory, second.directory);
  assert.equal(readFileSync(victim, "utf8"), "preserved");
  assert.ok(resources.pruneCache(base, "0".repeat(64)).retained.includes(path.basename(first.directory)));
});
test("a full disk rolls back only its own extraction and releases the cache lock", (t) => {
  const base = path.join(fixture(t), "cache");
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (String(file).startsWith(base) && String(file).endsWith("/cli.js")) {
      const error = new Error("No space left on device"); error.code = "ENOSPC"; throw error;
    }
    return originalWrite(file, ...args);
  };
  try { assert.throws(() => resources.prepareCache(base, payload()), /available disk space/); }
  finally { fs.writeFileSync = originalWrite; }
  assert.deepEqual(fs.readdirSync(base), []);
  assert.ok(resources.verifyGeneration(resources.prepareCache(base, payload()).directory, payload()));
});
test("an inaccessible cache fails without modifying other files", { skip: process.getuid() === 0 }, (t) => {
  const base = path.join(fixture(t), "cache");
  mkdirSync(base, { mode: 0o500 });
  try { assert.throws(() => resources.prepareCache(base, payload()), /EACCES|permission/); }
  finally { fs.chmodSync(base, 0o700); }
  assert.deepEqual(fs.readdirSync(base), []);
});
test("concurrent process cold starts share a complete verified generation", async (t) => {
  const directory = fixture(t);
  const base = path.join(directory, "cache");
  const file = path.join(directory, "payload.json");
  writeFileSync(file, JSON.stringify(payload()));
  const module = path.resolve(import.meta.dirname, "resources.cjs");
  const script = "const c=require(process.argv[1]); const p=require(process.argv[2]); console.log(c.prepareCache(process.argv[3],p).directory)";
  for (let round = 0; round < 3; round++) {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => exec(process.execPath, ["-e", script, module, file, `${base}-${round}`], { timeout: 15000 })));
    const directories = results.map((result) => {
      assert.equal(result.status, "fulfilled", result.reason?.stderr);
      return result.value.stdout.trim();
    });
    assert.equal(new Set(directories).size, 1);
    assert.ok(resources.verifyGeneration(directories[0], payload()));
  }
});
test("cleanup retains active/unknown leases, removes inactive generations and abandoned extraction, and preserves current identity", (t) => {
  const base = path.join(fixture(t), "cache");
  const original = payload();
  const first = resources.prepareCache(base, original);
  first.release();
  writeFileSync(path.join(first.directory, ".leases/unknown.json"), "invalid");
  assert.ok(resources.pruneCache(base, "0".repeat(64)).retained.includes(path.basename(first.directory)));
  rmSync(path.join(first.directory, ".leases/unknown.json"));
  writeFileSync(path.join(first.directory, ".leases/dead.json"), JSON.stringify({ pid: deadPid() }), { mode: 0o600 });
  assert.ok(resources.pruneCache(base, original.identity).retained.includes(path.basename(first.directory)));
  const abandoned = `.extract-${deadPid()}-abc123`;
  mkdirSync(path.join(base, abandoned), { mode: 0o700 });
  const result = resources.pruneCache(base, "0".repeat(64));
  assert.ok(result.removed.includes(abandoned));
  assert.ok(result.removed.includes(path.basename(first.directory)));
});
test("dead lock owner can be reclaimed without trusting a partial payload", (t) => {
  const base = path.join(fixture(t), "cache");
  mkdirSync(path.join(base, ".lock"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(base, ".lock/owner.json"), JSON.stringify({ pid: deadPid() }), { mode: 0o600 });
  const result = resources.prepareCache(base, payload());
  assert.ok(resources.verifyGeneration(result.directory, payload()));
  assert.equal(existsSync(path.join(base, ".lock")), false);
});
test("an older daemon's resources survive a new payload and cleanup until its lease is released", (t) => {
  const base = path.join(fixture(t), "cache");
  const old = resources.prepareCache(base, payload());
  const updated = makePayload([{ path: "cli.js", bytes: Buffer.from("console.log('new version')") }]);
  const current = resources.prepareCache(base, updated);
  const cleanup = resources.pruneCache(base, updated.identity);
  assert.ok(cleanup.retained.includes(path.basename(old.directory)));
  assert.equal(readFileSync(path.join(old.directory, "cli.js"), "utf8"), "console.log('verified')");
  old.release();
  assert.ok(resources.pruneCache(base, updated.identity).removed.includes(path.basename(old.directory)));
  assert.ok(resources.verifyGeneration(current.directory, updated));
});
test("a live separate-process lease protects lazy resource loading across a payload upgrade", async (t) => {
  const directory = fixture(t);
  const base = path.join(directory, "cache");
  const oldPayload = makePayload([{ path: "late.cjs", bytes: Buffer.from('module.exports = "old payload";') }]);
  const source = path.join(directory, "old.json");
  writeFileSync(source, JSON.stringify(oldPayload));
  const workerFile = path.join(directory, "worker.cjs");
  writeFileSync(workerFile, `const cache = require(process.argv[2]);
    const active = cache.prepareCache(process.argv[4], require(process.argv[3]));
    process.send({ directory: active.directory });
    process.on('message', () => process.send({ value: require(active.directory + '/late.cjs') }));`);
  const worker = fork(workerFile, [path.resolve(import.meta.dirname, "resources.cjs"), source, base], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(worker, "exit");
  try {
    const [ready] = await once(worker, "message", { signal: AbortSignal.timeout(5000) });
    const next = makePayload([{ path: "late.cjs", bytes: Buffer.from('module.exports = "new payload";') }]);
    const current = resources.prepareCache(base, next);
    assert.ok(resources.pruneCache(base, next.identity).retained.includes(path.basename(ready.directory)));
    const response = once(worker, "message", { signal: AbortSignal.timeout(5000) });
    worker.send("load after upgrade/prune");
    assert.equal((await response)[0].value, "old payload");
    worker.kill();
    await exited;
    assert.ok(resources.pruneCache(base, next.identity).removed.includes(path.basename(ready.directory)));
    assert.ok(resources.verifyGeneration(current.directory, next));
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    await exited;
  }
});
test("the distribution writer emits deterministic archives with an enforced inventory", () => {
  const entries = ["craig", "LICENSE", "THIRD_PARTY_NOTICES", "build.json", "payload-manifest.json"].map((name) => ({ path: name, bytes: Buffer.from(name), mode: name === "craig" ? 0o755 : 0o600 }));
  const first = archiveFiles(entries);
  assert.deepEqual(first, archiveFiles([...entries].reverse()));
  assert.equal(auditDistribution(first).length, 5);
  assert.throws(() => auditDistribution(gzipSync(Buffer.concat([gunzipSync(first), Buffer.from("hidden secret")]))), /trailing/);
});
