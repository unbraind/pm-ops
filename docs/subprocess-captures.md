# Subprocess capture contract

`subprocess.ts` is the shared capture boundary. Both sync adapters pass an explicit
finite `maxBuffer` to Node: 16 MiB by default, with existing 64 MiB metadata limits
and the diagnostic worker's 4096-byte limit preserved. Invalid limits and stdout
or stderr overflow produce `CaptureRefusal` (`output_limit`, exit code 2) with a
reduce, paginate or stream remedy. Partial output and raw child errors are never
retained by that refusal. Explicit pipe stdio prevents Node from echoing captured
stderr when a command throws.

The package capture inventory covers all root modules and gate scripts:

| Consumer | Transport and overflow result |
| --- | --- |
| `release-completeness.ts`, `release-repair.ts` | Shared bounded executor; repair refuses before writes |
| `release-caller.ts` | Shared bounded executor; overflow refuses without trying curl or approving bundled metadata |
| `attestation.ts`, changelog-date and lifecycle gate scripts | Shared bounded executor; existing 64 MiB ceilings retained |
| `index.ts` | Shared bounded spawn; capture refusal propagates to the caller |
| `duplication.ts` | Shared bounded spawn; refuses before parsing a partial scan report |
| `diagnostic-plans.ts` | Shared bounded spawn; typed `output_limit` receipt with remedy |
| `scripts/coverage-gate.ts` | Shared bounded spawn for compiler configuration; the test runner inherits stdio |

Tar members use `tar -xOf` with stdout connected directly to a temporary file
descriptor. Only stderr is captured. The member file and the tarball integrity
are hashed in 64 KiB chunks; member contents never enter a subprocess capture.
Temporary files stay inside the disposable comparison directory and are removed
on success and refusal. Member paths are validated before passing them to tar.

`merge-driver.ts`, `release-verification.ts`, the prepare template and the inline
production audit launcher inherit stdio, so they do not capture output. Executable test and acceptance drivers use the same bounded capture adapters.
The token-aware inventory test guards package modules, scripts, templates and
test drivers against raw capture calls. Archived source-only revert snapshots
remain unchanged. No subprocess buffer is made unbounded.

Regression commands:

```sh
node --test test/subprocess.test.ts test/release-repair.test.ts test/release-caller.test.ts test/diagnostic-plans.test.ts
```

The two real-tarball regressions use actual npm pack and tar binaries, a real
scratch tracker and Git repository, and matching or mismatching 5 MiB members.
Registry metadata and signature-audit evidence are synthetic; no live registry
mutation or release repair is performed.
