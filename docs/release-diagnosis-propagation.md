# Release diagnosis, receipt and publishing signer propagation

Inventory checked on 2026-11-13 using the fleet workflow checkouts, then the
GitHub contents API for each package's `main:.github/workflows/release.yml`.
The local checkouts lag current main (including pm-ops); current remote main is
the classification below. GitHub code search returned zero indexed matches and
was not treated as proof of absence. Only pm-ops is changed by this PR.

| Workflow form | Packages | Delivery of #268, #269, #270 |
| --- | --- | --- |
| Local reusable caller | pm-ops | Its `release.yml` calls `./.github/workflows/daily-release.yml`; all three fixes apply after merge on subsequent main runs. |
| External reusable callers | None among the 38 inventoried package release workflows | A mutable ref would receive the canonical workflow fixes automatically; a SHA-pinned caller requires an explicit reviewed pin update. |
| Copied release workflow (37) | pm-ado, pm-beads, pm-brand, pm-brief, pm-case, pm-changelog, pm-cli, pm-context, pm-csv, pm-evidence, pm-gantt-chart, pm-github, pm-glossary, pm-graph, pm-http, pm-hypothesis, pm-jev, pm-jira, pm-linear, pm-lint, pm-memory, pm-presets, pm-reduce, pm-review, pm-rl, pm-rlm, pm-rust, pm-screen, pm-slack, pm-slack-standup, pm-starter, pm-swarm, pm-todos, pm-ts-starter, pm-unit, pm-vcs, pm-web | No automatic delivery. Migrate through the canonical caller/template path to a released reviewed SHA; copied merge loops need that update to eliminate stale approval diagnosis. Receipt/signer continuation fixes become relevant when the shared continuation path is adopted. |

The canonical runner-free continuation has no merge-wait deadline. It reports
fresh blockers whenever a pending or refresh decision is made. It reads the
current exact release head, failed check names and links, strict BEHIND state,
DIRTY conflicts, and currently waiting/action-required runs; no approval flag is
retained between decisions. The migration must not copy the obsolete wait loop.

Preparation tooling remains bound to the candidate preparation run and SHA.
Publication uses the executing reusable job's `job.workflow_ref`, matching the
OIDC `job_workflow_ref` claim, rather than the preparation pin. GitHub documents
this distinction at
https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows.
The verifier still authenticates exact signer SAN, certificate source repository,
merged commit and ref, signature, transparency evidence and artifact digest.

One pm-ops follow-up, `ops-release-diagnosis-propagation`, tracks fleet adoption.
No consumer repository or per-repository tracker item is changed here.
