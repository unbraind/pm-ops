The committed TypeScript fixture freezes the complete pre-diagnostic Windows
proof from `b89fd6f36adf91c9bfc784c7ab643d9ce9cb7eae` and the original `execute`
and `run` functions from `ea29cb425a72b6729d24b00df4573e8c092c7cfa`, both from
PR #152 before its squash merge. Tests read these strings directly; they never
fetch those development commits.

The missing-history regression still uses an empty Git object store and compares
the old opaque failure with the current explicit refusal, without skipping any
control. Its historical availability guard now names main's squash commit
`3fca1f2561719bdbf062160b652be1cbe907c51b`, which is reachable from main and contains the
integrated proof sources. Full-history CI checkout provides that baseline.

Native Windows controls transplant only the frozen launcher functions, preserving
current consumer assertions and dependency pins. Each old function must fail the
real consumer scenario; source bytes are restored in `finally`. Actual npm 10
refusal remains independently exercised before packing.
