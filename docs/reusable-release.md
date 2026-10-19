# One daily release workflow

`daily-release.yml` owns the release transaction. Callers own their schedule and package settings, pin one released pm-ops commit, and put its release version in the same `uses:` line as `# vYYYY.M.D`. There is no second pm-ops version input. Dependabot's `github-actions` updater can update that SHA and comment together.

The starting implementation is [pm-github #152](https://github.com/unbraind/pm-github/pull/152) at `14b533a3dc944b245af6787628883e475446800b`, including [#149](https://github.com/unbraind/pm-github/pull/149). The upstream recheck found #152 merged at main `5f169971d4a5f37d48795512c2c100ccf571c8d9`; its release workflow is byte-identical to that baseline.

## Inventory

Snapshot: 2026-10-19, freshly fetched `origin/main`. Each readable workflow was read with `git show origin/main:.github/workflows/release.yml` and hashed as raw bytes with MD5. The expected 29 large copies are not the current eligible corpus: **28** package workflows are readable, `pm-observer` has no workflow, and `pm-memory` has no fetchable origin. The core pm-cli repository is outside the authorized scope. No consumer checkout was edited. Several workflows have 134–626 lines, rather than 850–1,050.

[release-divergences.json](release-divergences.json) records every compared structural difference, its category, resolution, main SHA, raw MD5, and hashes of both compared values. The comparison unit is a top-level field, job field, whole named step, or step order; a missing field/step is included. Whole-step classifications describe their primary purpose; a package-specific step can also contain stale boilerplate. Raw MD5 retains whitespace/comment differences that YAML parsing removes. This is an inventory, not a claim that every nonbaseline line is defective.

- **(a)** Cosmetic or stale: names, repository names in prose/URLs, schedules, comments, ordering, and tool/runtime pin currency. The caller keeps the schedule; the shared workflow owns pinned actions and tools.
- **(b)** Package needs: approval guards, Cargo/just, source/version stamping, committed dist, full-window or self-hosted pm-changelog scripts, failure reporting, recovery, isolated artifact preparation, extra publish targets, bundles, and Postgres. These become the inputs below, maintained package scripts, or shared protections applied universally.
- **(c)** Defects: same-day suffix releases; stale PR snapshots; unsafe/fork/human branch adoption; capped or nondeterministic PR selection; blocking superseded cleanup; weak provenance reconciliation; stale dist; tag races; missing main gates; and Bun hiding or blocking a GitHub Release. These are centralized rather than copied.

28 readable package copies, 28 distinct MD5 values. The structural comparison records **123 cosmetic/stale (a), 318 package needs (b), 272 defect differences (c)**, 713 total. Counts are deltas, not mutually exclusive repository counts.

| Package | Main SHA | Lines | Raw MD5 | a/b/c deltas | Legitimate need or migration note |
| --- | --- | ---: | --- | ---: | --- |
| pm-ado | `60e82831e38c` | 855 | `7363ad9313ba52fab0dec2f0abafec33` | 1/4/7 | Approval variable; breaking-change changelog option |
| pm-beads | `90898c908fb9` | 935 | `e4e02c00da9304b0b46d33731916b616` | 1/9/7 | Failure issue reporting |
| pm-brand | `977976cfd929` | 134 | `12c16394e802fb38ed45500bdc3bae3d` | 10/22/14 | Approval variable; reviewed fixed-version policy; read-only artifact preparation |
| pm-brief | `b89eb224b15b` | 881 | `94822d2af745edaa400db5cadee285c5` | 1/10/7 | Failure issue reporting |
| pm-changelog | `d80fdea89c7b` | 950 | `3d48e8f35562c3ed90b49d0c7a78dc71` | 3/6/10 | Self-hosted changelog generator; src/extension.ts and committed dist; missing Release recovery |
| pm-context | `838e3d6c21e5` | 1050 | `c3c4f85dd505b634cdbd5419466bb2c6` | 1/13/8 | Resume prepared metadata without rewriting notes; failure issue reporting |
| pm-csv | `96c2c825800f` | 915 | `84e970e0f4864aca0fc42faa7735483a` | 1/9/8 | Failure issue reporting |
| pm-gantt-chart | `36e59128e6f9` | 904 | `1b5f05f05f5b1b2557986418b88f2f38` | 2/11/7 | Full-window notes; failure issue reporting |
| pm-github | `09412243e254` | 846 | `a76b274389ae687c8ec599dbbb58f94b` | 1/1/5 | Pure release planning baseline from #149; #152 is not yet on main |
| pm-graph | `a9175ac6b92c` | 890 | `306f7a6dcf1e381840de142ba8f48b1c` | 1/3/7 | Full-window notes |
| pm-jev | `ff792f54db5a` | 958 | `c7efe5d0804b07bce4e81c22332acb0c` | 13/36/16 | Approval variable; read-only artifact handoff; missing Release recovery |
| pm-jira | `48d2fa6cc14a` | 860 | `8915a8bf5dbc5dd8a9bb276fbbffe301` | 1/3/7 | Full-window notes |
| pm-linear | `61abe04bcd26` | 939 | `9bcf9ec52a31e319acb94c7af3bb4627` | 1/1/8 | None beyond common npm hooks |
| pm-lint | `66a2af13a7e1` | 958 | `d3f5a878ab279b15935fcc7e41ce5189` | 14/36/16 | Approval variable; read-only artifact handoff; missing Release recovery |
| pm-ops | `c3af218f2f05` | 949 | `8dd55cfa1ffc163143392d25496e6910` | 1/4/9 | Release completeness audit after publication |
| pm-presets | `35b08d4e26d0` | 853 | `db53f364f4789a7a9773e78007f8c6d9` | 1/3/7 | None beyond common npm hooks |
| pm-review | `7a3794a32c42` | 941 | `2f99a8e38a33ebf2a90e263bb71bdbdc` | 14/36/16 | Approval variable; read-only artifact handoff; missing Release recovery |
| pm-rl | `671509843010` | 626 | `6940aee163335796d68b63c73e8ce71e` | 2/4/12 | Approval variable |
| pm-rlm | `a82a55754425` | 958 | `a045ecca777c093ed15887d9786a1891` | 14/36/16 | Approval variable; read-only artifact handoff; missing Release recovery |
| pm-rust | `22f6243cc443` | 586 | `92859729b879af3f057fc30b015a103b` | 7/12/13 | Cargo/just toolchains, crate and justfile stamping; GitHub-only; locked parity oracle |
| pm-slack | `34e9e2023c12` | 853 | `bd0a5e9399d84c5e73c6d6051e56a3c0` | 1/3/8 | Committed dist |
| pm-slack-standup | `8b86e1f06f45` | 852 | `3785e4fc22307d663e6838d23c48db9e` | 4/3/7 | Committed dist |
| pm-starter | `d75b29b63646` | 852 | `49c6832913434dda3b8bb23e4c2d915b` | 1/3/7 | Committed dist |
| pm-swarm | `b92f8fff70da` | 958 | `c9a9d75958cda84e9a03b36c45ee76cd` | 14/36/16 | Approval variable; read-only artifact handoff; missing Release recovery |
| pm-todos | `e755d02c49b6` | 845 | `1a85ac747eea1c27474e3249f1762bb3` | 2/2/6 | release:update-version script |
| pm-ts-starter | `c883f363a12a` | 852 | `bcd1f265045091901a192fed4630e199` | 1/3/7 | Committed dist |
| pm-vcs | `7609e6c61980` | 613 | `bb5da946b51d2246feeba7205f74630d` | 5/4/12 | Self-host verification/bundle via package hooks; legacy fixed changelog date |
| pm-web | `8e9cc9713778` | 929 | `b03c39fefdfa4f5ffcffd1914202d5ab` | 5/5/9 | Postgres checks; src/index.ts and committed dist |

The inventory main snapshot predates #152; the implementation uses its audited PR head. The final fetched main workflow matches it exactly. The five newer artifact workflows (pm-jev, pm-lint, pm-review, pm-rlm, pm-swarm) and pm-brand demonstrate read-only preparation; that protection is shared by all callers here. pm-brand's reviewed fixed-version policy uses `version-policy: package`, retaining its existing release approval variable. Its version must change in a reviewed PR before another coordinate becomes eligible.

## Transaction and invariants

1. The `prepare` job has `contents: read` and `pull-requests: read`. It refreshes current main, resolves the workflow's own version, installs dependencies, and reads PR candidates through a file. Only same-repository PRs authored by `app/github-actions` with a complete `release/YYYY.M.D` branch name are eligible. Numeric date and PR number order decide selection. The 1,000-candidate guard fails closed if the CLI result might be truncated. No payload is exported through the environment.
2. `decideDailyRelease` blocks an existing daily tag and unchanged trees/heads. In reviewed-package mode it also checks actual GitHub Release publication dates in the configured timezone and refuses an already tagged package version. It refreshes a stale eligible PR from current main, never from that PR's old snapshot. It never generates a same-day `-N` release.
3. Version stamping uses the existing TypeScript lexer for extension descriptors, not a regex matching the first arbitrary `version` property. npm projects update package/lock/manifest metadata, run the optional prepare hook, rebuild dist cleanly, generate/check CHANGELOG.md with package-owned pm-changelog scripts, and generate notes with the notes script. Rust updates Cargo and the committed justfile date, then uses the package's pinned just recipes. This preserves its changelog SDK pairing and locked parity oracle.
4. npm and Bun run the configured verification gate before preparation is accepted. A fixed-argv TypeScript adapter validates the Bun script name and propagates real execution failures; the canonical attestation auditor remains unchanged. Rust runs `just release-check`. A read-only job commits local metadata and packs the verified npm artifact with lifecycle scripts disabled. A Git bundle, tree/commit identities, SHA-256 of the package, and notes cross the artifact boundary.
5. The `release` job verifies that handoff, checks npm OIDC identity before mutating a branch, verifies the base has not moved, and leases all branch writes. An existing unverified branch is refused. Only GitHub's protected merge API can land metadata. Superseded PR closure, metadata edits and branch cleanup failures are warnings, with deletion leased to the prepared commit.
6. If the workflow trigger SHA differs from the merged SHA, the job dispatches the caller workflow on main and stops before publishing. The continuation prepares and checks main again. Publication requires trigger SHA = merged main SHA and prepared tree = merged tree. This makes the npm provenance source commit and release tag agree. Dispatch uses `actions: write`; the caller must keep `workflow_dispatch` and must not add another `daily-release` concurrency group.
7. npm trusted publishing uses OIDC and `--provenance --ignore-scripts`. No stored npm token is accepted. The packed artifact is published; package scripts do not run in the privileged job by default. If a coordinate already exists, registry-served SLSA provenance must bind its SHA-512 artifact digest and source commit before it can be reconciled. This checks the registry's provenance statement; it does not replace independent Sigstore signature verification. Failed reads retry within the inherited visibility window. A successful npm response alone does not bypass the provenance readback.
8. Extra publish hooks run before tagging. The remote tag must name the verified commit. A separate read-only job verifies Bun installation and bunx activation in a disposable tracker. Bun failure stays visible; the GitHub Release is already created after publication and tagging. Post-release hooks can upload self-host bundles or run package-owned completeness checks. Hooks are npm script names, passed through environment values, never interpolated shell source.
9. A tagged unchanged head may repair a missing GitHub Release using the read-only job's notes. The `recover` job has only `contents: write`; it neither republishes npm nor changes a tag, and checks matching npm provenance first when npm publication is enabled. The optional `alert` job alone receives `issues: write`.

All actions use full commit SHA pins. Workflow-wide permissions are empty. Privileged jobs require the caller's main ref and release approval. Input paths are constrained to the workspace, including symlink resolution. The reusable workflow requests no secrets. npm hooks are optional, explicit package code; when configured, their dependencies are installed with lifecycle scripts disabled.

GitHub documents that [`job.workflow_sha`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context) identifies the workflow defining the current job. The resolver matches that commit against public release tags, peels annotated tags, normalizes padded versions, rejects ambiguity and refuses an untagged commit. Caller context remains the calling repository. GitHub also documents that [reusable workflow permissions can only be maintained or reduced](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).

## Inputs

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release-enabled` | boolean | `true` | Approval gate; pass the existing repository variable comparison for unapproved packages |
| `npm-project-dir` | string | `.` | Relative npm project directory; Rust uses the crate root |
| `node-version` | string | `22.18.0` | Node runtime for release tools |
| `release-timezone` | string | `Europe/Vienna` | Calendar timezone for the single daily release |
| `rust` | boolean | `false` | Use Cargo versioning and just release-check instead of npm project hooks |
| `rust-toolchain` | string | `1.90.0` | Rust stable toolchain including clippy and rustfmt |
| `rust-nightly` | string | `nightly-2026-08-06` | Rust coverage toolchain including llvm-tools-preview |
| `prepare-script` | string | `(empty)` | Optional npm script after version stamping, before the build |
| `build-script` | string | `build` | npm build script; empty skips the build |
| `verify-script` | string | `release:check` | Required npm gate, run before commit and at merged main |
| `changelog-script` | string | `changelog:full` | pm-changelog generation npm script |
| `changelog-check-script` | string | `changelog:check` | pm-changelog verification npm script |
| `notes-script` | string | `release:notes` | pm-changelog release notes npm script |
| `publish-script` | string | `(empty)` | Optional npm hook for extra publish targets, after npm and before tagging |
| `post-release-script` | string | `(empty)` | Optional npm hook after GitHub Release creation, e.g. upload self-host bundle |
| `release-files` | string | `(empty)` | Additional newline-separated repository-relative files to commit (no globs) |
| `npm-publish` | boolean | `true` | Publish npm with OIDC; false for a GitHub-only crate release |
| `bun-verify` | boolean | `true` | Verify the published npm coordinate installs with Bun |
| `bunx-script` | string | `(empty)` | Optional npm script for package-specific bunx acceptance after installation |
| `postgres` | boolean | `false` | Provide the synthetic Postgres service required by pm-web release checks |
| `alert-script` | string | `(empty)` | Optional npm script for failure reporting in a separate issues-write job |
| `version-policy` | string | `daily` | daily bumps the date automatically; package preserves a maintainer-reviewed package.json version |

For `release-files`, use exact repository-relative filenames, one per line. Modified tracked metadata, extension sources and committed dist in the selected project are included automatically; additional outputs need explicit paths. Keep generated binary/cache files ignored; a bundle upload hook should produce local artifacts and attach them to the existing GitHub Release, rather than commit them.

The `prepare-script` hook covers pm-todos' `release:update-version` and other package metadata. `verify-script` retains pm-vcs' existing self-host acceptance; `post-release-script` can build/upload its bundle and run pm-ops' completeness audit. pm-web sets `postgres: true`. A package whose changelog CLI is self-hosted keeps its scripts and uses `changelog-script`, `changelog-check-script`, and `notes-script`. Set `build-script: ''` only for a package without a dist build. Explicit approval-variable expressions must be carried into `release-enabled`; do not replace them with literal true during migration.

## Caller check

`npm run release-caller -- path/to/release.yml` fails on a copied implementation, additional jobs/steps, unsafe triggers, inherited secrets, missing least-privilege grants, a non-SHA reference, a zero placeholder SHA, a missing version comment, or a second pm-ops version input. The exported `pm-ops/release-caller` function is also available to package gates.

The canonical publish-attestation auditor also recognizes this exact caller at `.github/workflows/release.yml`. Its result explicitly identifies delegation to the verified pm-ops workflow. Foreign or floating references, placeholder SHAs, private workflow logic and malformed callers do not satisfy the non-vacuity gate. Every adjacent local, foreign or unresolved publisher is still checked, and parse failures remain failures. The gate does not independently re-audit remote workflow contents.

The caller CLI, exported checker, policy and attestation auditor resolve canonical tag refs online by default, including annotated tag peeling. They use `gh api` with pagination, falling back to the public GitHub matching-refs API through curl if gh is unavailable or unauthenticated. The fallback supports `GH_TOKEN` and `GITHUB_TOKEN` and also permits anonymous public reads. A successful canonical response is authoritative: a fork-only SHA or mismatched tag is refused even when bundled metadata says otherwise. `--online` remains accepted for compatibility.

`release-metadata.json` is only a fallback when both online transports are unavailable. A known snapshot tag must still match its SHA. A tag absent from the snapshot produces **`unverified-offline`**: caller CLI exit remains successful but reports deferral, policy returns `pass: false` with `status: "unverified-offline"` and excludes it from passed/failed counts, and attestation returns `recognition.kind: "unverified-offline"` with an explicit provenance-unverified note. No verified-delegation or attestation-success claim is emitted. Structural defects and adjacent unsafe publishers still fail. Strict policy does not turn deferred provenance into a hard failure. Retry online before treating a deferred result as approval.

The structured `inspectReleaseCaller` API distinguishes verified, refused and deferred outcomes. The compatibility `checkReleaseCaller` API returns diagnostic strings, including the offline deferral; callers must not infer approval from a successful CLI exit alone. Maintainers can refresh the offline fallback with `npm run release-caller -- --write-metadata release-metadata.json`. The newest release works online immediately after its canonical tag exists, without waiting for a later snapshot-bearing package. Never add guessed SHAs to the snapshot. GitHub documents the public [canonical matching-refs endpoint](https://docs.github.com/en/rest/git/refs#list-matching-references).

The same check is available as an opt-in pm-ops policy check:

```json
{"checks":[{"id":"release-caller","severity":"error"}]}
```

Run `npx pm ops policy --policy release-policy.json --repos . --strict`. It is opt-in until the fleet migration occurs: pm-ops' own existing release workflow must continue releasing the first version that contains the reusable workflow. Self-gating here means the new implementation/tests are part of the unchanged 100/100/100/100 release gate; it does not require pointing production at an unreleased workflow.

## Migration

**No consumer is changed by this PR.** The zero SHA in the template and examples is an explicit substitution marker and is rejected by the check. A real released SHA containing `daily-release.yml` does not exist until this PR is reviewed, merged and released by the orchestrator. Do not pin today's old release, the feature branch, or a nonexistent guessed future release.

First merge the automated Dependabot upgrade of the package's pm-ops dependency to the release introducing caller-delegation recognition (or newer). This is a one-time migration prerequisite for existing attestation shims; older versions correctly reject a caller with no local publisher. Do not hand-bump consumer dependencies in this PR. Future workflow fixes require only the GitHub Actions SHA update, not a second pm-ops version input.

The wave script must resolve the first approved release tag containing this workflow, substitute that peeled SHA and actual `# vYYYY.M.D` comment, and verify that the workflow exists at that commit. Enable Dependabot's `github-actions` ecosystem for the repository. Configure npm trusted publishing for the caller repository and `release.yml`, with the npm publish action enabled; [npm documents that reusable workflow validation uses the caller workflow identity](https://github.com/npm/documentation/blob/main/content/packages-and-modules/securing-your-code/trusted-publishers.mdx); the live OIDC preflight must still pass before enabling the pilot. No NPM_TOKEN is passed. Test the resulting caller with the check before committing it.

Exact pm-csv caller after those two mechanical pin substitutions:

```yaml
name: Daily Release
on:
  schedule:
    - cron: "23 3 * * *"
  workflow_dispatch:
permissions: {}
jobs:
  release:
    permissions:
      contents: write
      pull-requests: write
      actions: write
      id-token: write
      issues: write
    uses: unbraind/pm-ops/.github/workflows/daily-release.yml@0000000000000000000000000000000000000000 # v2026.10.19
    with:
      alert-script: release:alert
```

The pm-csv migration must also convert its `verify:release-workflow` script and local workflow-shape tests to the caller contract. Keep the script name used by `release:check`, but have its implementation call the published `inspectReleaseCaller` API; replace assertions about local publisher steps with caller shape/input assertions. For example, the npm script can use this command:

```sh
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {inspectReleaseCaller} from 'pm-ops/release-caller'; const result = inspectReleaseCaller(readFileSync('.github/workflows/release.yml', 'utf8')); console.error(result.status, ...result.errors); if (result.status === 'refused') process.exitCode = 1;"
```

Apply the same one-time conversion wherever consumer tests assert a private workflow's step names, including Rust workflow guards. Do not delete those checks without replacing them with caller assertions. The publisher implementation's regressions live in pm-ops and do not get copied back into consumers.

Preserve its current alert by adding the npm script `"release:alert": "bash scripts/alert-on-release-failure.sh"` in the same migration PR. The package's current `changelog:full`, `changelog:check` and `release:notes` scripts remain the pm-changelog contract. The other npm packages use `templates/release-caller.yml`, adding only their documented inputs and any existing approval expression.

Exact pm-rust caller after the same pin substitutions:

```yaml
name: Daily Release
on:
  schedule:
    - cron: "23 3 * * *"
  workflow_dispatch:
permissions: {}
jobs:
  release:
    permissions:
      contents: write
      pull-requests: write
      actions: write
      id-token: write
      issues: write
    uses: unbraind/pm-ops/.github/workflows/daily-release.yml@0000000000000000000000000000000000000000 # v2026.10.19
    with:
      release-enabled: ${{ vars.PM_RELEASE_APPROVED == 'true' }}
      rust: true
      rust-toolchain: "1.90.0"
      rust-nightly: "nightly-2026-08-06"
      node-version: "26"
      npm-publish: false
      bun-verify: false
```

Rust keeps its justfile recipes and existing approval guard. It publishes a GitHub Release only; no npm package or new crate registry target is invented. The caller permissions are the ceiling for the shared workflow; the GitHub-only path does not perform an npm OIDC exchange. Every caller grants `issues: write` even with an empty alert hook, because GitHub validates nested permissions before conditional jobs run.

After pm-csv and pm-rust pass their own unchanged gates and a controlled daily-release run, migrate the remaining approved packages in waves. Keep unapproved packages disabled. Verify actual npm/GitHub publication, exact tag/provenance commit, Bun acceptance, alerts and retry behavior separately from local tests. Local gates do not establish live trusted-publisher acceptance.

## Verification

The new functions have behavioral regressions for ownership, numeric ordering, candidates beyond 30, stale PR refresh from main, unchanged trees, daily caps, reviewed versions, descriptor stamping and provenance binding. Tests parse YAML and check effective job permissions, full action pins, hook wiring, packed artifact publication, continuation commit checks, and failure-independent cleanup. Tests execute shell syntax checks and a failing superseded-close boundary. Revert proofs and exact full-gate counts are attached to `ops-reusable-daily-release`.

`actionlint` v1.7.12 predates GitHub's documented `job.workflow_sha` property. The narrow `-ignore 'property "workflow_sha" is not defined'` exception is necessary for that known analyzer gap; all other expression/schema checks remain enabled. Shell blocks are also parsed with `bash -n` by the suite. No releases, tags, merges or consumer deployments are performed by this task.
