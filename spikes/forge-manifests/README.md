# Forge manifest evidence spike (#520)

Design artifacts for [the proposed spec](../../docs/forge-plugins.md), not a runtime
implementation. User approval is required before #521. No application files change.

## Files and evidence provenance

| File | Provenance and purpose |
| --- | --- |
| `forge.schema.json` | Draft 2020-12 closed structural schema; semantic/trust rules remain in the spec |
| `github.json`, `gitlab.json` | Full standalone worked manifests; proposed, not installed plugins |
| `required-checks.graphql` | Exact current `forge.ts` fallback query, also embedded in GitHub JSON; no runtime include |
| `fixtures/gh-view-public.json` | Recorded `gh pr view` for public cli/cli #14700; enriched metadata |
| `fixtures/gh-list-public.json` | Recorded exact-branch list with current six status fields |
| `fixtures/gh-id-public.json` | Recorded GraphQL node ID lookup |
| `fixtures/gh-rollup-public.json` | Recorded existing fallback query; complete optional-only contexts, hence none at the reducer level |
| `fixtures/gh-checks-unsupported.json` | Recorded unsupported JSON flag on gh 2.45.0; requires fallback |
| `fixtures/gh-buckets-constructed.json` | Constructed documented modern buckets/exits plus existing no-check diagnostic; not a live modern-gh capture |
| `fixtures/glab-auth-unavailable.json` | Recorded exit/marker facts only; raw auth output discarded |
| `fixtures/glab-mr-constructed.json` | Constructed single MR/head-pipeline object with synthetic IDs and example path |
| `fixtures/glab-list-constructed.json` | Constructed project MR list; deliberately omits detail-only pipeline |
| `verify.mjs` | Offline schema rejection/acceptance, duplicate shape, fallback query parity and fixture integrity checks |

Recorded on Linux, 2026-10-15 with `/usr/bin/gh` 2.45.0 (Ubuntu package
2.45.0-1ubuntu0.3). Every capture envelope records its actual argv, exit code and
raw stdout/stderr. All PR/API calls selected **public `cli/cli`**, explicitly using
`github.com/cli/cli` or its public PR node ID. This PR is a fork: its metadata is
useful for testing refusal, not an example Foom should adopt. The rollup fixture
can independently test required-check reduction, but an integrated lookup must
refuse this PR before reading checks. Public results are snapshots and may change.

The installed `/usr/bin/glab` is 1.36.0. A read-only
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
  plus the checked-in `forge.ts`/orchestration contract for the legacy diagnostic.
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

## Remaining evidence gates

Before GitLab ships, collect authenticated **public repository** output for detail,
list, same-repository/fork cases, no pipeline, pending/manual/skipped/failed pipelines,
head races and failure exits on supported CLI versions. Do not log in on a user's
behalf. Modern gh check-output and empty-diagnostic cases are currently constructed;
retain existing provider tests for compatibility and capture them publicly when
available. Self-hosted hosts, tea, Azure and Windows CLI availability remain explicit
spec questions. No claim of all-forge or all-platform support follows from this spike.
