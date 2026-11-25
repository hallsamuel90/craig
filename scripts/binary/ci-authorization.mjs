// CI authorization is tied to trusted workflow context and immutable job outputs,
// never a human approval string or fields supplied by the release plan.
export const releaseRepository = "hallsamuel90/craig";
const workflow = ".github/workflows/release.yml";
const positiveInteger = (value) => /^[1-9][0-9]*$/.test(value ?? "");
export function ciContext(env) {
  return {
    actions: env.GITHUB_ACTIONS, server: env.GITHUB_SERVER_URL,
    repository: env.GITHUB_REPOSITORY, event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF, sha: env.GITHUB_SHA, workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA, job: env.GITHUB_JOB, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    policy: env.CRAIG_BINARY_RELEASE_POLICY, buildAttempt: env.BINARY_BUILD_ATTEMPT,
    artifactId: env.BINARY_ARTIFACT_ID, planSha256: env.BINARY_PLAN_SHA256,
  };
}
export function validateCIContext(ci, plan, actualPlanSha256, sourceVersion) {
  if (ci.actions !== "true" || ci.server !== "https://github.com" || ci.repository !== releaseRepository
      || ci.event !== "push" || ci.ref !== "refs/heads/main" || ci.job !== "binary-publish"
      || ci.workflowRef !== `${releaseRepository}/${workflow}@refs/heads/main`) throw new Error("Untrusted CI execution: expected main push binary-publish job in release.yml");
  if (ci.policy !== "unnotarized-preview" || plan.policy !== ci.policy) throw new Error("Binary release policy is disabled or unknown");
  if (!positiveInteger(ci.runId) || !positiveInteger(ci.runAttempt) || !positiveInteger(ci.buildAttempt)
      || !positiveInteger(ci.artifactId) || Number(ci.buildAttempt) > Number(ci.runAttempt)) throw new Error("Invalid CI run/artifact provenance");
  if (!/^[a-f0-9]{40}$/.test(ci.sha) || ci.sha !== plan.commit || ci.workflowSha !== ci.sha || plan.dirty !== false
      || plan.tag !== `craig-cli@${sourceVersion}` || !/^\d+\.\d+\.\d+$/.test(sourceVersion)) throw new Error("CI tag/version/commit does not match clean release source");
  if (!/^[a-f0-9]{64}$/.test(ci.planSha256) || actualPlanSha256 !== ci.planSha256) throw new Error("Release plan differs from audited build output");
}
export function verifyCIProvenance(ci, gh) {
  const api = (route) => JSON.parse(gh(["api", "--hostname", "github.com", `repos/${releaseRepository}/${route}`]));
  const run = api(`actions/runs/${ci.runId}`);
  if (String(run.id) !== ci.runId || String(run.run_attempt) !== ci.runAttempt || run.event !== "push"
      || run.head_branch !== "main" || run.head_sha !== ci.sha || run.path !== workflow
      || run.repository?.full_name !== releaseRepository || run.head_repository?.full_name !== releaseRepository) throw new Error("GitHub run provenance mismatch");
  const artifact = api(`actions/artifacts/${ci.artifactId}`);
  if (String(artifact.id) !== ci.artifactId || artifact.expired !== false
      || artifact.name !== `craig-macos-release-${ci.runId}-${ci.buildAttempt}`
      || String(artifact.workflow_run?.id) !== ci.runId || artifact.workflow_run?.head_sha !== ci.sha) throw new Error("GitHub artifact provenance mismatch");
  const pages = JSON.parse(gh(["api", "--hostname", "github.com", "--paginate", "--slurp",
    `repos/${releaseRepository}/actions/runs/${ci.runId}/attempts/${ci.buildAttempt}/jobs?per_page=100`]));
  const builds = pages.flatMap((page) => page.jobs).filter((job) => job.name === "binary-build");
  if (builds.length !== 1 || builds[0].conclusion !== "success" || builds[0].head_sha !== ci.sha) throw new Error("Required binary build/gates did not succeed in the artifact's run attempt");
}
