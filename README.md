# pm-ops

Multi-repo fleet operations for [pm-cli](https://github.com/unbraind/pm-cli).

`pm-ops` gives coding agents one command surface for operating across **many** `pm-*` repositories: audit release readiness, enforce naming/workflow policies, run a release-gate matrix, and emit concise fleet reports. Its optional lint and duplication toolchains stay out of the extension's runtime dependencies.

> Philosophy: _project management = context management_, applied to a **fleet** of repos.

---

## Installation

Use the published package so npm installs its runtime dependencies before activation.
In a plain project directory (no git repository required), initialize a tracker and
activate the pinned registry release:

```bash
npx -y @unbrained/pm-cli@2026.10.21 init --defaults --agent-guidance skip
npx -y @unbrained/pm-cli@2026.10.21 install npm:pm-ops@2026.10.21 --project
```

With Bun, use `bunx` instead of `npx -y` for both commands.
The explicit `npm:` source selects the registry package.

GitHub-source activation alone does not install this package's runtime dependencies.
It requires built `dist/` output and all `package.json` runtime dependencies
(including `@toon-format/toon`, `typescript` and `yaml`) resolvable from the
activated module graph, plus the pm CLI peer. A fresh source-only project lacks
those dependencies and activation fails. Use the registry route above for fresh
projects; a source checkout needs dependency installation and a build before local
activation.

### Without git

Tracker metrics, policy checks and file-based reports work in plain directories.
GitHub probes, release inventory/repair and changelog generation from tags need a
git repository and their provider tools. Git-only checks do not certify a plain
tracker as a release checkout.

---

## Commands

### `pm ops scan`

Scan a set of repos and produce a per-repo release-readiness snapshot.

```bash
pm ops scan
pm ops scan --repos ./pm-csv ./pm-github
pm ops scan --repos ./pm-csv,./pm-github --json
pm ops scan --format markdown
pm ops scan --repos ~/container/pm-* --format markdown --output FLEET.md
```

For each repo `scan` checks:

- `package.json` present (name, version)
- `tsconfig.json` with `strict: true`
- `CHANGELOG.md` present
- `.github/workflows/release.yml` and `ci.yml` present
- `.agents/pm` workspace + open/in_progress item counts (`pm list --json`)
- `pm-changelog` declared in dependencies/devDependencies, or explicitly self-hosted by the generator package
- `npm outdated` count
- `npm audit --omit=dev` critical/high counts
- open PRs/issues via `gh` (when the repo is a GitHub repo)

A repo is `ready` when it has a package.json, strict TS, a changelog, both CI/release workflows, pm-changelog wired, and a successful audit with zero critical vulnerabilities. An unavailable or malformed online audit is reported and blocks readiness instead of being mistaken for a clean result. In explicit offline mode, network checks are skipped and do not gate file-based readiness.

The JSON field `has_pm_changelog` records a declared dependency. `self_hosts_pm_changelog` separately identifies the generator package named `pm-changelog`, with bin `pm-changelog: dist/cli.js`, a `changelog:full` script starting with `node dist/cli.js`, and `changelog:check` set to `npm run changelog:full -- --check`. Scan and status accept either dependency wiring or this self-hosted configuration. These are structural checks; `ops verify-release` runs the actual release checks.

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths to scan (comma-separated or repeatable) |
| `--json` | boolean | false | Emit clean JSON to stdout (progress on stderr) |
| `--format <toon\|json\|markdown>` | string | `toon` | Output format |
| `--output <file>` | string | — | Write the rendered output to a file instead of stdout |

---

### `pm ops policy`

Validate a policy bundle against repos. The default policy (no file needed) checks:

- **naming** — repo name matches `^pm-[a-z][a-z0-9-]*$` (no `pm-ext-` / `pm-preset-` prefixes)
- **required-scripts** — `package.json` has `typecheck`, `test`, `build`, `release:check`, `changelog`, `changelog:check`; the explicit self-hosted configuration above uses `changelog:full` in place of `changelog` (custom policy requirements remain exact)
- **required-workflows** — `ci.yml` + `release.yml` present
- **private-no-runners** — private repos must NOT use `runs-on: github-hosted` / `macos-` / `windows-` / `ubuntu-` (skipped for public repos)
- **pm-duplicate-titles** — no two OPEN pm items share the same title
- **pm-changelog-wired** — `pm-changelog` in dependencies/devDependencies AND a `changelog` script exists, or the explicit self-hosted configuration above

```bash
pm ops policy
pm ops policy --repos ./pm-csv ./pm-github
pm ops policy --policy ./fleet-policy.json --strict
pm ops policy --format markdown
```

`--policy <file>` loads a JSON bundle overriding the defaults:

```json
{
  "checks": [
    { "id": "naming", "severity": "error" },
    { "id": "required-scripts", "severity": "error", "repo_filter": "pm-csv",
      "params": { "scripts": ["typecheck", "test", "build"] } }
  ]
}
```

`--strict` exits non-zero on any failed check (any severity).

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths to check |
| `--policy <file>` | string | built-in | JSON policy bundle |
| `--json` | boolean | false | Emit clean JSON to stdout |
| `--format <toon\|json\|markdown>` | string | `toon` | Output format |
| `--strict` | boolean | false | Exit non-zero on any failure |
| `--output <file>` | string | — | Write the rendered output to a file |

---

### `pm ops verify-release`

Run the release gate matrix per repo: executes `npm run release:check` (or the individual `typecheck` / `build` / `test` / `audit:prod` / `pack:dry-run` / `changelog:check` steps when `release:check` is missing) and reports pass/fail with per-step timing. **Does NOT publish.** Exits non-zero if any repo fails.

```bash
pm ops verify-release
pm ops verify-release --repos ./pm-csv ./pm-github
pm ops verify-release --json
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths to verify |
| `--json` | boolean | false | Emit clean JSON to stdout |
| `--format <toon\|json\|markdown>` | string | `toon` | Output format |
| `--output <file>` | string | — | Write the rendered output to a file instead of stdout |

---

### Release completeness and explicit repair

```bash
npm run verify:release-completeness
npm run verify:release-completeness -- --repair
```

The default audits the git tag, published npm version, and GitHub Release inventories without writes. The daily release job explicitly opts into repair after its current release step, including days with no new release. Repair is outside `release:check` and `prepublishOnly`.

Repair completes missing remote tags and GitHub Releases only for already published calendar versions. It uses `npm audit signatures --json --include-attestations` in a disposable installation with lifecycle scripts disabled, requiring one verified SLSA v1 source repository and full commit. The signed workflow source must be an ancestor of the tag commit, which must match npm `gitHead`. Every published file, mode and the complete package file set must match a script-disabled pack of that tag tree, and the downloaded tarball must retain its signed SHA-512 integrity. A workflow can attest its trigger before committing release metadata; ancestry alone never proves the published bytes. The package name, version, repository, local/remote tag commits, and committed `package.json` must agree. Release notes come from exactly one nonempty version section in that commit's `CHANGELOG.md`, never from the working tree. Both source and release commits must already be available locally; repair does not guess a commit or fetch arbitrary objects.

GitHub tag lookup returns typed `github_release_absent` evidence for HTTP 404 with an access-check remedy; other read failures remain failures. Handled API diagnostics are captured instead of leaking an unexplained stderr line.

All incomplete candidates are validated before the first write. Missing provenance, unsupported provenance schemas, unreadable inventories, unpublished tags, conflicting commits or identities, and absent/ambiguous changelog sections refuse repair. Existing complete remote triples require no provenance read or write. Remote tags and release existence are checked again before writes; uncertain write responses are accepted only after the intended state can be read back. Failures after a successful write remain visible and can be retried. Repair never publishes to npm, moves a tag, edits an existing release, changes the latest-release designation, or changes branch history. Concurrent actors must preserve immutable release refs; the GitHub API cannot atomically bind release creation to a tag SHA.

The adapter needs git, gh authentication with repository contents write permission, and an npm CLI supporting `--include-attestations`. npm downloads and signature verification can fail without authorizing a repair. Applications may import `pm-ops/release-repair` to supply an injected `RepairClient` and `CompletenessFetcher`; hermetic tests use recorded npm response fixtures and local git remotes with real scratch pm trackers.

---

### `pm ops report`

Emit a concise fleet report combining scan + policy results (and optionally verify-release). The markdown format includes a timestamp header and sectioned tables.

```bash
pm ops report
pm ops report --repos ./pm-csv ./pm-github --format markdown
pm ops report --format markdown --output FLEET.md
pm ops report --format markdown --include-release --output FLEET.md
pm ops report --json
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths to report on |
| `--json` | boolean | false | Emit clean JSON to stdout |
| `--format <toon\|json\|markdown>` | string | `toon` | Output format |
| `--output <file>` | string | — | Write the report to a file instead of stdout |
| `--include-release` | boolean | false | Also run verify-release and include results |

---

### `pm ops status`

Quick fleet status overview — faster than `scan` because it skips GitHub PR/issue probes. For each repo shows name, version, ready/not-ready, open pm items, outdated deps, and critical/high vulnerabilities, plus a concise list of issues.

```bash
pm ops status
pm ops status --repos ./pm-csv ./pm-github
pm ops status --format markdown
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths |
| `--json` | boolean | false | Emit clean JSON to stdout |
| `--format <toon\|json\|markdown>` | string | `toon` | Output format |
| `--output <file>` | string | — | Write the rendered output to a file |

---

### `pm ops outdated`

Check outdated dependencies across repos. Runs `npm outdated --json` per repo and summarizes packages with newer versions available.

```bash
pm ops outdated
pm ops outdated --repos ./pm-csv ./pm-github
pm ops outdated --format markdown
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths |
| `--json` | boolean | false | Emit clean JSON to stdout |
| `--format <toon\|json\|markdown>` | string | `toon` | Output format |
| `--output <file>` | string | — | Write the rendered output to a file |

---

### `pm ops audit`

Security vulnerability audit across repos. Runs `npm audit --omit=dev --json` per repo and summarizes critical/high/moderate/low counts.

```bash
pm ops audit
pm ops audit --repos ./pm-csv ./pm-github
pm ops audit --format markdown
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths |
| `--json` | boolean | false | Emit clean JSON to stdout |
| `--format <toon\|json\|markdown>` | string | `toon` | Output format |
| `--output <file>` | string | — | Write the rendered output to a file |

---

### `pm ops metrics`

Export pm workspace health as **Prometheus** text-format gauges so a Prometheus/Grafana stack can scrape fleet project-management signals — turning `project management = context management` into a dashboard. Reads each repo's items via the canonical pm CLI forms (`pm list --all`, `pm list --status blocked`) and derives counts, throughput, and cycle-time in-process (the same `closed_at` methodology `pm-brief` momentum uses).

Every pm item-list read explicitly uses `--output-include full`, `--output-budget unbounded`, and `--output-limit unbounded` and is accepted only when the CLI's pagination, completeness, omission, and row-count receipts all prove that every item was returned. If any signal disagrees, pm-ops marks that repository as unavailable (`pm_workspace_available 0`) instead of publishing plausible but incomplete throughput, cycle-time, status-count, or blocked-item data.

```bash
pm ops metrics                                   # Prometheus exposition for the current repo
pm ops metrics --repos ~/container/pm-*           # fleet-wide, one series set per repo
pm ops metrics --output /var/lib/node_exporter/pm.prom   # node_exporter textfile collector
pm ops metrics --stale-days 7 --format json       # structured payload instead of exposition
```

**Exported metrics** (all gauges, labelled by `repo`):

| Metric | Labels | Meaning |
|---|---|---|
| `pm_items` | `status` | Item count by lifecycle status |
| `pm_active_items_by_type` | `type` | Active (non-closed/canceled/draft) items by type |
| `pm_active_items_by_priority` | `priority` | Active items by priority (`0`..`4`, or `none`) |
| `pm_blocked_items` | — | Open items blocked by unresolved dependencies (`pm list --status blocked`) |
| `pm_stale_items` | — | Active items not updated within `--stale-days` (default 14) |
| `pm_throughput_items` | `window` (`7d`,`30d`) | Items closed within the trailing window |
| `pm_cycle_time_seconds` | `quantile` (`0.5`,`0.9`) | `closed_at − created_at` of closed items |
| `pm_backlog_age_seconds` | `quantile` (`0.5`,`0.9`) | `now − created_at` of active items |
| `pm_workspace_available` | — | `1` if the repo exposed a readable pm workspace, else `0` |
| `pm_repos_scanned` | — | Number of repos with a readable pm workspace |
| `pm_scrape_duration_seconds` | — | Collection time for this scrape |

Fleet totals are intentionally **not** pre-aggregated — expose per-repo series and let Prometheus roll them up (`sum(pm_items{status="open"})`, `avg(pm_cycle_time_seconds{quantile="0.5"})`).

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repos <paths>` | string[] | current dir | Repo paths |
| `--stale-days <days>` | number | `14` | Age after which an active item counts as stale |
| `--json` | boolean | false | Emit the structured JSON payload instead of exposition |
| `--format <prometheus\|json\|toon>` | string | `prometheus` | Output format |
| `--output <file>` | string | — | Write output to a file (e.g. a node_exporter `.prom` textfile) |

> This command is **read-only** and derives metrics purely from pm item state. It does not touch, and is distinct from, the ecosystem's core telemetry/observability stack.

---

## Agent usage

`pm-ops` is designed for coding agents operating across a fleet of `pm-*` repos:

- **Deterministic JSON.** Every command supports `--json` for strict parsing; human-readable progress goes to stderr so stdout stays clean.
- **Stable ordering.** Repo results are emitted in the order passed on `--repos`.
- **Failure diagnostics.** `verify-release` writes the full per-check matrix to stdout _then_ throws a non-zero exit on failure, so agents get both the diagnostics and the exit code.
- **Offline mode.** Set `PM_OPS_OFFLINE=1` to skip `npm outdated` / `npm audit` / `gh` calls (useful in air-gapped CI); file-based checks still run.
- **No shell injection.** All subprocess calls (`pm`, `npm`, `gh`) pass args as arrays via `spawnSync` — never through a shell.
- **Small runtime surface.** The extension keeps only its main command dependencies in `dependencies`; optional lint and duplication tooling is supplied by consumers that use those exports.

### Output formats

- **toon** (default) — compact, host-rendered TOON of the structured result; easy to read in a terminal.
- **json** — `JSON.stringify(result, null, 2)`; the same object shape for every command.
- **markdown** — GitHub-flavoured tables suitable for pasting into PRs, issues, or a `FLEET.md`.

### Result shapes

`scan` → `{ repos: RepoScan[], summary: { total, ready, not_ready } }`
`policy` → `{ repos: RepoPolicy[], summary: { total, passed, failed, by_severity } }`
`verify-release` → `{ repos: RepoRelease[], summary: { total, passed, failed } }`
`report` → `{ generated_at, scan: ScanResult, policy: PolicyResult, release?: VerifyReleaseResult }`
`status` → `{ repos: RepoStatus[], summary: { total, ready, not_ready, total_issues } }`
`outdated` → `{ repos: RepoOutdated[], summary: { total, repos_with_outdated, total_outdated } }`
`audit` → `{ repos: RepoAudit[], summary: { total, clean, with_vulns, total_critical, total_high } }`

---

## Canonical merge-driver install (`pm-ops/merge-driver`)

Git never clones `.git/config`, so every fleet package has to run `pm merge install` from its
npm `prepare` script or concurrent agents conflict on tracker files. This package is the one
canonical implementation.

Consumers copy the frozen v1 [`templates/prepare-merge-driver.ts`](templates/prepare-merge-driver.ts)
unchanged **once** to `scripts/prepare-merge-driver.ts` and set `"prepare": "node scripts/prepare-merge-driver.ts"`. The
template skips `npm pack` and `npm publish` before resolving the installer, with one notice,
so artifact creation preserves clone-local Git configuration. `npm install`, `npm ci`,
and direct invocation still register drivers. The template imports **nothing** from pm-ops. pm-ops is a devDependency, so a checkout installed with
`npm install --omit=dev` (scripts enabled) does not have it, and a static
`import … from "pm-ops/merge-driver"` would fail at module load, before any fallback could run.
Dynamic `import()` is forbidden by the fleet lint gate. Instead the template resolves
`pm-ops/merge-driver/prepare` from the package root and runs it in a child process:

- **pm-ops not installed** (`--omit=dev`): exits `0` after exactly one notice line
- **pm-ops too old to export the entry, or its entry file missing**: fails the install loudly, and never skips
- **a broken install** (`node_modules/pm-ops` left as a directory without its `package.json`, or as a dangling link): fails the install loudly; resolution fails there with the same `MODULE_NOT_FOUND` an omit-dev install produces, so the template also looks for that entry before skipping
- **an unreadable or malformed lookup path**: fails with the original installer resolution error, because a failed presence probe cannot establish absence. The probe retains Node's global lookup paths (including `NODE_PATH`), matching the installer resolution above rather than treating an absent local package as proof of absence everywhere
- **pm-ops installed**: runs `runPrepareMergeDriver` (below) and propagates its exit status

The template is a frozen dependency-free bootstrap; driver installation behavior lives in the
package, behind `pm-ops/merge-driver/prepare`. Its recorded SHA-256 in `launcher-check.ts` is
locked by a test. Editing it requires an explicit launcher version decision and retaining the
previous hash. Routine pm-ops updates must change package behavior rather than these copied bytes.

Consumer tests should use the exported assertion instead of byte-comparing their copy with the
installed template:

```ts
import { assertCanonicalLauncher } from "pm-ops/launcher-check";

// Inside the consumer's existing test:
assertCanonicalLauncher("scripts/prepare-merge-driver.ts");
```

`assertCanonicalLauncher(filePath)` returns normally for the frozen template and every previously
released template revision, and throws for edited/unrecognized content or unreadable files.
The allowlist is append-only. Existing copies pass after an automatic dependency bump without
being recopied; acceptance does not upgrade their historical behavior. Copy the frozen template
once to adopt the current bootstrap. Thereafter dependency updates bring package behavior updates
without consumer launcher edits. New consumers should always copy the frozen template.

Historical SHA-256 provenance is recorded with release tags and template commits in
`launcher-check.ts`; `test/fixtures/launchers/` contains the five distinct released byte sequences
through v2026.10.16. These text fixtures are assertion inputs, never executable launchers.

Fixture tests in `test/merge-driver-launcher.test.ts` execute the shipped template against each of
those consumer layouts with a stub `pm` on PATH. `test/pack-prepare.test.ts` also exercises real
npm install/ci, omit-dev, broken installs and actual Git driver registration in disposable repos.

`runPrepareMergeDriver` (also exported from `pm-ops/merge-driver`) resolves the real `pm` launcher on the supplied PATH/platform, then:

- **missing `pm`**: exits `0` and prints one notice line
- **present `pm` whose `pm merge install` fails**: non-zero exit with that command's output
- **Windows**: honours quoted PATH entries and PATHEXT shims, and sets `shell: true` only on `win32` so `.cmd` launchers run; the POSIX path is never faked

This repository's own `prepare` hook and exported executable entry apply the same artifact-time guard.
The local hook also keeps an `isMainInvocation` guard so the suite can import it. To (re)run manually: `npm run merge:install`.
## Canonical code-quality exports

The package publishes one strict ESLint flat-config factory and one
programmatic jscpd gate. Both are TypeScript-only and work with the fleet's
TypeScript 5 and TypeScript 7 consumers because parsing is supplied by Babel,
not typescript-eslint.

```ts
import { fleetEslintConfig } from "pm-ops/eslint";

export default fleetEslintConfig({ ignores: ["generated/**"] });
```

The lint launcher a consumer can add is:

```ts
import { runLintGate } from "pm-ops/eslint";
process.exitCode = await runLintGate();
```

`runLintGate` uses the canonical policy, prints stylish diagnostics to stderr, and
returns `0` or `1` for use as the process exit code.

The duplication export reads `package.json`, scans `**/*.{ts,tsx,mts,cts}` by
default (including root sources, `scripts/`, UI components, and tests, while
skipping `.d.ts` / `.d.mts` / `.d.cts` ambient declarations), reports every
clone pair with both file line ranges, and fails when the measured percentage
is above the configured threshold. jscpd 5 scans TS, TSX, MTS, and
CTS sources; the gate checks its source count with a one-token pass
and refuses an incomplete scan. `globs` and `minTokens` can be overridden for direct analysis;
the gate uses `minTokens: 50` when the field is omitted. Comma brace unions in
a configured glob are expanded with a single linear pass and left-to-right
order, and a glob whose brace expansion would produce more than 1024
alternatives is refused with a clear error, so a hostile configured glob
cannot slow the gate down or explode memory.

### Consumers

The quality exports use optional peer dependencies so installing `pm-ops` as a
`pm` extension does not download tooling that the extension surface does not
run. A repository importing `pm-ops/eslint` adds these exact `devDependencies`:
`@babel/eslint-parser`, `@babel/plugin-syntax-typescript`, and `eslint`. A
repository importing `pm-ops/duplication` adds `jscpd` 5.x (`>=5.0.0 <6.0.0`).
Source discovery uses Node’s built-in filesystem glob on Node >=22.18.0,
including dotfiles, excluding discovered symlinks and generated/declaration paths, and
returning sorted repository-relative paths. After upgrading, consumers delete
their `fast-glob` devDependency and refresh their lockfile. jscpd 4 is no longer
supported. A repository using both exports adds all four tooling packages,
using the version ranges shown in `package.json`.

```ts
import { analyzeDuplication, runDuplicationGate } from "pm-ops/duplication";

const report = await analyzeDuplication({ globs: ["src/**/*.{ts,tsx,mts,cts}", "test/**/*.{ts,tsx,mts,cts}"] });
await runDuplicationGate();
```

A consumer adds these package fields (the launcher paths may be named
otherwise, but must remain thin imports of the canonical exports):

```json
{
  "scripts": {
    "lint": "node scripts/lint.ts",
    "duplication": "node scripts/duplication-gate.ts",
    "release:check": "npm run lint && npm run duplication && ..."
  },
  "devDependencies": {
    "@babel/eslint-parser": "^8.0.5",
    "@babel/plugin-syntax-typescript": "^8.0.3",
    "eslint": "^10.10.0",
    "jscpd": ">=5.0.0 <6.0.0",
    "pm-ops": "<current pm-ops version>"
  },
  "duplicationGate": {
    "threshold": 0,
    "minTokens": 50
  }
}
```

The canonical ESLint factory enforces the eight forbidden syntax selectors
(`TSAnyKeyword`, `ImportExpression`, `TSImportType`, `TSParameterProperty`,
`TSEnumDeclaration`, `TSModuleDeclaration`, `TSImportEqualsDeclaration`, and
`TSExportAssignment`) plus the fleet's correctness rules. It ignores generated
and dependency output by default; pass `ignores` to add project-specific paths.

## Package coverage gate

Bun must be installed and available on `PATH` before running `npm test`,
`npm run coverage`, or `npm run release:check` locally. These scripts execute
real Bun verification; missing Bun is an error and the tests are never skipped.
Install Bun using its [official installation instructions](https://bun.sh/docs/installation).
Repository CI installs Bun before running these gates.

`npm run coverage` discovers this repository's executable `.ts` files from
`coverageGate.sources`, including operational scripts and the launcher template.
Overlapping roots form a sorted, unique file set, which supplies both the c8
include arguments and the report-presence check. Tests, dependencies, build
output and declaration files are outside the runtime denominator. Thresholds
remain 100% statements, branches, functions and lines for every measured file.
Every invocation uses its own `coverage/run-*` report and counter directory,
so concurrent or nested gates preserve one another's data. After validation,
it atomically publishes `coverage/lcov.info` and removes its temporary directory.
Starting or failing a run invalidates that shared report, so assurance consumers
cannot treat an earlier pass as current after a failed test. Concurrent runs
judge their own fresh reports and preserve peer counters; a failed completion
leaves the shared report unavailable until another success publishes one.

The gate's controlled runner fixtures derive their reports from the include
arguments, so adding a module requires no fixture-list edits. A separate real
c8 fixture tests a newly imported module and then adds an unimported module:
the latter must fail at the unchanged thresholds and name the missing module.
Controlled fixture reports are never used as package coverage evidence.

## License

MIT © unbrained

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script
(`scripts/prepare-merge-driver.ts`, a thin launcher over [`pm-ops/merge-driver`](#canonical-merge-driver-install-pm-opsmerge-driver)). To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

### Publish indirection boundary

The canonical attestation auditor refuses executable shell aliases, unresolved publisher
subcommands and forwarded arguments. Input from `xargs` or `parallel` can append
`--provenance=false`, so a literal `--provenance` on the wrapper is insufficient.
Unresolved executable expansion and quoted executable variables with multiword
values are also refused.
Use direct `npm publish --provenance`, provable literal scalar/array bindings,
or functions containing a fully literal publish command. Ordinary npm reads,
non-publisher spawning commands and displayed shell text remain supported.
Parameter defaults, arithmetic operands and escaped nested backticks retain
their executable children. Substitutions and standalone subshells are audited
with independent state before parent expansion: a child unset cannot erase a
parent flag, and a child cannot borrow parent or sibling provenance. Literal
bindings made in the child can prove its flags; inherited child references,
conditional array state, append and indexed mutations are conservatively
unresolved. Enumeration retains the existing depth cap and is not a complete
shell interpreter.
The auditor is conservative: it does not execute tracked scripts or prove general
shell programs safe. Alias use is refused even when an alias appears attested.

Dependency-installed publishers have a separate boundary: their internal publish
commands live outside tracked source. The auditor recognizes `semantic-release`,
`np`, `release-it`, `lerna publish` and `changeset publish`, including binary paths,
versioned package selectors, `@changesets/cli`, and `npx`, `pnpm dlx`, `bunx`,
`yarn dlx` and `npm exec` binary invocations. Each refusal names the wrapper,
repository-relative file and physical source line. A wrapper's `--provenance`,
configuration or environment does not certify what its dependency code publishes;
the audit never installs or executes that code. Use the sanctioned direct
`npm publish --provenance` path for certifiable publication.

Pure literal informational argv (`--help`, `-h`, `--version`, `-v`) passes.
`lerna run build` and `changeset version` are non-publish controls; their tracked
script bodies remain independently scanned. Dry-run and publish-disabling flags
are conservatively refused because plugin, lifecycle and dependency execution
remains outside this proof. The complete subcommand and diagnostic-location
boundary is documented in [the auditor docs](docs/canonical-publication-regressions.md#dependency-publish-wrappers).

`test/publish-indirection.test.ts` runs Bash and xargs against an inert publisher
to preserve actual shell semantics; `test/pack-prepare.test.ts` compares real Git
config bytes around npm pack and checks install/ci registration. Artifact-time
refusal does not bypass broken-package guards during installation.

## Backend capability assurance

`pm ops capabilities` audits the current tracker without changing it. Use
`pm ops capabilities --config docs/examples/backend-capabilities.json --json`
for the [example configuration](docs/examples/backend-capabilities.json).
The default audit uses the host-resolved tracker, including `--pm-path` and
`PM_PATH` selections, independently of the working directory.
The default output is compact TOON; `--json` returns the same typed matrix.
There are three rows per configured adapter, capped at 32 adapters in a config.
Reports contain public adapter labels, counts and remedies, with no item data,
connection strings, exception messages or local paths.

The audited SDK read contracts are `list` (complete, count-consistent, unique
nonempty item IDs), `get` (one deterministic list ID returned unchanged), and
`schema` (nonempty, unique type names). `checked` records the number of list
items, get probes or schema types actually checked. An empty or unavailable
list leaves get `unverified`; the diagnostic never creates a probe item.
This is read-contract assurance, not write, concurrency, recovery or native
SQL/MCP protocol certification. Directory reads use a disposable snapshot of
settings and registered item folders, containing SDK cache writes away from
the original tracker. Audit a stable read-only copy for reproducible results.
Symlinked inputs are refused. Snapshot cleanup restores directory permissions
before enumeration and attempts removal even after a permission error. Cleanup
errors do not replace the audit evidence.

| Status | Meaning |
| --- | --- |
| `supported` | Declared operation passed its invariant |
| `unsupported` | Adapter does not declare the operation; no call was made |
| `unavailable` | Connection, read permission or transport failed |
| `invariant_failed` | Read completed with invalid evidence, or unsafe snapshot input |
| `unverified` | No list ID is available to test get safely |

Each refusal has a stable `backend_<status>` code and a remedy. `ok` means
all **declared** operations verified; inspect `counts.unsupported` when requiring
full read coverage. The CLI returns the report even on failed probes, so agents
must inspect `ok` and the per-operation statuses.

For database and MCP backends, configure `kind`, `id`, `operations` and an
`endpoint` pointing to an operator-controlled **read-only HTTP bridge**. The
bridge translates the backend's SDK reads to the normalized contract below;
it is not a database DSN or a native MCP endpoint. The diagnostic sends GET
requests only, with a five-second timeout and redirects disabled. Keep bridge
credentials in its deployment; URL userinfo is rejected. Never configure a
GET endpoint with side effects.

```json
[{"id":"database","kind":"database","endpoint":"https://bridge.example/reads","operations":["list","get","schema"]}]
```

The bridge receives `?operation=list`, `?operation=get&id=<selected-id>` or
`?operation=schema` (existing query parameters are preserved), returning JSON:

```json
{"items":[{"id":"sample-1"}],"count":1,"complete":true}
{"id":"sample-1"}
{"types":["Task"]}
```

SDK consumers can supply their own database/MCP read ports without HTTP:

```ts
import { auditBackendCapabilities, type BackendReadAdapter } from "pm-ops/backend-capabilities";

// Bind side-effect-free reads only. Return the normalized contract above;
// throw BackendReadRefusal for known transport/integrity failures.
declare const adapters: readonly BackendReadAdapter[];
const matrix = await auditBackendCapabilities(adapters);
console.log(matrix.counts);
```

`auditConfiguredBackends` and `auditBackendConfigFile` expose the same directory
snapshot and HTTP bridge bindings used by the CLI. Config roots resolve relative
to the config file. Command/schema discovery in core, pm-web's database doctor,
and Cargo package readiness are separate checks.

## Without git

Evidence expiry, backend capability diagnostics, scan, policy, status, outdated, audit, metrics,
reports and docstring analysis work in plain directories. The capability and
evidence expiry paths never invoke Git. Release verification runs package-defined
scripts, which may
need Git; GitHub queries need their own credentials and network access. Configure
and validate those requirements separately.

## Operational evidence expiry

`pm ops evidence-expiry` checks whether retained health, coverage and recovery
claims still have reusable evidence. Core assurance owns the contracts and their
immutable verdicts; this policy attaches a maximum age, required core population
scope and captured package/backend identities to an exact assertion receipt.
It does not run health checks, measure coverage, perform restores or replace
pm-review's exact-head review gate.

```bash
pm ops evidence-expiry --policy docs/examples/evidence-policy.json --versions docs/examples/evidence-versions.json
pm ops evidence-expiry --policy docs/examples/evidence-policy.json --versions docs/examples/evidence-versions.json --now 2026-10-22T10:01:00.000Z --limit 20 --json
```

The [example policy](docs/examples/evidence-policy.json) binds three independent
claims. With matching accepted receipts, the [current versions](docs/examples/evidence-versions.json)
change `backend:directory` from `v1` to `v2`: tracker health needs revalidation;
coverage and recovery stay fresh. Changing `package:consumer` affects health and
coverage, while changing `backend:recovery` affects only the restore drill.
The examples contain illustrative receipt selectors: without those actual
recorded receipts, all three claims report `evidence_missing`.

Capture the `receipt` selector (`gate_id`, `tree_id`, `evaluated_at`,
`assertion_id`) from a core `pm assurance verdicts` result. Capture `versions`
**when accepting the evidence**, separately from the current version inventory.
Include every relevant package, backend, configuration revision or deployment
identity; omitted dependencies cannot trigger invalidation. Versions compare as
exact strings, including upgrades, downgrades and backend replacements. Use
public identity labels rather than endpoints or credentials. `scope` uses core
`all`, `active`, or `filter` with `measurement_id`. A scope label does not prove
that a measurement actually exercises a health check or restore: the consumer's
core contracts and evidence collection must establish that meaning.

A receipt must be durable, complete, unambiguous and non-dry-run, with a passing
named assertion, proven negative controls and a positive population. Other
assertions in its gate are judged independently. The required scope must match.
Evidence expires **at** `evaluated_at + max_age_seconds`; future evidence needs
revalidation. A missing current version, missing receipt or unreadable/unsealed
history remains `unavailable`, never fresh. The audit checks core record hashes
and refuses history changes during its read; this detects corruption, not a
malicious writer authorized to replace and reseal the entire tracker. It never
rewrites evidence or refreshes timestamps. Only the newest 1000 durable verdicts
are searched; collect new evidence if a receipt has fallen out of that window.

Default output is compact TOON; the host's `--json` selects JSON. `ok` is the
**authoritative diagnostic predicate**; like `ops capabilities`, a completed
diagnostic returns normally even when claims need attention. Malformed inputs
throw `EvidenceExpiryRefusal` with `code`, `remedy` and nonzero `exitCode`.
Counts cover every claim, actionable rows precede fresh rows, and `omitted`
reports rows beyond `--limit` (default 20, maximum 1000). Each row carries a typed
`code`, affected identity keys, expiration time and remedy; raw tracker content
and version values are excluded. Requirements use this precedence: availability,
acceptance, scope, missing versions, future time, changed versions, expiry.
Resolve the first refusal and rerun to reveal any remaining requirement.

```ts
import { auditEvidenceExpiry, evaluateEvidenceExpiry,
  parseEvidenceExpiryPolicy, parseEvidenceVersions } from "pm-ops/evidence-expiry";

const policy = parseEvidenceExpiryPolicy(policyJson);
const current = parseEvidenceVersions(currentVersionJson);
const report = await auditEvidenceExpiry(trackerRoot, policy, current);
// Database/MCP hosts can supply their own authenticated durable core receipts.
const remoteReport = evaluateEvidenceExpiry(policy, current, durableReceipts);
// Pass null if evidence cannot be read; an empty array means no matching receipts.
```

The SDK exposes typed policies, claims, reports, rows, statuses and refusal codes.
JSON readers validate 1-1000 unique claims, canonical UTC timestamps, positive
integer ages up to ten years, and at most 100 identities per version map. The
read-only directory audit uses core SDK history, assurance and integrity APIs;
backend-neutral evaluation performs no I/O and trusts the caller to authenticate
its supplied receipts. Neither entrypoint changes assurance declarations or
stores a second copy of the verdict history.

### Bounded diagnostic plans

`pm ops diagnose` turns **observed failure codes** into an ordered, reviewable
read-only plan. Pass the classifications found during your scan/report investigation;
it does not rerun scan or invent failures. Core `pm plan` remains the owner of stored
steps and approvals; this command adds bounded diagnostic execution, with no scheduler.

```bash
pm ops diagnose --failures items_unreadable,history_invalid --processes 2 --network 0 --time-ms 10000 --json > diagnostic-plan.json
# Review the commands, scope, budget and id in diagnostic-plan.json.
pm ops diagnose --plan diagnostic-plan.json --select <reviewed-id> --json
# Omit --json for compact native TOON.
```

Generation does not execute probes. Execution requires the exact reviewed id and
original canonical tracker directory. A changed budget, step, order or scope requires
a new plan and selection. Plans deduplicate observations into the following catalog
order, with versioned command identities retained in every receipt and repeat run:

| Observed failure | Command identity | Read performed | Network reservation |
| --- | --- | --- | --- |
| `schema_unreadable` | `sdk:schema:v1` | Core settings and registered schema type count | 0 |
| `items_unreadable` | `sdk:items:v1` | Registered source item files through the canonical SDK document reader | 0 |
| `history_invalid` | `sdk:history:v1` | Core per-item history snapshot and verification against each current document | 0 |
| `registry_unavailable` | `http:registry-head:v1` | One HEAD to `https://registry.npmjs.org/`, redirects refused | 1 |

Default ceilings are **3 child launches, 0 HTTP requests and 10000 ms total**.
Allowed ranges are processes 0–4, network 0–1 and time 1–60000 ms. Reservations
are charged before dispatch, including failed launches. Network units are logical
HTTP requests, not DNS packets or transport retransmissions. The shared monotonic
deadline includes process startup; each worker is killed at its remaining deadline.
Termination and cleanup can add a small amount to measured elapsed time after the
deadline; no further probe is dispatched. Each worker has a 128 MiB V8 heap limit and a 4 KiB output ceiling. No arbitrary
command, shell, endpoint, executable, environment options or extension hooks run.
After any exhausted ceiling, **all later probes remain skipped**, with their original
command identities and a typed remedy. Probe failures may continue within budget.

Receipts return only fixed command identities, counts, codes and remedies. Tracker
text, identifiers, paths, URLs from failures, credentials, child stderr and raw errors
are never included. A SHA-256 directory binding identifies scope without printing its
path; it is an identity binding, not an encryption or authentication mechanism. Settings and optional schemas hydrate only in a parent-owned disposable copy,
which is removed even when a worker times out. Source item files are read directly
without SDK cache writes. Malformed settings and schema warnings fail closed. Links and ambiguous item identities
are refused. Each probe observes the tracker when it runs; these diagnostics do not
assert a transactionally consistent snapshot across concurrent writers. History checks
cover item streams, not workspace assurance or recovery. Empty item populations return
zero checked and do not establish nonempty acceptance evidence.

The diagnostic predicate is `result.ok`: a completed report returns normally even
when a budget stops probes or a probe fails. Invalid inputs throw `DiagnosticRefusal`
with `code`, `remedy` and exit code 2 (`invalid_options`, `invalid_plan`,
`selection_required`, `scope_unavailable`, `scope_mismatch`). Files must be version 1
regular JSON review files no larger than 16 KiB. Input reading and scope resolution count against the execution deadline. FIFOs, sockets, devices and directories refuse before reading, even through symlinks; descriptor checks guard path replacement. Other package file inputs have a 16 MiB ceiling and return typed refusals with remedies. Execution flags cannot override a reviewed
artifact. Defaults produce at most four rows in native TOON or JSON.

The typed SDK exports `createDiagnosticPlan`, `parseDiagnosticPlan`,
`readDiagnosticPlan`, `executeDiagnosticPlan`, and `DiagnosticRefusal` from
`pm-ops/diagnostic-plans`. See [the SDK example](docs/diagnostic-plans.md).

Diagnostic generation and execution work **without git**, including when Git is
absent from PATH, for an ordinary directory tracker. They never invoke Git or mutate
the tracker. Public HTTP diagnostics require explicit network budget. Database and
MCP diagnostics remain the separate backend read-bridge capability command; directory
plans do not claim to execute against those backends.
