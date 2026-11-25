import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { ciContext, validateCIContext, verifyCIProvenance } from "./ci-authorization.mjs";
import { verifySource } from "./release-source.mjs";
import { attachRelease } from "./attach-release.mjs";
import { archiveFiles, digest } from "./artifact.mjs";

const commit = "a".repeat(40);
const tag = "craig-cli@1.2.3";
const metadata = { version:"1.2.3", target:"darwin-arm64", commit, dirty:false, signing:"ad-hoc-development-only", notarized:false };
const ci = { actions:"true", server:"https://github.com", repository:"hallsamuel90/craig", event:"push", ref:"refs/heads/main", sha:commit,
  workflowRef:"hallsamuel90/craig/.github/workflows/release.yml@refs/heads/main", workflowSha:commit, job:"binary-publish", runId:"123", runAttempt:"2", buildAttempt:"1", artifactId:"456", policy:"unnotarized-preview", planSha256:"b".repeat(64) };
const plan = { ...metadata, tag, policy:"unnotarized-preview" };

test("CI authorization rejects disabled policy, untrusted execution and mutable source/plan claims", () => {
  assert.doesNotThrow(() => validateCIContext(ci, plan, ci.planSha256, "1.2.3"));
  for (const change of [
    {actions:undefined}, {server:"https://example.invalid"}, {repository:"attacker/craig"}, {event:"pull_request"}, {event:"pull_request_target"},
    {event:"release"}, {event:"workflow_dispatch"}, {ref:"refs/heads/feature"}, {workflowRef:"hallsamuel90/craig/.github/workflows/binary-build.yml@refs/heads/main"},
    {workflowSha:"c".repeat(40)}, {job:"binary-build"}, {job:"release"}, {policy:undefined}, {policy:""}, {policy:"notarized"}, {policy:"typo"},
    {sha:"c".repeat(40)}, {runId:""}, {artifactId:"../456"}, {buildAttempt:"3"}, {planSha256:"c".repeat(64)},
  ]) assert.throws(() => validateCIContext({...ci,...change}, plan, ci.planSha256, "1.2.3"), JSON.stringify(change));
  for (const change of [{tag:"craig-cli@1.2.4"},{tag:"craig-cli@1.2.3-beta.1"},{commit:"c".repeat(40)},{dirty:true},{dirty:undefined},{policy:"notarized"}]) {
    assert.throws(() => validateCIContext(ci, {...plan,...change}, ci.planSha256, "1.2.3"));
  }
  assert.throws(() => validateCIContext(ci, plan, "d".repeat(64), "1.2.3"));
  assert.throws(() => validateCIContext(ci, plan, ci.planSha256, "1.2.4"));
  assert.equal(ciContext({GITHUB_EVENT_NAME:"pull_request"}).event, "pull_request");
});

function provenance(override = {}) {
  return (args) => {
    const route = args.at(-1);
    if (route.endsWith("actions/runs/123")) return JSON.stringify({id:123,run_attempt:2,event:"push",head_branch:"main",head_sha:commit,path:".github/workflows/release.yml",repository:{full_name:"hallsamuel90/craig"},head_repository:{full_name:"hallsamuel90/craig"},...override.run});
    if (route.endsWith("actions/artifacts/456")) return JSON.stringify({id:456,expired:false,name:"craig-macos-release-123-1",workflow_run:{id:123,head_sha:commit},...override.artifact});
    if (route.includes("/jobs?")) return JSON.stringify([{jobs:[{name:"binary-build",head_sha:commit,conclusion:"success",...override.job}]}]);
    throw Error(`Unexpected API: ${route}`);
  };
}
test("CI requires successful same-run build and immutable artifact provenance, including failed-job reruns", () => {
  assert.doesNotThrow(() => verifyCIProvenance(ci, provenance())); // publish attempt 2 reuses build attempt 1
  for (const override of [
    {run:{event:"pull_request"}}, {run:{path:".github/workflows/other.yml"}}, {run:{head_sha:"c".repeat(40)}}, {run:{run_attempt:1}},
    {run:{repository:{full_name:"attacker/craig"}}}, {run:{head_repository:{full_name:"attacker/craig"}}},
    {artifact:{id:789}}, {artifact:{expired:true}}, {artifact:{name:"craig-macos-release-123-2"}},
    {artifact:{workflow_run:{id:999,head_sha:commit}}}, {artifact:{workflow_run:{id:123,head_sha:"c".repeat(40)}}},
    {job:{conclusion:"failure"}}, {job:{conclusion:"skipped"}}, {job:{head_sha:"c".repeat(40)}}, {job:{name:"candidate"}},
  ]) assert.throws(() => verifyCIProvenance(ci, provenance(override)));
});

test("release source requires exact clean tag, version and run commit", () => {
  const source = {version:"1.2.3",tag,commit,head:commit,tagCommit:commit,dirty:false};
  assert.doesNotThrow(() => verifySource(source));
  for (const change of [{version:"1.2.4"},{version:"1.2.3-beta"},{tag:"latest"},{tag:"craig-cli@1.2.4"},{commit:"c".repeat(40)}, {head:"c".repeat(40)},{tagCommit:"c".repeat(40)},{dirty:true},{dirty:undefined}]) assert.throws(() => verifySource({...source,...change}));
});

