# Release diagnosis, receipt and publishing signer propagation

Inventory checked on 2026-11-13 using the fleet workflow checkouts, then the
GitHub contents API for each package's `main:.github/workflows/release.yml`.
The local checkouts lag current main (including pm-ops); current remote main is
the classification below. GitHub code search returned zero indexed matches and
was not treated as proof of absence. This inventory predates the two-package
pilot described below.

| Workflow form | Packages | Delivery of #268, #269, #270 |
| --- | --- | --- |
| Local reusable caller | pm-ops | Its `release.yml` calls `./.github/workflows/daily-release.yml`; all three fixes apply after merge on subsequent main runs. |
| External reusable callers | None among the 38 inventoried package release workflows | A mutable ref would receive the canonical workflow fixes automatically; a SHA-pinned caller requires an explicit reviewed pin update. |
| Copied release workflow (37) | pm-ado, pm-beads, pm-brand, pm-brief, pm-case, pm-changelog, pm-cli, pm-context, pm-csv, pm-evidence, pm-gantt-chart, pm-github, pm-glossary, pm-graph, pm-http, pm-hypothesis, pm-jev, pm-jira, pm-linear, pm-lint, pm-memory, pm-presets, pm-reduce, pm-review, pm-rl, pm-rlm, pm-rust, pm-screen, pm-slack, pm-slack-standup, pm-starter, pm-swarm, pm-todos, pm-ts-starter, pm-unit, pm-vcs, pm-web | No automatic delivery. Migrate through the canonical caller/template path to a released reviewed SHA; copied merge loops need that update to eliminate stale approval diagnosis. Receipt/signer continuation fixes become relevant when the shared continuation path is adopted. |

The canonical runner-free continuation has no merge-wait deadline. It reports
fresh blockers whenever a pending or refresh decision is made. It reads the
current exact release head, required failed check names and links, strict BEHIND state,
DIRTY conflicts, and currently waiting/action-required runs; no approval flag is
retained between decisions. The migration must not copy the obsolete wait loop.

Preparation tooling remains bound to the candidate preparation run and SHA.
New publication uses the executing reusable job's `job.workflow_ref`, matching the
OIDC `job_workflow_ref` claim, rather than the preparation pin. GitHub documents
this distinction at
https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows.
The verifier still authenticates exact signer SAN, certificate source repository,
merged commit and ref, signature, transparency evidence and artifact digest.

