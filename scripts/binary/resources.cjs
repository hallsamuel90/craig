// Shared by the SEA bootstrap and audit/tests. No third-party runtime dependencies.
/* global process, Buffer */
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const generationPattern = /^([a-f0-9]{64})-([a-f0-9-]{36})$/;
function safePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
      || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")
      || /(^|\/)\.[^/]/.test(value)) throw new Error(`Unsafe resource path: ${value}`);
  return value;
}
function manifestOf(files) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path, "en"))
    .map(({ path: name, mode, sha256 }) => ({ path: safePath(name), mode, sha256 }));
}
function payloadIdentity(files) { return digest(JSON.stringify(manifestOf(files))); }
function validatePayload(payload) {
  if (payload?.format !== 1 || !Array.isArray(payload.files) || !payload.files.length || payload.files.length > 4096) throw new Error("Invalid resource payload");
  const names = new Set();
  let size = 0;
  for (const file of payload.files) {
    safePath(file.path);
    if (names.has(file.path) || ![0o600, 0o700].includes(file.mode) || !/^[a-f0-9]{64}$/.test(file.sha256)
        || typeof file.data !== "string") throw new Error("Invalid or duplicate resource entry");
    names.add(file.path);
    const bytes = Buffer.from(file.data, "base64");
    size += bytes.length;
    if (bytes.toString("base64") !== file.data || bytes.length > 16 * 1024 * 1024 || size > 64 * 1024 * 1024
        || digest(bytes) !== file.sha256) throw new Error(`Resource integrity failed: ${file.path}`);
  }
  if (payloadIdentity(payload.files) !== payload.identity) throw new Error("Resource manifest identity mismatch");
  return payload;
}
function ownedDirectory(directory, privateMode = true) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (privateMode && (stat.mode & 0o077) !== 0)) throw new Error(`Unsafe Craig cache directory: ${directory}`);
}
function ensureBase(base) {
  // Verify every existing component before creating anything beneath it. An
  // unexpected symlink is rejected rather than followed into an arbitrary tree.
  let current = path.parse(path.resolve(base)).root;
  for (const part of path.resolve(base).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe cache ancestor: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (race) { if (race.code !== "EEXIST") throw race; }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe cache ancestor: ${current}`);
    }
  }
  ownedDirectory(base);
}
function manifestText(payload) { return JSON.stringify({ identity: payload.identity, files: manifestOf(payload.files) }); }
function readProcessRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Unsafe Craig process record");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function inspectTree(directory, relative = "", output = []) {
  ownedDirectory(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.uid !== process.getuid() || stat.isSymbolicLink()) throw new Error(`Unsafe cached resource: ${name}`);
    if (stat.isDirectory()) inspectTree(file, name, output);
    else if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe cached resource: ${name}`);
    else output.push(name);
  }
  return output;
}
function verifyGeneration(directory, payload) {
  try {
    const entries = inspectTree(directory).filter((name) => !name.startsWith(".leases/"));
    const allowed = new Set([".manifest.json", ...payload.files.map((file) => file.path)]);
    if (entries.length !== allowed.size || entries.some((name) => !allowed.has(name))) return false;
    if (fs.readFileSync(path.join(directory, ".manifest.json"), "utf8") !== manifestText(payload)) return false;
    for (const file of payload.files) {
      const location = path.join(directory, file.path);
      if ((fs.lstatSync(location).mode & 0o777) !== file.mode || digest(fs.readFileSync(location)) !== file.sha256) return false;
    }
    return true;
  } catch { return false; }
}
function lease(directory) {
  const leases = path.join(directory, ".leases");
  try { fs.mkdirSync(leases, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  ownedDirectory(leases);
  for (const name of fs.readdirSync(leases)) {
    const location = path.join(leases, name);
    try {
      const stat = fs.lstatSync(location);
      if (stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid()
          && pidState(readProcessRecord(location).pid) === "inactive") fs.unlinkSync(location);
    } catch { /* Unknown leases remain conservatively retained. */ }
  }
  const file = path.join(leases, `${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: "wx" });
  return () => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; } };
}
function withCacheLock(base, action) {
  ensureBase(base);
  const lock = path.join(base, ".lock");
  const deadline = Date.now() + 10000;
  while (true) {
    let acquired = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if (acquired) fs.rmSync(lock, { recursive: true, force: true });
      if (error.code !== "EEXIST") throw error;
      try { ownedDirectory(lock); }
      catch (race) { if (race.code === "ENOENT") continue; throw race; }
      try {
        if (pidState(readProcessRecord(path.join(lock, "owner.json")).pid) === "inactive") {
          const inode = fs.lstatSync(lock).ino;
          const reclaim = path.join(base, `.reclaim-${inode}`);
          try {
            fs.mkdirSync(reclaim, { mode: 0o700 });
            try {
              // Serialize reclamation of this exact dead owner's inode. A
              // second waiter must never remove a replacement owner's lock.
              if (fs.lstatSync(lock).ino === inode
                  && pidState(readProcessRecord(path.join(lock, "owner.json")).pid) === "inactive") {
                const abandoned = path.join(reclaim, "abandoned");
                fs.renameSync(lock, abandoned);
                fs.rmSync(abandoned, { recursive: true });
              }
            } finally { fs.rmdirSync(reclaim); }
          } catch { /* Another reclaimer or an uncertain lock wins. */ }
          if (!fs.existsSync(lock)) continue;
        }
      } catch { /* A just-created or uncertain lock must not be broken. */ }
      if (Date.now() > deadline) throw new Error("Craig cache is locked. Check for a running or interrupted launch before retrying.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); }
  finally { fs.rmSync(lock, { recursive: true }); }
}
function prepareCache(base, payload) {
  validatePayload(payload);
  return withCacheLock(base, () => prepareCacheLocked(base, payload));
}
function prepareCacheLocked(base, payload) {
  // Atomically published immutable generations allow repair without removing
  // resources a detached daemon may still have open or lazily require later.
  for (const name of fs.readdirSync(base).sort()) {
    if (name.startsWith(`${payload.identity}-`) && generationPattern.test(name)) {
      const directory = path.join(base, name);
      if (verifyGeneration(directory, payload)) {
        const release = lease(directory);
        // Recheck after acquiring our lease in case a concurrent prune won first.
        if (verifyGeneration(directory, payload)) return { directory, release };
        release();
      }
    }
  }
  const staging = fs.mkdtempSync(path.join(base, `.extract-${process.pid}-`));
  try {
    for (const file of payload.files) {
      const location = path.join(staging, file.path);
      fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
      fs.writeFileSync(location, Buffer.from(file.data, "base64"), { mode: file.mode, flag: "wx" });
    }
    fs.writeFileSync(path.join(staging, ".manifest.json"), manifestText(payload), { mode: 0o600, flag: "wx" });
    if (!verifyGeneration(staging, payload)) throw new Error("Extracted Craig resources failed verification");
    // Acquire the lease before publication, so cleanup cannot race this launch.
    const releaseStaging = lease(staging);
    const directory = path.join(base, `${payload.identity}-${randomUUID()}`);
    fs.renameSync(staging, directory);
    // lease's old path moved with the directory; release the actual published file.
    const leaseName = fs.readdirSync(path.join(directory, ".leases"))[0];
    void releaseStaging;
    return { directory, release: () => fs.rmSync(path.join(directory, ".leases", leaseName), { force: true }) };
  } catch (error) {
    throw new Error(`Craig could not prepare verified runtime resources: ${error.message}. Check cache permissions and available disk space.`, { cause: error });
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
function pidState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try { process.kill(pid, 0); return "active"; }
  catch (error) { return error.code === "ESRCH" ? "inactive" : "unknown"; }
}
function pruneCache(base, keepIdentity) {
  return withCacheLock(base, () => pruneCacheLocked(base, keepIdentity));
}
function pruneCacheLocked(base, keepIdentity) {
  const result = { removed: [], retained: [] };
  for (const name of fs.readdirSync(base).sort()) {
    if (name === ".lock") continue;
    const directory = path.join(base, name);
    const match = name.match(generationPattern);
    try {
      if (!match) {
        // Only delete abandoned staging directories when the recorded owner PID
        // is definitely gone. PID reuse and permission errors retain the tree.
        const stage = name.match(/^\.extract-(\d+)-[A-Za-z0-9]+$/);
        if (!stage || pidState(Number(stage[1])) !== "inactive") throw new Error("Unknown or live entry");
        inspectTree(directory);
      } else {
        if (match[1] === keepIdentity) throw new Error("Current payload");
        inspectTree(directory);
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, ".manifest.json"), "utf8"));
        if (manifest.identity !== match[1] || payloadIdentity(manifest.files) !== match[1]) throw new Error("Unknown manifest");
        const leases = path.join(directory, ".leases");
        ownedDirectory(leases);
        if (fs.readdirSync(leases).some((file) => pidState(readProcessRecord(path.join(leases, file)).pid) !== "inactive")) throw new Error("Live or uncertain lease");
        // Pruning can race a new lease. Rename first; new launches handle the
        // vanished candidate and extract another generation instead of using it.
        const tombstone = path.join(base, `.prune-${process.pid}-${randomUUID()}`);
        fs.renameSync(directory, tombstone);
        const currentLeases = fs.readdirSync(path.join(tombstone, ".leases"));
        if (currentLeases.some((file) => pidState(readProcessRecord(path.join(tombstone, ".leases", file)).pid) !== "inactive")) {
          fs.renameSync(tombstone, directory);
          throw new Error("Lease acquired during prune");
        }
        fs.rmSync(tombstone, { recursive: true });
        result.removed.push(name);
        continue;
      }
      fs.rmSync(directory, { recursive: true });
      result.removed.push(name);
    } catch { result.retained.push(name); }
  }
  return result;
}
module.exports = { digest, safePath, manifestOf, payloadIdentity, validatePayload, verifyGeneration, prepareCache, pruneCache };
