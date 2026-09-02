import { type ShellCommand, type SourceFile, type VerifierResult } from "./shell-scan.ts";
/** The flag that attaches a build attestation to the published tarball. */
export declare const ATTESTATION_FLAG = "--provenance";
/** Whether the auditor recognized any publish command at all. */
export type PublishRecognition = {
    readonly kind: "none";
} | {
    readonly kind: "recognized";
    readonly count: number;
};
/** Publish-attestation outcome with non-vacuity preserved as structured data. */
export interface PublishAttestationResult extends VerifierResult {
    /** Recognition cannot be inferred from an empty failure list. */
    readonly recognition: PublishRecognition;
}
/** One publish invocation found in a tracked file. */
export interface PublishInvocation {
    /** File the invocation was found in. */
    file: string;
    /** The program the invocation runs, reduced to its basename. */
    program: string;
    /** The invocation's tokens, quoting resolved. */
    command: ShellCommand;
}
/** Publishers other than npm, which this repository has no attested path for. */
export declare const FOREIGN_PUBLISHERS: Set<string>;
/**
 * Join manifest script bodies for legacy text consumers without continuations.
 *
 * The auditor itself analyzes each returned body in a fresh scope; this text
 * form remains for callers that need the earlier newline-joined contract.
 *
 * @param text - The manifest's contents.
 * @returns One sanitized line per script body, newline joined.
 */
export declare function manifestCommandLines(text: string): string;
/**
 * Decide whether one command is a direct `npm publish`.
 *
 * `publish` does not have to follow `npm` immediately: npm accepts its
 * configuration flags anywhere on the line, so `npm --access public publish` is
 * a real publish that an adjacency test discards silently, leaving an attested
 * sibling elsewhere in the file to carry the audit to a pass.
 *
 * Reading the first non-flag word as the subcommand does not work either,
 * because npm has flags that take a separate value (`--access public`) and
 * flags that do not (`--ignore-scripts`), and telling them apart needs npm's
 * own option table. So the word is looked for anywhere in the arguments, and
 * only a preceding runner subcommand rules it out -- `npm run publish` runs a
 * package script whose body is scanned from the manifest, and requiring the
 * flag on the runner would report a defect that is not there.
 *
 * The residual imprecision is `npm --tag publish ...`, a dist-tag named after
 * the subcommand, which this reads as a publish. That direction is deliberate:
 * a false positive is a report line to argue with, a false negative is an
 * unattested artifact on the registry.
 *
 * The program is checked in command position by the caller, so `echo npm
 * publish` and `notnpm publish` never reach here.
 *
 * @param command - One simple command's tokens.
 * @returns True when the command publishes.
 */
export declare function isPublishCommand(command: ShellCommand): boolean;
/**
 * Decide whether one publish command actually enables the attestation.
 *
 * A substring test is not enough. `--provenance=false`, `--provenance false` and
 * `--no-provenance` all contain the flag's spelling and all turn the
 * attestation off, so a containment check accepts precisely the regression this
 * gate exists to catch -- while reporting the file as attested. `--provenance-file`
 * is a different flag entirely and must not be read as this one.
 *
 * Tokens are judged in order and the last one wins, which is how npm resolves a
 * flag given more than once: `--provenance --no-provenance` publishes without an
 * attestation, so this must answer false for it.
 *
 * Quoting is irrelevant to the shell and so is irrelevant here: `npm publish
 * "--provenance"` is attested, and the scan this replaces read it as bare.
 *
 * @param command - One simple command's tokens.
 * @returns True when the command publishes with an attestation.
 */
export declare function attestationEnabled(command: ShellCommand): boolean;
/**
 * Find every publish invocation in one source, isolating package scripts.
 *
 * npm launches every manifest script in a fresh shell, so scalar evidence from
 * one body can never attest a publish in another body. A workflow file's `run:`
 * blocks are dedented first — before {@link joinContinuations} and heredoc
 * detection — because that is what happens to them before bash sees the text:
 * YAML strips the block indentation when it delivers the value. The order
 * matters: `dedentRunBlocks` reads the raw YAML line structure to find block
 * headers and strip their indentation, and `joinContinuations` would merge a
 * `run:` header with the next line when a backslash continuation sits between
 * them, destroying the header the dedent needs to see. Heredoc detection runs
 * after both, because a heredoc terminator must match at the start of the line
 * bash receives — which is the dedented, continuation-joined text. The one
 * scanner rule that is whitespace-sensitive is the heredoc terminator, so
 * dedenting before that rule runs is what makes a `run: |2` block's heredoc
 * terminator match instead of swallowing the rest of the file.
 *
 * @param source - The file's path and contents.
 * @returns The publish invocations found, in file and script order.
 */
export declare function publishInvocationsIn(source: SourceFile): PublishInvocation[];
/**
 * Render an invocation back to a readable command for a report line.
 *
 * @param command - The invocation's tokens.
 * @returns The command as a single space-separated string.
 */
export declare function renderCommand(command: ShellCommand): string;
/**
 * Audit every publish invocation across the given files.
 *
 * An absent invocation is a failure rather than a pass: a scan that finds
 * nothing has either been pointed at the wrong files or outlived the workflow
 * it guards, and both look identical to a clean result unless said out loud.
 *
 * A publisher other than npm fails outright rather than being checked for a
 * flag. This repository's attested path is npm's `--provenance`; no equivalent
 * is configured for yarn, pnpm or bun, so such an invocation is an unattested
 * publish path regardless of the flags it carries, and guessing at another
 * tool's spelling would be a gate that only looked strict.
 *
 * @param sources - The tracked files to scan.
 * @returns Failures and per-file notes.
 */
export declare function auditPublishAttestation(sources: SourceFile[]): PublishAttestationResult;
/**
 * Decide whether a tracked path can run a command.
 *
 * The previous enumeration named two paths -- `.github/workflows` and
 * `package.json` -- which meant a publish added to any tracked script was never
 * audited, and because the workflow's own attested publish satisfied the
 * non-vacuity check the gate still reported that every invocation was attested.
 * Auditing every shape that can execute closes that, and a shebang is honoured
 * so an extensionless tracked script is not a blind spot either.
 *
 * Build output is excluded. `dist/` is generated from sources this scan already
 * reads, it is regenerated and compared byte-for-byte on the release path, and
 * including it would audit a bundled copy of a command rather than the command.
 *
 * @param path - Repository-relative path.
 * @param firstLine - The file's first line, for shebang detection.
 * @returns True when the file should be scanned.
 */
export declare function isExecutableSource(path: string, firstLine: string): boolean;
/**
 * List the tracked files that can run a publish.
 *
 * Git is asked rather than the filesystem walked, so an untracked scratch copy
 * of a workflow cannot satisfy or fail the gate. `-z` is used because a tracked
 * path may legally contain a newline, and splitting such a listing on newlines
 * invents two paths that do not exist and drops the one that does.
 *
 * @param root - Repository root.
 * @returns Repository-relative paths of every tracked file that can execute.
 */
export declare function trackedPublishSources(root: string): string[];
/**
 * Read the tracked sources and audit them.
 *
 * @param root - Repository root to verify.
 * @returns Failures and notes for the whole repository.
 */
export declare function verify(root: string): PublishAttestationResult;
/**
 * Print a result and set a failing exit code when it failed.
 *
 * @param result - The audit outcome.
 * @param write - Sink for the report lines.
 * @param exit - Called with the process exit code when there were failures.
 */
export declare function report(result: VerifierResult, write: (line: string) => void, exit: (code: number) => void): void;
//# sourceMappingURL=attestation.d.ts.map