test("CI attachment uploads once, verifies complete identical reruns and rejects partial/mismatched assets", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "craig-ci-release-"));
  try {
    const archiveName = "craig-1.2.3-darwin-arm64.tar.gz";
    const archive = archiveFiles(["craig","LICENSE","THIRD_PARTY_NOTICES","build.json","payload-manifest.json"].map((name) => ({path:name,mode:name === "craig" ? 0o755 : 0o600,bytes:Buffer.from(name === "build.json" ? JSON.stringify(metadata) : "fixture")})));
    const sums = Buffer.from(`${digest(archive)}  ${archiveName}\n`);
    writeFileSync(path.join(directory,archiveName), archive);
    writeFileSync(path.join(directory,"SHA256SUMS"), sums);
    const candidate = {...plan,assets:[{name:archiveName,sha256:digest(archive)},{name:"SHA256SUMS",sha256:digest(sums)}]};
    const sealed = digest(JSON.stringify(candidate));
    let uploads = 0;
    let audits = 0;
    let existing = [];
    let mismatch = false;
    let partialFailure = false;
    const gh = (args) => {
      const route = args.at(-1);
      if (args[0] === "api") {
        if (route.includes("actions/")) return provenance()(args);
        if (route.includes("git/ref/")) return JSON.stringify({object:{type:"commit",sha:commit}});
        if (route.includes("/assets?")) return JSON.stringify([existing]);
        return JSON.stringify({id:1,tag_name:tag,draft:false,prerelease:false});
      }
      if (args[1] === "upload") {
        assert.ok(audits > 0);
        assert.ok(!args.includes("--clobber"));
        uploads++;
        existing = candidate.assets.map(({name}) => ({name}));
        if (partialFailure) { existing.pop(); throw Error("partial upload"); }
      } else if (args[1] === "download") {
        const destination = args[args.indexOf("--dir") + 1];
        mkdirSync(destination);
        for (const asset of candidate.assets) writeFileSync(path.join(destination,asset.name), mismatch ? "wrong" : readFileSync(path.join(directory,asset.name)));
      } else throw Error("No deletes/repairs/release creation allowed");
      return "";
    };
    const options = {plan:candidate,planSha256:sealed,sourceVersion:"1.2.3",directory,ci:{...ci,planSha256:sealed},sourceCommit:commit,sourceDirty:false,gh,audit:() => {audits++;}};
    assert.throws(() => attachRelease({...options,approval:"human"}), /impersonate/);
    assert.throws(() => attachRelease({...options,sourceDirty:true}), /clean/);
    assert.throws(() => attachRelease({...options,plan:{...candidate,assets:candidate.assets.map((asset) => ({...asset,sha256:"c".repeat(64)}))},planSha256:"c".repeat(64)}), /differs/);
    assert.equal(attachRelease(options), "uploaded");
    assert.equal(attachRelease(options), "verified-existing");
    assert.equal(uploads,1);
    mismatch=true;
    assert.throws(() => attachRelease(options), /Remote checksum mismatch/);
    assert.equal(uploads,1);
    mismatch=false; existing.pop();
    assert.throws(() => attachRelease(options), /already exists/);
    assert.equal(uploads,1);
    existing=[]; partialFailure=true;
    assert.throws(() => attachRelease(options), /partial upload/);
    assert.throws(() => attachRelease(options), /already exists/);
    assert.equal(uploads,2);
    writeFileSync(path.join(directory,archiveName), "altered bytes");
    assert.throws(() => attachRelease(options), /checksum mismatch/);
    assert.equal(uploads,2);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

// Test the actual YAML contract, including permission boundaries, gate order and
// output wiring. No workflow expression is treated as policy merely by name.
const workflow = parse(readFileSync(new URL("../../.github/workflows/release.yml",import.meta.url),"utf8"));
const candidateWorkflow = parse(readFileSync(new URL("../../.github/workflows/binary-build.yml",import.meta.url),"utf8"));
const stepWith = (job, action) => job.steps.find((step) => step.uses?.startsWith(`${action}@`));
const gate = (expression, values) => Function(`return (${expression.replace(/\b(?:github|vars|needs)[A-Za-z0-9_.-]+/g,(key) => JSON.stringify(values[key]))});`)();
test("actual release workflow gates policy/main/success and confines binary writes to publish job", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(),["push","workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches,["main"]);
  assert.deepEqual(workflow.permissions,{contents:"read"});
  assert.deepEqual(Object.entries(workflow.jobs).filter(([,job]) => job.permissions?.contents === "write").map(([name]) => name),["release","binary-publish"]);
  const build = workflow.jobs["binary-build"];
  const publish = workflow.jobs["binary-publish"];
  assert.equal(build.needs,"release");
  assert.deepEqual(publish.needs,["release","binary-build"]);
  const enabled = {"github.repository":"hallsamuel90/craig","github.event_name":"push","github.ref":"refs/heads/main","vars.CRAIG_BINARY_RELEASE_POLICY":"unnotarized-preview","needs.release.result":"success","needs.binary-build.result":"success","needs.release.outputs.binary_eligible":"true"};
  for (const job of [build,publish]) {
    assert.equal(gate(job.if,enabled),true);
    for (const change of [{"vars.CRAIG_BINARY_RELEASE_POLICY":undefined},{"vars.CRAIG_BINARY_RELEASE_POLICY":""},{"vars.CRAIG_BINARY_RELEASE_POLICY":"typo"},{"github.repository":"attacker/craig"},{"github.event_name":"pull_request"},{"github.event_name":"pull_request_target"},{"github.event_name":"workflow_dispatch"},{"github.ref":"refs/heads/feature"},{"needs.release.result":"failure"},{"needs.release.outputs.binary_eligible":"false"}]) assert.equal(gate(job.if,{...enabled,...change}),false);
  }
  assert.equal(gate(publish.if,{...enabled,"needs.binary-build.result":"failure"}),false);
  assert.deepEqual(build.permissions,{contents:"read"});
  assert.deepEqual(publish.permissions,{contents:"write",actions:"read"});
  assert.deepEqual(candidateWorkflow.permissions,{contents:"read"});
  assert.ok(!JSON.stringify(build).includes("secrets."));
  assert.ok(!JSON.stringify(candidateWorkflow).includes("secrets."));
  const checkout = stepWith(publish,"actions/checkout");
  assert.equal(checkout.with.ref,"${{ needs.release.outputs.binary_commit }}");
  assert.equal(checkout.with["persist-credentials"],false);
  const download = stepWith(publish,"actions/download-artifact");
  assert.equal(download.with["artifact-ids"],"${{ needs.binary-build.outputs.artifact_id }}");
  assert.equal(download.with["merge-multiple"],true);
  assert.equal(download.with.path,"dist/binary");
  assert.equal(download.with["run-id"],"${{ github.run_id }}");
  assert.equal(download.with.repository,"${{ github.repository }}");
  const attach = publish.steps.at(-1);
  assert.equal(attach.run,"node scripts/binary/attach-release.mjs --ci dist/binary/draft/release-assets.json");
  assert.equal(attach.env.BINARY_PLAN_SHA256,"${{ needs.binary-build.outputs.plan_sha }}");
  assert.equal(attach.env.BINARY_ARTIFACT_ID,"${{ needs.binary-build.outputs.artifact_id }}");
  assert.equal(attach.env.BINARY_BUILD_ATTEMPT,"${{ needs.binary-build.outputs.attempt }}");
  assert.equal(attach.env.CRAIG_BINARY_RELEASE_POLICY,"${{ vars.CRAIG_BINARY_RELEASE_POLICY }}");
  assert.equal(attach.env.GH_TOKEN,"${{ github.token }}");
  assert.ok(!publish.steps.some((step) => step.run?.includes("build:binary")));
  assert.equal(workflow.jobs.release.steps.find((step) => step.name === "Create GitHub release").env.GH_TOKEN,"${{ secrets.RELEASE_BOT_TOKEN }}");
  const selection = workflow.jobs.release.steps.findIndex((step) => step.id === "binary-target");
  assert.ok(selection > workflow.jobs.release.steps.findIndex((step) => step.name === "Create GitHub release"));
  assert.ok(selection < workflow.jobs.release.steps.findIndex((step) => step.name === "Apply Changesets version"));
});

test("actual binary CD pipeline runs every required gate before sealing immutable build output", () => {
  const build = workflow.jobs["binary-build"];
  const commands = ["node scripts/binary/release-source.mjs --verify","pnpm install --frozen-lockfile","pnpm test","pnpm typecheck","pnpm lint","pnpm build","pnpm build:npm","pnpm package:audit","pnpm package:smoke","pnpm binary:test","pnpm build:binary","pnpm binary:audit","pnpm binary:smoke","pnpm verify:artifact --executable .craig/binary-build/craig --profile soak --report dist/binary/terminal-soak.json","pnpm binary:release:prepare --policy unnotarized-preview","node scripts/binary/release-source.mjs --seal"];
  assert.deepEqual(build.steps.filter((step) => step.run).map((step) => step.run),commands);
  for (const step of build.steps) { assert.equal(step.if,undefined); assert.equal(step["continue-on-error"],undefined); }
  const upload = stepWith(build,"actions/upload-artifact");
  assert.equal(build.steps.at(-1),upload);
  assert.equal(upload.with.name,"craig-macos-release-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.ok(upload.with.path.includes("dist/binary/draft/release-assets.json"));
  assert.equal(upload.with.overwrite,undefined);
  assert.equal(build.outputs.artifact_id,"${{ steps.archive.outputs.artifact-id }}");
  assert.equal(build.outputs.plan_sha,"${{ steps.seal.outputs.plan_sha }}");
  assert.equal(build.outputs.attempt,"${{ steps.seal.outputs.attempt }}");
  assert.equal(stepWith(build,"actions/setup-node").with["node-version"],"24.12.0");
  assert.equal(build.env.DEVELOPER_DIR,"/Applications/Xcode_26.2.app/Contents/Developer");
});
