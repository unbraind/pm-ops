# pm-ops

Multi-repo fleet operations for [pm-cli](https://github.com/unbraind/pm-cli).

`pm-ops` gives coding agents one command surface for operating across **many** `pm-*` repositories: audit release readiness, enforce naming/workflow policies, run a release-gate matrix, and emit concise fleet reports. Zero external runtime dependencies — Node built-ins only.

> Philosophy: _project management = context management_, applied to a **fleet** of repos.

---

## Installation

```bash
pm install github.com/unbrained/pm-ops --project
```

Or install globally:

```bash
pm install github.com/unbrained/pm-ops --global
```

---

## Commands

### `pm ops scan`

Scan a set of repos and produce a per-repo release-readiness snapshot.

```
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
- `pm-changelog` wired into devDependencies
- `npm outdated` count
- `npm audit --omit=dev` critical/high counts
- open PRs/issues via `gh` (when the repo is a GitHub repo)

A repo is `ready` when it has a package.json, strict TS, a changelog, both CI/release workflows, pm-changelog wired, and zero critical audit vulnerabilities.

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
- **required-scripts** — `package.json` has `typecheck`, `test`, `build`, `release:check`, `changelog`, `changelog:check`
- **required-workflows** — `ci.yml` + `release.yml` present
- **private-no-runners** — private repos must NOT use `runs-on: github-hosted` / `macos-` / `windows-` / `ubuntu-` (skipped for public repos)
- **pm-duplicate-titles** — no two OPEN pm items share the same title
- **pm-changelog-wired** — `pm-changelog` in devDeps AND a `changelog` script exists

```
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

```
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

### `pm ops report`

Emit a concise fleet report combining scan + policy results (and optionally verify-release). The markdown format includes a timestamp header and sectioned tables.

```
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

```
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

```
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

```
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

## Agent usage

`pm-ops` is designed for coding agents operating across a fleet of `pm-*` repos:

- **Deterministic JSON.** Every command supports `--json` for strict parsing; human-readable progress goes to stderr so stdout stays clean.
- **Stable ordering.** Repo results are emitted in the order passed on `--repos`.
- **Failure diagnostics.** `verify-release` writes the full per-check matrix to stdout _then_ throws a non-zero exit on failure, so agents get both the diagnostics and the exit code.
- **Offline mode.** Set `PM_OPS_OFFLINE=1` to skip `npm outdated` / `npm audit` / `gh` calls (useful in air-gapped CI); file-based checks still run.
- **No shell injection.** All subprocess calls (`pm`, `npm`, `gh`) pass args as arrays via `spawnSync` — never through a shell.
- **Zero runtime deps.** Only Node built-ins, so the package installs fast and audits clean.

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

## License

MIT © unbrained
