/** Pure release planning shared by the reusable workflow and its regression suite. */
import { tokenize } from "./docstrings.js";
/** Normalize a release calendar day for daily comparisons, intentionally discarding any -N suffix. */
export function releaseVersion(date) {
    return date.replace(/^v/, "").split("-")[0].split(".").map(Number).join(".");
}
/** Select the newest numeric release date regardless of zero padding or tag creation order. */
export function latestReleaseTag(tags) {
    return [...tags].sort((a, b) => releaseVersion(b).localeCompare(releaseVersion(a), "en", { numeric: true })
        || b.localeCompare(a, "en", { numeric: true }))[0] ?? "";
}
/** Only same-repository, GITHUB_TOKEN-authored date branches may be rewritten or closed. */
export function ownsReleasePullRequest(pr) {
    return pr.isCrossRepository === false
        && pr.author?.login === "app/github-actions"
        && /^release\/\d{4}\.\d{1,2}\.\d{1,2}$/.test(pr.headRefName);
}
/** Select the newest numeric date, then the highest PR number, independent of API ordering. */
export function selectReleasePullRequests(prs) {
    return prs.filter(ownsReleasePullRequest).sort((a, b) => {
        const left = a.headRefName.slice(8).split(".").map(Number);
        const right = b.headRefName.slice(8).split(".").map(Number);
        return right[0] - left[0] || right[1] - left[1] || right[2] - left[2] || b.number - a.number;
    });
}
/** Block a second release today and skip unchanged trees; otherwise rebuild a protected PR from main. */
export function decideDailyRelease(input) {
    const candidates = selectReleasePullRequests(input.existingPrs);
    const existingPr = candidates[0];
    const version = input.packageVersion ?? releaseVersion(input.today);
    const releasedToday = input.publishedToday === true || input.releaseTags.some(tag => releaseVersion(tag) === releaseVersion(input.today));
    const versionExists = input.releaseTags.some(tag => releaseVersion(tag) === version);
    const shouldRelease = !releasedToday && !versionExists && input.hasChanges && input.lastRelease?.sha !== input.mainSha;
    return {
        should_release: shouldRelease,
        recovery_tag: !shouldRelease && input.lastRelease?.sha === input.mainSha ? input.lastRelease.tag : "",
        action: !shouldRelease ? "skip" : existingPr ? "refresh" : "create",
        tag: `v${input.packageVersion ?? input.today}`,
        npm_version: version,
        base_sha: input.mainSha,
        release_branch: existingPr?.headRefName ?? `release/${input.today}`,
        pr_number: existingPr?.number ?? "",
        superseded_pr_numbers: candidates.slice(1).map(pr => pr.number).join(" "),
    };
}
/** Stamp literal descriptor properties using the existing syntax-aware token stream. */
export function stampExtensionVersion(source, version) {
    const tokens = tokenize(source, "extension.ts");
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].text !== "defineExtension" || tokens[i + 1]?.text !== "(" || tokens[i + 2]?.text !== "{")
            continue;
        let depth = 1;
        let nesting = 0;
        for (let j = i + 3; j < tokens.length && depth > 0; j++) {
            const token = tokens[j];
            if (token.text === "{")
                depth++;
            if (token.text === "}")
                depth--;
            if (token.text === "(" || token.text === "[")
                nesting++;
            if (token.text === ")" || token.text === "]")
                nesting--;
            const value = tokens[j + 2];
            // A property key directly follows the descriptor's `{` or a `,` outside any parentheses or brackets;
            // this excludes a top-level ternary such as `channel: isDev ? version : "stable"`.
            const keyPosition = nesting === 0 && (tokens[j - 1]?.text === "{" || tokens[j - 1]?.text === ",");
            if (depth === 1 && keyPosition && ["version", '\'version\'', '"version"'].includes(token.text)
                && tokens[j + 1]?.text === ":" && value && /^["']/.test(value.text)) {
                edits.push({ start: value.start, end: value.start + value.text.length });
            }
        }
    }
    for (const edit of edits.reverse())
        source = source.slice(0, edit.start) + JSON.stringify(version) + source.slice(edit.end);
    return source;
}
/** Safely narrow a JSON object received from the npm attestation endpoint. */
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** Check registry-served SLSA v1 provenance binds both the tarball digest and published commit. */
export function verifyPublishedProvenance(bundle, commit, integrity) {
    const attestations = record(bundle).attestations;
    if (!Array.isArray(attestations))
        return false;
    const [algorithm, digest] = integrity.split("-");
    if (algorithm !== "sha512" || !digest)
        return false;
    const expectedDigest = Buffer.from(digest, "base64").toString("hex");
    return attestations.some((entry) => {
        const attestation = record(entry);
        if (attestation.predicateType !== "https://slsa.dev/provenance/v1")
            return false;
        const envelope = record(record(attestation.bundle).dsseEnvelope);
        if (typeof envelope.payload !== "string")
            return false;
        let statement;
        try {
            statement = record(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")));
        }
        catch {
            return false;
        }
        const subjects = statement.subject;
        const dependencies = record(record(statement.predicate).buildDefinition).resolvedDependencies;
        return Array.isArray(subjects) && subjects.some((subject) => record(record(subject).digest).sha512 === expectedDigest)
            && Array.isArray(dependencies) && dependencies.some((dependency) => record(record(dependency).digest).gitCommit === commit);
    });
}
export { verifyBunScript } from "./release-verification.js";
/** Stamp the package table's literal Cargo version while preserving dependency and metadata versions. */
export function stampCargoVersion(source, version) {
    const header = /^\[package\][ \t]*(?:#[^\n]*)?\r?$/m.exec(source);
    if (!header)
        throw new Error("Cargo manifest has no package table");
    const start = header.index + header[0].length;
    const rest = source.slice(start);
    const nextSection = rest.search(/^\s*\[/m);
    const stop = nextSection < 0 ? source.length : start + nextSection;
    const section = source.slice(start, stop);
    const field = /^([ \t]*version[ \t]*=[ \t]*)(["'])[^"']*\2/m;
    if (!field.test(section))
        throw new Error("Cargo package has no literal version");
    return source.slice(0, start)
        + section.replace(field, (_match, prefix) => `${prefix}"${version}"`)
        + source.slice(stop);
}
//# sourceMappingURL=daily-release.js.map