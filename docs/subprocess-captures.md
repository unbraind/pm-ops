# Subprocess capture contract

`subprocess.ts` is the shared capture boundary. Both sync adapters pass an explicit
finite `maxBuffer` to Node: 16 MiB by default, with existing 64 MiB metadata limits
and the diagnostic worker's 4096-byte limit preserved. Invalid limits and stdout
or stderr overflow produce `CaptureRefusal` (`output_limit`, exit code 2) with a
reduce, paginate or stream remedy. Partial output and raw child errors are never
retained by that refusal. Explicit pipe stdio prevents Node from echoing captured
stderr when a command throws.

Both adapters execute the executable and argument array directly. Truthy caller
`shell` options (including shell paths) throw `ShellRefusal` (`shell_not_allowed`,
exit code 2) before Node is called, with the remedy to pass the executable and an
argument array. Both overloads remove `shell` from forwarded options and force
`shell: false` after spreading the remaining caller options, so an option getter
cannot enable a shell. The refusal never retains executable names, arguments or
shell paths.

Bash execution fixtures write their owned scripts to private temporary files via
`test/bash-fixture.ts`, execute those files through the bounded adapter, and clean
them up on success and refusal. Script text is kept out of executable argument
arrays; tests still run real Bash with inert publisher and network boundaries.

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

Release repair hashes each complete compressed tarball in 64 KiB chunks and
checks its SHA-512 integrity. A Node subprocess streams `createGunzip()` output
through stdout directly to a private scratch file descriptor; only stderr is
captured. `canonicalTarManifest()` then reads the uncompressed archive and hashes
member contents in 64 KiB chunks. Registry members are never extracted, passed
as tar arguments, or captured in command output. Scratch files are removed on
success and refusal. The separate `git archive` / `tar -xf` step materializes
only the independently verified Git commit for a script-disabled npm pack.

Each canonical manifest record binds the normalized `package`-root path, entry
type (`file` or `directory`), mode including special bits, exact size, link target
(empty for permitted entries), and SHA-512 content hash. Records sort by UTF-8
path bytes; the complete serialized manifests must match. Ownership and timestamp
fields rewritten by npm are ignored; compression and record order are transport
details. See [the archive comparison policy](tarball-manifests.md) for the exact
ignored fields, normalization rules and supported archive formats.

Only USTAR regular files (`0` or NUL), directories (`5`), and local PAX metadata
(`x`, limited to 1 MiB and describing the next entry) are supported. Symlinks,
hardlinks, devices, FIFOs, contiguous files, GNU extensions, global PAX overrides
and unknown entry kinds refuse repair. Unsafe paths, duplicate or colliding
names, conflicting file ancestors and malformed archive framing also refuse.

Troubleshoot the refusal classification before retrying:

| Refusal | Cause and remedy |
| --- | --- |
| `TarballRefusal`, `code: invalid_tarball`, `reason: entry_type` | Unsupported entry kind. Supply an unambiguous package archive containing only regular files and directories in the supported USTAR/local-PAX subset. |
| `TarballRefusal`, `code: invalid_tarball`, `reason: path` | Traversal, absolute/backslash/NUL paths, entries outside `package`, or regular-file directory aliases. Correct the package layout to use safe package-root paths. |
| `TarballRefusal`, `code: invalid_tarball`, `reason: collision` | Duplicate normalized paths, case/Unicode collisions (including ancestors), or file/directory ancestor conflicts. Remove duplicate entries and ambiguous names. |
| `TarballRefusal`, `code: invalid_tarball`, `reason: format` | Invalid checksums, UTF-8, sizes, headers, PAX attributes/framing/limits, link fields, or archive termination. Obtain a complete, valid archive in the supported format; nonzero trailing data also refuses. |
| `CaptureRefusal`, `code: output_limit` | Invalid capture limit or captured metadata/stderr overflow. Use a positive finite safe-integer limit; reduce or paginate output below the bound, or stream bulk data to a file. Member size alone does not consume the capture budget. |
| `ShellRefusal`, `code: shell_not_allowed` | A caller requested shell interpretation. Pass the executable and an argument array. |

These typed refusals all carry `exitCode: 2`; `TarballRefusal` includes its generic
remedy in the message, while the capture and shell refusals also expose a
`remedy` property. Archive reasons omit member names. Integrity or manifest
inequality raises an ordinary error instead; inspect the signed artifact and
release tree rather than treating that mismatch as an `invalid_tarball` code.
The top-level repair adapter reports failures as `release repair refused: ...`
and completes verification before any tag or GitHub Release writes.

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
