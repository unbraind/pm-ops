# Scheduled GitHub issue sync diagnosis, 2026-11-16

[Failed workflow run](https://github.com/unbraind/pm-ops/actions/runs/43828148726).

Observed failure:

```text
npm error Invalid: lock file's glob@13.0.6 does not satisfy glob@13.0.7
```

The scheduled job uses Node 22.18.0 and its bundled npm. The committed lock selected glob 13.0.6 although npm requires 13.0.7. The retained lockfile regeneration updates that package, resolved URL and integrity hash to 13.0.7. The sigstore override remains glob 14.0.2.

The original package manifest and lockfile, copied to a scratch directory, reproduce EUSAGE with Node 22.18.0. The repaired lock passes npm ci --ignore-scripts --dry-run on Node 22.18.0, 22.23.4 and 26.13.0, covering the exact scheduled runtime and the current 22/26 CI matrix. npm audit --omit=dev reports zero vulnerabilities.

## Import gate evidence

The exact pm-github 2026.11.15 preview fails closed before writes. Its privacy preflight reports two `absolute-host-path` findings for the proposed `github-recovery-plan` item, in `body` and `expected_result`. The offending content is not copied here. The earlier 18-planned/8-matched preview used an older ambient extension and is not evidence for the pinned workflow.

```text
pm github gate: FAIL before write (privacy preflight); no item or recovery plan was written.
```

The lockfile installation defect is repaired. End-to-end sync remains blocked by this separate privacy refusal. No allowlist, tracker weakening, or GitHub issue edit is applied.

For non-blocked importers the read-only command is:

```sh
pm github import unbraind/pm-ops --state all --atomic --gate --dry-run --with-comments --json
```

A passing plan proves completeness and identity planning, not successful writes or a new scheduled CI run. Shared reference tags remain references; new mirror items in a plan are not applied by this investigation.

## Validation

Typecheck and lint pass. The quick package suite is still running at the initial draft. `npm audit --omit=dev` reports zero vulnerabilities. Pinned `pm validate --json` exits 0 but returns `ok: false`: twelve pre-existing completeness violations remain outside this lockfile repair. The seeded tracker command passes through `pm test --run --progress`; that exit status does not override the validation findings. Remaining gate results are recorded in the linked sync repair item. CI is not dispatched manually, and no successful scheduled rerun is claimed.
