# Release-repair artifact comparison

Repair verifies the signed registry integrity first. It then constructs exactly
one canonical manifest from each complete tarball, independently of npm's JSON
file listing. Only byte-identical manifest serializations match.

Each record contains, in fixed order:

- Normalized path, including the `package` root.
- Entry type: regular file or directory.
- Mode, including permission and special bits.
- Exact content size.
- Link target (necessarily empty for permitted entries).
- SHA-512 of the entire streamed content (the empty hash for empty files and directories).

Records sort by UTF-8 path bytes. Paths normalize redundant `/` and `.` segments.
The verifier refuses `..`, absolute paths, backslashes, NULs, entries outside
`package`, duplicate normalized paths, file/directory ancestor conflicts, and
case or Unicode normalization collisions, including ancestor spellings. Its
regular-file paths also refuse terminal `/` and `/.` directory aliases. The
conservative collision key uses NFKC, uppercase, lowercase, then NFKC; accepted
paths retain their original Unicode spelling in the manifest.

Only USTAR regular-file flags `0` and NUL, directories `5`, and bounded local
PAX metadata `x` are understood. PAX is a transport record describing the next
filesystem entry. Symlinks, hardlinks, character/block devices, FIFOs,
contiguous files, GNU extensions, global PAX overrides, and unknown entry kinds
raise `TarballRefusal` (`code: invalid_tarball`, `exitCode: 2`). Unknown PAX
attributes, repeated attributes, malformed framing, bad checksums, invalid
UTF-8, truncated bodies, and nonzero data after the end marker also refuse.
USTAR version must be `00` and device numbers must be zero, including for
otherwise permitted entries.
Local PAX metadata is limited to 1 MiB. This deliberately conservative archive
subset can refuse non-npm archives rather than guess at their semantics.

The complete ignored filesystem metadata list is `mtime`, `atime`, `ctime`,
`uid`, `gid`, `uname`, and `gname`: npm packaging rewrites timestamps and owner
identity. The only accepted PAX attributes besides those ignored fields are
`path`, `size`, and `linkpath`; these affect the manifest and validation.
Compression bytes, record order, USTAR versus local-PAX field representation,
header checksums and alignment/terminal padding are transport details, not
filesystem properties. Checksums and archive termination are validated.

Decompression streams through a file descriptor into private scratch storage;
the parser reads content in 64 KiB chunks. It never extracts registry members,
passes member names to tar, or captures member contents in command output.
Scratch artifacts are removed after both success and refusal. The source tree
is still materialized only from the independently verified Git commit.

The deterministic corpus exercises 32 seeds across type swaps, link targets,
modes, extra/missing entries, duplicates, traversal, case/Unicode collisions,
equal-size byte changes, and empty versus missing files. It also covers
directory records, ancestor conflicts, malformed headers and PAX overrides.
Four additional seeds run all ten required mutation classes through real npm
packing and the production repair adapter, with matching pairs accepted and
every changed pair refused. No tar command is mocked. Real 5 MiB member tests
retain the streaming and source-symlink sentinel checks.
