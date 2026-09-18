/**
 * Shared per-file aggregation for invocation-based release audits.
 *
 * The attestation and changelog gates inspect different commands, but both need
 * the same non-vacuous accounting: every invocation contributes to a file's
 * total, each defect is reported in encounter order, an empty scan fails, and
 * a note is emitted only for files whose invocations are all clean. Keeping
 * that contract here prevents the two audits from drifting into cosmetic
 * variants that evade the duplication gate instead of removing duplicated
 * behavior.
 *
 * @packageDocumentation
 */
/**
 * Tally invocation defects per file and render the shared audit diagnostics.
 *
 * @typeParam T - Invocation shape, which must identify its source file.
 * @param invocations - Invocations in the order the scanner found them.
 * @param defectOf - Returns the byte-exact defect message, or `null` when clean.
 * @param labels - Noun, required flag, and fail-closed empty-scan message.
 * @returns Ordered failures and per-file success notes.
 */
export function tallyFlaggedInvocations(invocations, defectOf, labels) {
    const failures = [];
    const counted = new Map();
    for (const invocation of invocations) {
        const tally = counted.get(invocation.file) ?? { total: 0, unflagged: 0 };
        tally.total += 1;
        const defect = defectOf(invocation);
        if (defect !== null) {
            tally.unflagged += 1;
            failures.push(defect);
        }
        counted.set(invocation.file, tally);
    }
    if (invocations.length === 0) {
        failures.push(labels.emptyScan);
    }
    const notes = [];
    for (const [file, tally] of counted) {
        if (tally.unflagged > 0)
            continue;
        notes.push(`ok - ${file}: ${tally.total} ${labels.noun} invocation(s), each carrying ${labels.flag}`);
    }
    return { failures, notes };
}
//# sourceMappingURL=invocation-audit.js.map