The pm-ops item `ops-release-diagnosis-propagation` tracks
[issue #272](https://github.com/unbraind/pm-ops/issues/272) and fleet adoption.

Existing npm uploads are verified against their original publishing job, resolved
from the scoped invocation and authoritative Actions run metadata, using the same
resolver as independent recovery. A subsequent caller pin update cannot replace
that signer. The bundle is still cryptographically checked against the resolved
identity; neither current-job identity alone nor decoded claims authorize recovery.
Diagnosis selects required contexts, issuer bindings and current workflow runs
through `requiredProtection`, shared with approval selection. Optional checks and
optional waiting runs do not become release blockers.

## Two-package pilot decision, 2026-11-14

| Question | Measured result | Decision |
| --- | --- | --- |
| (a) Dependency/workflow changes without a requested-release item | The real tracker and dependency-only Git-window test executes the parsed reusable workflow step with consumer hooks that omit the flag. The original step fails `MISSING_REQUESTED_RELEASE`; forwarding the flag alone also leaves nested `release:check` inconsistent. | The shared step persists `--include-empty` in the three configured package hooks before calling them with that option. Nested checks and later repository checks therefore use the same policy. The existing canonical wrapper normalizes legacy empty-section output; old raw generators need the #337 prerequisite below. Tree-change admission and the calendar publication cap still apply. |
| (b) Older open release PRs | Existing planning selects the newest owned date branch and lists older owned PRs. The continuation adapter test re-reads ownership and successor receipt, records supersession, retires the old receipt and closes the old PR. Failed closure remains visible; foreign/human PRs are preserved. | Retain the existing canonical implementation. Copied workflows receive this behavior through the pilot pin. |
| (c) Cross-repository npm OIDC | npm's current docs say reusable-workflow validation checks the calling workflow. GitHub's standard workflow claims describe the caller; `job_workflow_ref` describes the executing reusable workflow. A local session has no GitHub Actions OIDC token endpoint, so a local dry check cannot prove registry acceptance. | Configure each package's trusted publisher for its own repository and `release.yml`, with `npm publish` allowed. Documentation supports reuse; live cross-repository acceptance remains an explicit pre-activation gate. Missing live evidence is not a rejection and does not justify falling back to copies. |

The regression `dependency-only release windows run the canonical changelog step
without a requested-release item` uses the installed generator and pinned CLI,
without tracker mocks. It also checks that unchanged trees and an already
published calendar day do not admit a release. The same test failed before the
shared invocations changed and passes after them. It also executes nested
`release:check`, proves preparation is idempotent, commits and tags the fixture,
and executes the same repository gate after tagging. Reverting only persistence
of the hook policy reproduces the nested-check failure. Existing real-tracker
tests retain all 64 combinations of historical empty/nonempty release windows.
The initial focused baseline passed 139 tests, including superseded cleanup.
Initial `npm run release:check` and `bun run release:check` gates at commit
`7c557120aca03f68c88903e20228ad00c89aac66` passed: each reported
1,672 passed, 2 skipped and 0 failed tests, with all four coverage dimensions at
100% across the configured 48 source files. The skipped cases are opt-in scans
of configured real repositories; neither feature-specific proof was skipped.
Bun's gate also ran with isolated HOME and Git configuration. Both unchanged
pilot candidates pass `npm run changelog:check`.
The expanded final regression and both canonical attestation contracts pass
(3 passed, 0 failed, 0 skipped), and the standalone publish-attestation gate
passes. Full npm/Bun certification of the final review edits remains pending CI;
the earlier full results do not certify the final head.

The additional raw-generator post-tag probe reproduced the already open
[pm-changelog #337](https://github.com/unbraind/pm-changelog/issues/337) with the
pinned 2026.11.6 generator. No duplicate issue or pm-changelog patch is introduced.
The canonical wrapper already handles this legacy output. Stop adoption of an
affected raw-generator consumer until its generator or package-owned wrapper
passes the same pre-tag/post-tag gate; upgrading that dependency remains owned
by Dependabot. Passing the preparation step alone is insufficient evidence.

OIDC references, read on 2026-11-14:

- [npm trusted publishing: configuration and troubleshooting](https://docs.npmjs.com/trusted-publishers/)
- [GitHub OIDC with reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)

The canonical step **Verify npm will accept this workflow's OIDC identity** is
the dry check: it mints a GitHub id-token and exchanges it at npm's package-scoped
OIDC endpoint, without publishing. A successful 2xx exchange proves identity
acceptance, not the separately configured allowed action. Do not print either
token or the response credential. The released workflow has no identity-only
entry point; `reconcile-only` does not execute this check. No release dispatch,
publication, npm owner configuration change, or fabricated live receipt is part
of this work. The orchestrator must retain the successful cross-repository
preflight job URL before treating either pilot as verified for publication.

The prerequisite run's
[self-caller request job](https://github.com/unbraind/pm-ops/actions/runs/43553624308/job/132323825169)
reported `npm accepted this workflow's identity for pm-ops.` at 04:04:01Z.
This proves the same-repository reusable call exchanges successfully, while
cross-repository acceptance remains unmeasured. The exact local preflight exited
1 with the explicit missing-OIDC-endpoint notice before any registry request.

Actionlint v1.7.12 accepts the thin caller template. Against the canonical shared
workflow it reports ten existing diagnostics for `concurrency.queue` and
`job.workflow_sha`/`job.workflow_ref`; running it against unchanged main reports
the same ten. These are recorded as static-tool schema limitations rather than
silently ignored or represented as a clean shared-workflow lint result.

Pilot candidates are **pm-lint** and **pm-jira**. Both retain their pm-changelog
scripts, including `--include-empty`, so the released baseline is safe for
item-less windows even before the shared fix is released. pm-lint must retain
the string comparison `vars.PM_RELEASE_APPROVED == 'true'` and its exact
repository/main guards through `release-enabled`. pm-jira must retain
`release:update-version` through `prepare-script`. The proposed callers retain
the daily schedule and add canonical hourly reconciliation. Their existing root
`github-actions` Dependabot entries cover the SHA-pinned reusable call.

The tested source baseline is main commit
`394a95fe8f5760be20275a276f5ef7279367a28c`. No pilot may pin it until a newer
canonical release exists and its actual tag has been dereferenced. The
prerequisite run completed successfully by preparing
[release PR #274](https://github.com/unbraind/pm-ops/pull/274); its CI and CodeQL
runs initially required approval. Preparation is not publication or a released pin.

At the one-hour cutoff, **2026-11-14 04:55:38Z**, the newest GitHub Release was
still v2026.11.11. No newer tag/SHA was selected and no pilot PR was opened;
both pilot worktrees have no tracked changes. The prerequisite run succeeded
and has no failed-job logs. By the cutoff, #274's CodeQL had passed and CI was
running after the earlier approval hold, but publication was still pending.
Pilot work stopped under the release guard. All 36 authorized copied workflows
therefore remain unmigrated: the two proposed pilots plus the 34 listed below.
The canonical candidate and evidence are in
[pm-ops PR #275](https://github.com/unbraind/pm-ops/pull/275).

### Remaining rollout

After the orchestrator verifies both pilots, release the shared empty-window fix
and roll out the reviewed released SHA in small batches. Before each PR, inspect
package approval gates, generation/check/notes hooks, version stamping, committed
outputs, completeness audit, extra publication targets and synthetic services.
Preserve package-specific behavior through canonical inputs; do not maintain a
second release transaction. Run the caller/attestation check, YAML/actionlint and
changelog check per package, and retain exact-head CI and preflight evidence.
Only the orchestrator merges and dispatches.

The remaining **34** authorized packages after these two pilots are:
pm-ado, pm-beads, pm-brand, pm-brief, pm-case, pm-changelog, pm-context, pm-csv,
pm-evidence, pm-gantt-chart, pm-github, pm-glossary, pm-graph, pm-http,
pm-hypothesis, pm-jev, pm-linear, pm-memory, pm-presets, pm-reduce, pm-review,
pm-rl, pm-rlm, pm-rust, pm-screen, pm-slack, pm-slack-standup, pm-starter,
pm-swarm, pm-todos, pm-ts-starter, pm-unit, pm-vcs, pm-web.

pm-review and pm-rlm require owner-managed npm trusted publisher setup. Existing
pm-ado gate failures and pm-slack tag failures need separate diagnosis if they
survive canonical adoption. pm-rust and pm-web need their Cargo and Postgres
inputs respectively. pm-cli is excluded: only upstream issues may be filed there.
