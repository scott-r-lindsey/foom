import { allPlatforms, desktopMatrix } from "../../scripts/ci-changes.mjs";

const workflowPath = ".github/workflows/ci.yml";
const requiredJobs = [
  "Change detection",
  "Static checks",
  "Unit tests and coverage",
  ...desktopMatrix().map(({ os, shard }) => `Electron (${os}, ${shard})`),
  "Remote host (linux-x64)",
  "Remote host (linux-arm64)",
  "Remote host (darwin-arm64 + darwin-x64)",
  ...allPlatforms.map((os) => `Native checks and packaging (${os})`),
];

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validRef(ref) {
  return (
    typeof ref?.sha === "string" &&
    /^[a-f0-9]{40}$/.test(ref.sha) &&
    typeof ref.ref === "string" &&
    ref.ref.length > 0 &&
    positiveInteger(ref.repo?.id)
  );
}

function sameRef(actual, expected) {
  return (
    actual?.sha === expected.sha &&
    actual.ref === expected.ref &&
    actual.repo?.id === expected.repo.id
  );
}

function fullAttempt(data, run, provenance) {
  if (!Array.isArray(data?.jobs) || data.jobs.length !== data.total_count) return false;
  const gates = data.jobs.filter(
    (job) => job?.name === "Quality gate" || job?.name === "Draft quality gate",
  );
  if (gates.length !== 1) return false;

  for (const name of [...requiredJobs, gates[0].name]) {
    const matches = data.jobs.filter((job) => job?.name === name);
    if (matches.length !== 1) return false;
    const [job] = matches;
    if (
      job.run_id !== run.id ||
      job.run_attempt !== run.run_attempt ||
      job.head_sha !== run.head_sha ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    ) {
      return false;
    }
    if (
      name === "Change detection" &&
      (!Array.isArray(job.steps) ||
        !job.steps.some(
          (step) =>
            step?.name === provenance &&
            step.status === "completed" &&
            step.conclusion === "success",
        ))
    ) {
      return false;
    }
  }
  return true;
}

export async function findReusableRun({ github, context, workflowFingerprint, warn }) {
  const { action, pull_request: pr, repository } = context.payload;
  if (
    context.eventName !== "pull_request" ||
    action !== "ready_for_review" ||
    pr?.draft !== false ||
    !positiveInteger(context.runId) ||
    !positiveInteger(pr.number) ||
    !positiveInteger(repository?.id) ||
    pr.base?.repo?.id !== repository.id ||
    !validRef(pr.base) ||
    !validRef(pr.head) ||
    typeof workflowFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(workflowFingerprint)
  ) {
    return "";
  }

  const provenance = `Record full PR inputs (${pr.base.repo.id}, ${pr.base.ref}, ${pr.base.sha}, ${workflowFingerprint})`;
  // Bounded lookups. Missing history or unavailable metadata leaves the full matrix enabled.
  const request = { signal: AbortSignal.timeout(30_000) };
  try {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: "ci.yml",
      event: "pull_request",
      head_sha: pr.head.sha,
      status: "success",
      per_page: 10,
      request,
    });
    for (const run of data.workflow_runs) {
      if (
        !positiveInteger(run?.id) ||
        run.id === context.runId ||
        !positiveInteger(run.run_attempt) ||
        run.path !== workflowPath ||
        run.event !== "pull_request" ||
        run.status !== "completed" ||
        run.conclusion !== "success" ||
        run.head_sha !== pr.head.sha ||
        run.repository?.id !== repository.id ||
        run.head_repository?.id !== pr.head.repo.id ||
        !Array.isArray(run.pull_requests) ||
        !run.pull_requests.some(
          (candidate) =>
            candidate?.number === pr.number &&
            sameRef(candidate.base, pr.base) &&
            sameRef(candidate.head, pr.head),
        )
      ) {
        continue;
      }
      const { data: jobs } = await github.rest.actions.listJobsForWorkflowRunAttempt({
        ...context.repo,
        run_id: run.id,
        attempt_number: run.run_attempt,
        per_page: 100,
        request,
      });
      if (fullAttempt(jobs, run, provenance)) return String(run.id);
    }
  } catch {
    warn("Could not verify previous CI run. Running full desktop validation.");
  }
  return "";
}
