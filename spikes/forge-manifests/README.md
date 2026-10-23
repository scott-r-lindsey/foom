# Forge manifest evidence spike (#520)

Design artifacts for [the proposed spec](../../docs/forge-plugins.md), not a runtime
implementation. #520 was subsequently approved; the bundled runtime manifest now
lives in `src/shared/bundled-forges/`. The schema tracks #521's follow-main 20-second
minimum and dynamic batch data format. The worked spike copies remain historical
examples; the verifier also checks the current bundled manifest's structural shape.

## Files and evidence provenance

| File | Provenance and purpose |
| --- | --- |
| `forge.schema.json` | Draft 2020-12 closed structural schema; semantic/trust rules remain in the spec |
| `github.json`, `gitlab.json` | Full standalone worked manifests; proposed, not installed plugins |
| `required-checks.graphql` | Exact legacy fallback query (frozen in `tests/helpers/legacy-forge.ts`), also embedded in GitHub JSON; no runtime include |
| `fixtures/gh-view-public.json` | Recorded `gh pr view` for public cli/cli #14700; enriched metadata |
| `fixtures/gh-list-public.json` | Recorded exact-branch list with current six status fields |
| `fixtures/gh-id-public.json` | Recorded GraphQL node ID lookup |
| `fixtures/gh-rollup-public.json` | Recorded existing fallback query; complete optional-only contexts, hence none at the reducer level |
| `fixtures/gh-checks-unsupported.json` | Recorded unsupported JSON flag on gh 2.45.0; requires fallback |
| `fixtures/gh-buckets-constructed.json` | Constructed documented modern buckets/exits plus existing no-check diagnostic; not a live modern-gh capture |
| `fixtures/glab-auth-unavailable.json` | Recorded exit/marker facts only; raw auth output discarded |
| `fixtures/glab-mr-constructed.json` | Constructed single MR/head-pipeline object with synthetic IDs and example path |
| `fixtures/glab-list-constructed.json` | Constructed project MR list; deliberately omits detail-only pipeline |
| `verify.mjs` | Offline schema checks, query parity, recorded GitLab mapping/guard evaluation and fixture integrity |

Recorded on Linux, 2026-10-15 with `/usr/bin/gh` 2.45.0 (Ubuntu package
2.45.0-1ubuntu0.3). These GitHub capture envelopes record their actual argv, exit
code and raw stdout/stderr. All PR/API calls selected **public `cli/cli`**, explicitly using
`github.com/cli/cli` or its public PR node ID. This PR is a fork: its metadata is
useful for testing refusal, not an example Foom should adopt. The rollup fixture
can independently test required-check reduction, but an integrated lookup must
refuse this PR before reading checks. Public results are snapshots and may change.

The original 2026-10-15 `/usr/bin/glab` was 1.36.0. A read-only
`glab auth status --hostname gitlab.com` reported no token and an unauthorized
`/user` response **with exit 0**, confirmed in a second read-only probe. Only
exit/marker facts are retained; raw auth text was not retained as a fixture. No login/config change,
private repository request or GitLab MR capture was attempted. Constructed fixtures
use documented API field shapes, **not observed glab output**. They deliberately
omit descriptions, authors and unrelated response fields. `glab api --help` locally
confirmed explicit hostname, GET override and raw-field syntax. No real agent CLI
was executed. The task's issue/PR workflow is separate from these data captures.

The fixtures use JSON stdout inside a capture envelope so exit-code behavior can
be tested without spawning a real CLI. Do not treat envelopes as direct forge
responses. Future tests can serve these bytes through fixture executables with a
controlled PATH. Synthetic failure/race cases should be derived from snapshots,
clearly marked synthetic, and never fetch credentials/network data during tests.

## Primary references

