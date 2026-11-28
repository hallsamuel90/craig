import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { attachRelease, approvalFor, releaseTarget } from "./attach-release.mjs";
import { archiveFiles, digest } from "./artifact.mjs";

test("remote lookup dereferences annotated tags and paginates immutable inventory", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const route = args.at(-1);
    if (route.includes("git/ref/")) return JSON.stringify({object:{type:"tag",sha:"d".repeat(40)}});
    if (route.includes("git/tags/")) return JSON.stringify({object:{type:"commit",sha:"a".repeat(40)}});
    if (route.includes("/assets?")) return JSON.stringify([[], [{name:"SHA256SUMS"}]]);
    return JSON.stringify({id:1,tag_name:"craig-cli@1.2.3",draft:false,prerelease:false});
  };
  assert.deepEqual(releaseTarget(gh, "craig-cli@1.2.3"), {tag:"craig-cli@1.2.3",tagCommit:"a".repeat(40),assets:[{name:"SHA256SUMS"}]});
  assert.ok(calls.some((args) => args.includes("--paginate")));
  assert.throws(() => releaseTarget(() => JSON.stringify({object:{type:"tree"}}), "craig-cli@1.2.3"));
});

test("attachment stages audited bytes, binds authorization and never clobbers", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "craig-attach-test-"));
  try {
    const metadata = {version:"1.2.3",target:"darwin-arm64",commit:"a".repeat(40),dirty:false,signing:"ad-hoc-development-only",notarized:false};
    const archiveName = "craig-1.2.3-darwin-arm64.tar.gz";
    const archive = archiveFiles(["craig", "LICENSE", "THIRD_PARTY_NOTICES", "build.json", "payload-manifest.json"].map((name) => ({path:name, mode:name === "craig" ? 0o755 : 0o600, bytes:Buffer.from(name === "build.json" ? JSON.stringify(metadata) : "fixture")})));
    const sums = Buffer.from(`${digest(archive)}  ${archiveName}\n`);
    writeFileSync(path.join(directory, archiveName), archive);
    writeFileSync(path.join(directory, "SHA256SUMS"), sums);
    const plan = {...metadata,tag:"craig-cli@1.2.3",policy:"unnotarized-preview",assets:[{name:archiveName,sha256:digest(archive)}, {name:"SHA256SUMS",sha256:digest(sums)}]};
    let audited = false;
    let conflict = false;
    let wrongCommit = false;
    let prerelease = false;
    let corruptDownload = false;
    let uploadFails = false;
    let moveAfterUpload = false;
    const uploads = [];
    const gh = (args) => {
      if (args[0] === "api") {
        assert.ok(audited);
        const route = args.at(-1);
        if (route.includes("git/ref/")) return JSON.stringify({object:{type:"commit",sha:(wrongCommit ? "b" : "a").repeat(40)}});
        if (route.includes("/assets?")) return JSON.stringify([conflict ? [{name:"SHA256SUMS"}] : []]);
        return JSON.stringify({id:1,tag_name:plan.tag,draft:false,prerelease});
      }
      if (args[1] === "upload") {
        assert.ok(audited);
        assert.ok(!args.includes("--clobber"));
        uploads.push(args);
        if (moveAfterUpload) wrongCommit = true;
        if (uploadFails) throw new Error("partial upload; inspect manually");
        for (const file of args.slice(3,5)) assert.deepEqual(readFileSync(file), readFileSync(path.join(directory,path.basename(file))));
      } else {
        const destination = args[args.indexOf("--dir") + 1];
        mkdirSync(destination);
        for (const asset of plan.assets) writeFileSync(path.join(destination,asset.name), corruptDownload ? "wrong remote bytes" : readFileSync(path.join(directory,asset.name)));
      }
      return "";
    };
    const options = {plan,directory,approval:approvalFor(plan),sourceCommit:plan.commit,sourceDirty:false,gh,audit:() => {audited=true;}};
    assert.throws(() => attachRelease({...options,approval:"yes"}), /approval/);
    assert.throws(() => attachRelease({...options,sourceDirty:true}), /clean/);
    assert.throws(() => attachRelease({...options,sourceCommit:"b".repeat(40)}), /source/);
    assert.throws(() => attachRelease({...options,audit:() => {throw Error("ABI/license audit failed");}}), /audit failed/);
    conflict=true;
    assert.throws(() => attachRelease(options), /already exists/);
    conflict=false; wrongCommit=true;
    assert.throws(() => attachRelease(options), /tag\/commit/);
    wrongCommit=false; prerelease=true;
    assert.throws(() => attachRelease(options), /published stable/);
    prerelease=false;
    assert.equal(uploads.length,0);
    attachRelease(options);
    assert.equal(uploads.length,1);
    corruptDownload=true;
    assert.throws(() => attachRelease(options), /Remote checksum mismatch/);
    corruptDownload=false; moveAfterUpload=true;
    assert.throws(() => attachRelease(options), /tag moved after upload/);
    moveAfterUpload=false; wrongCommit=false; uploadFails=true;
    assert.throws(() => attachRelease(options), /partial upload/);
    assert.equal(uploads.length,4); // One attempt per invocation, no retry or delete.
    writeFileSync(path.join(directory,archiveName), "corrupt");
    assert.throws(() => attachRelease(options), /checksum/);
    assert.equal(uploads.length,4);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