- [gh PR view JSON fields](https://cli.github.com/manual/gh_pr_view).
- [gh checks JSON fields/buckets and exit codes](https://cli.github.com/manual/gh_pr_checks).
- [gh checks implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go),
  plus the checked-in legacy reference/orchestration contract for the legacy diagnostic.
- [glab API flags](https://docs.gitlab.com/cli/api/): raw fields remain strings;
  fields change the default method, so the example explicitly passes GET.
- [GitLab MR API](https://docs.gitlab.com/api/merge_requests/): list/detail shapes,
  project-local `iid`, source/target IDs and head pipeline.
- [GitLab pipeline statuses](https://docs.gitlab.com/api/pipelines/).
- [glab auth status](https://docs.gitlab.com/cli/auth/status/).

These pages were consulted on 2026-10-15. The fixture reductions and state tables
are Foom design decisions, not statements that each forge has identical semantics.

## Offline validation

From the repository root, with the pinned Node/pnpm dependencies installed:

```sh
node spikes/forge-manifests/verify.mjs
pnpm run check
```

The first command uses the repository's existing Ajv dependency and makes no
network calls or process launches. It validates both examples against the draft
schema, rejects six malformed variants of each, checks duplicate capability shape,
compares embedded fallback query bytes to the current provider and checks snapshot
integrity. It **does not** implement the proposed engine, prove read-only command
semantics, validate every prose invariant, or test live CLI compatibility. Spikes
are excluded from application lint/coverage/build inputs; there is no new dependency
or runtime test runner wiring. Docs/reference-only CI may skip desktop jobs.

## Recorded GitLab evidence (#522, 2026-10-22)

The user supplied authenticated `glab 1.124.0 (d43ccacec)` and approved fixture-only
writes in the **public** project
[`scott-test-projects/foom-forge-fixtures`](https://gitlab.com/scott-test-projects/foom-forge-fixtures).
This supersedes the historical authentication/project blockers in #522's comment.
#521 is closed. No login/logout, credential extraction, config edits, SSH access,
project settings changes or forks were needed. Shared runners picked up the jobs.

All `fixtures/glab-*-recorded.json` envelopes include the CLI version, exact argv,
exit code, UTC capture timestamp and scenario. `stdout` is JSON serialized after
field reduction, not byte-for-byte CLI output. A strict allowlist drops authors,
users, committers, descriptions, emails, avatars and unrelated response fields,
including numeric user IDs and user-profile URLs; public project IDs, paths, SHAs
and pipeline/job/MR IDs remain intact. No personal values required substitution
after that reduction. Failures retain only exit and stderr shape; stdout is discarded.
The old `glab-auth-unavailable.json` remains historical evidence for 1.36.0.

| Fixture suffix / group | Recorded evidence |
| --- | --- |
| `*-view`, `*-rest` | `mr view -F json` and REST MR detail for each scenario below |
| `*-list`, `*-lookup` | Exact-branch CLI lists and draft manifest REST lookups (`scope=all`, `state=all`, two rows); `open-lookup` records `state=opened` |
| `open-state-list`, `merged-state-list`, `closed-state-list` | Default open, `--merged`, `--closed` CLI list filters |
| `*-pipeline`, `*-jobs` | Head pipeline detail and job rows for running/success/failed/manual/rules-omitted cases |
| `skipped-pipeline-detail` | Separate actual `skipped` pipeline from `[skip ci]` |
| `race-before-*`, `race-after-*`, `race-old-pipeline`, `race-new-pipeline` | Old and new head while both pipelines ran |
| `batch`, `batch-skipped` | Aliased GraphQL request for MRs !1–!8, plus !9 after creation; exact queries are in argv |
| `unknown-mr`, `unknown-project`, `malformed-graphql` | Exit 1 and 404 / query-parse diagnostic shapes |
| `final-pipelines` | Final inventory: settled pipelines and preserved manual jobs |
| `glab-remotes-constructed.json` | HTTPS, SCP-style SSH and `ssh://` plain strings; SSH never contacted |
| `glab-fork-constructed.json` | Explicit synthetic fork identity derived from the original constructed MR |

### Draft mapping results and differences

The offline verifier evaluates every draft `mapping` path, project identity, state
table and head-pipeline result/guard path against real detail/view/list rows.
**No REST mapping mismatch was observed, so `gitlab.json` needs no field changes.**
It checks OPEN/CLOSED/MERGED, running/manual → pending, success → success,
failed → failure, skipped/null → none, and absent/mismatched pipeline → unknown.
Additional pipeline statuses in the draft table remain unobserved.

Observed distinctions relevant to the future implementation:

- Detail/view has `head_pipeline`; CLI and REST lists omit it. A list cannot prove
  no pipeline. Resolve detail before concluding `none`.
- MR !4's blocking manual job (`allow_failure: false`) produces REST `manual`,
  rather than a `blocked` enum. The existing table already maps it to pending.
- In !5, `excluded` has `rules: [{when: never}]`, so it is absent from the job list;
  the remaining `fixture` job passes and the pipeline is **success**, not skipped.
  MR !9 separately records a truly skipped pipeline via a `[skip ci]` commit.
- During !1's push, the MR `sha` changed from `503528d77214fbfd35dcaa17275d926247641a9c`
  to `dc04c5897a53044baccadb1336c8edfbcb083bdb`. `pipeline` still described the old
  running pipeline, while `head_pipeline` matched the new SHA. The verifier rejects
  the captured stale MR response and an explicitly derived stale-pipeline response.
  It does not claim the derived combination itself was observed.
- There was no GitLab batch query in the original spike. The capture adapts aliased
  MR lookups to `project(fullPath:)` / `mergeRequest(iid:)`. GraphQL returns string
  `iid`, `diffHeadSha`, camelCase fields, global project IDs and uppercase pipeline
  statuses; REST uses numeric `iid` / project IDs, `sha`, snake_case and lowercase
  status. The verifier explicitly checks these differences. Feeding this GraphQL
  response directly into the REST draft would fail. A GitLab batch representation
  and engine support remain #522 implementation work; no runtime change is included.
- A malformed GraphQL query exits 1 with `glab: Expected NAME, not end of file`;
  unknown MR and project also exit 1 with their distinct 404 diagnostics. These
  captures establish no general auth/error classifier beyond those observations.

### Fixture project inventory and final state

All branches use prefix `evidence-522/` and remain available for repeat captures.
Only !7 was merged; !8 was closed. Other MRs intentionally remain open as reusable
scenario fixtures. No branch was deleted. `main` now contains !7's small text file
and workflow-disabled CI configuration. Each other branch carries its own CI file.

| MR | Branch suffix | Final MR / pipeline state | CI recipe |
| --- | --- | --- | --- |
| [!1](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/1) | `pending` | Open; running at race capture, later success | Alpine 3.22, `sleep 120`; two commits |
| [!2](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/2) | `success` | Open / success | Alpine 3.22, `echo fixture` |
| [!3](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/3) | `failed` | Open / failed | Alpine 3.22, `exit 1` |
| [!4](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/4) | `manual` | Open / manual | `when: manual`, `allow_failure: false` |
| [!5](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/5) | `skipped` | Open / success; excluded job absent | Passing job plus `excluded` with `rules: when: never` |
| [!6](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/6) | `no-pipeline` | Open / explicit null head pipeline | `workflow: rules: [{when: never}]` |
| [!7](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/7) | `merged` | Merged / null | Workflow disabled; source branch retained |
| [!8](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/8) | `closed` | Closed / null | Workflow disabled |
| [!9](https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/9) | `skipped-pipeline` | Open / skipped | Commit subject contains `[skip ci]` |

The first five branches allow push and MR pipelines (`workflow: rules: when: always`),
so multiple pipelines per SHA are expected. The manual jobs were left unplayed to
preserve the blocking scenario. No retries, cancellations or runner workarounds
were necessary. To recreate running/race evidence, push a small change on `pending`
while its `sleep 120` job runs. Use HTTPS and the approved `glab auth git-credential`
helper; never extract a token. Future captures must preserve their own dates and
must not overwrite these snapshots with current network data during tests.

## Remaining evidence gates

Public detail/list, same-project identity, lifecycle states, no pipeline,
running/manual/success/failed/skipped pipelines, head races and three failure exits
are now recorded on glab 1.124.0. Real fork MR evidence is **still missing**:
`glab-fork-constructed.json` is synthetic, and no fork was authorized or created.
Healthy auth-probe output, older/newer CLI compatibility and other pipeline statuses
remain unobserved. The #522 runtime now replays
these envelopes through fixture glab and the shared batch engine; synthetic discovery
wrappers add queried-project/default-branch context using the documented GraphQL
`Project.id` and `Repository.rootRef` fields. No live discovery capture is claimed.
The spike manifests remain historical references; the shipping GitLab manifest is
`src/shared/bundled-forges/gitlab.json`. Tested CLI version: 1.124.0; no version gate.

Modern gh check-output and empty-diagnostic cases are currently constructed;
retain existing provider tests for compatibility and capture them publicly when
available. Self-hosted hosts, tea, Azure and Windows CLI availability remain explicit
spec questions. No claim of all-forge or all-platform support follows from this spike.
