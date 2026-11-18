/** Read and rewrite pm-changelog date policies using the shared shell scanner. */
import { basename } from "node:path";
import { commandCandidates, fixedOptionName, isShellEvaluator, tokenizeCommands, tokenizeCommandsWithSpans, } from "./shell-scan.js";
/** The flag that makes an untagged heading version-derived. */
export const DATE_FLAG = "--date-from-version";
/** The option that pins the heading day of a resumed release. */
export const FALLBACK_DATE_FLAG = "--date-fallback";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Match executables and registry package specifiers left by package runner prefixes. */
const GENERATOR_TARGET = /^pm-changelog@[^/]+$|(?:^|\/)(?:pm-changelog(?:\.ts)?|dist\/cli\.js)$/;
const GENERATOR_LAUNCHERS = new Set(["node", "npx", "bun", "bunx"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "bun"]);
const PACKAGE_ADMIN_COMMANDS = new Set([
    "add", "audit", "ci", "dedupe", "explain", "i", "info", "install", "list", "ls", "outdated",
    "remove", "rm", "search", "show", "uninstall", "update", "upgrade", "view", "why",
]);
const DATA_CONSUMERS = new Set(["echo", "printf", "test", "[", "[[", "command", "which", "type", "ls"]);
const INCLUDE_EMPTY_FLAG = "--include-empty";
const MAX_SCRIPT_FORWARDS = 8;
/** Whether a YYYY-MM-DD string names an existing day, including years 0–99. */
export function isRealCalendarDay(day) {
    const [year, month, date] = day.split("-").map(Number);
    const round = new Date(0);
    round.setUTCFullYear(year, month - 1, date);
    return round.getUTCFullYear() === year && round.getUTCMonth() === month - 1 && round.getUTCDate() === date;
}
/** Recognize package-manager commands that run a script in the same manifest. */
function isScriptForward(program, subcommand) {
    return (subcommand === "run" && SCRIPT_RUNNERS.has(program)) || (program === "npm" && subcommand === "run-script");
}
/** Resolve the hook scripts and their local script dependencies before editing or verifying them. */
export function resolveChangelogHooks(scripts, hooks) {
    const resolved = new Map();
    /** Compute the longest remaining forward chain, including through shared scripts. */
    function visit(name, parents) {
        const chain = [...parents, name];
        if (parents.includes(name))
            throw new Error(`Changelog script forward cycle: ${chain.join(" -> ")}`);
        const cached = resolved.get(name);
        if (parents.length + (cached?.depth ?? 0) > MAX_SCRIPT_FORWARDS) {
            throw new Error(`Changelog script forward depth exceeds ${MAX_SCRIPT_FORWARDS}: ${chain.join(" -> ")}`);
        }
        if (cached)
            return cached.depth;
        const script = scripts?.[name];
        if (typeof script !== "string" || !script.trim()) {
            throw new Error(parents.length === 0
                ? "Missing changelog hook: " + name
                : `Cannot resolve changelog script forward ${chain.join(" -> ")}: missing or empty package.json script`);
        }
        let depth = 0;
        for (const words of tokenizeCommands(script)) {
            const invocation = commandCandidates(words)[0];
            if (!invocation)
                continue;
            const [program, subcommand, target] = invocation;
            if (!isScriptForward(basename(program.value), subcommand?.value))
                continue;
            if (!target?.value || target.unresolved || target.value.startsWith("-")) {
                throw new Error(`Cannot resolve changelog script forward in ${JSON.stringify(name)}: expected a literal package.json script name`);
            }
            depth = Math.max(depth, 1 + visit(target.value, chain));
        }
        resolved.set(name, { script, depth });
        return depth;
    }
    for (const name of hooks)
        visit(name, []);
    return new Map([...resolved].map(([name, { script }]) => [name, script]));
}
/** Return the generator word and arguments, or refuse a possible hook behind an unknown wrapper. */
function changelogInvocation(words, scriptNames) {
    const invocation = commandCandidates(words)[0];
    if (invocation === undefined)
        return undefined;
    const [program, ...parameters] = invocation;
    const name = basename(program.value);
    const [subcommand, targetScript] = parameters;
    if (isScriptForward(name, subcommand?.value)
        && (scriptNames === undefined || (targetScript && !targetScript.unresolved && scriptNames.has(targetScript.value))))
        return undefined;
    if (PACKAGE_MANAGERS.has(name) && !program.unresolved && subcommand && !subcommand.unresolved
        && PACKAGE_ADMIN_COMMANDS.has(subcommand.value))
        return undefined;
    const isLauncher = GENERATOR_LAUNCHERS.has(name);
    const generatorAt = isLauncher ? parameters.findIndex(({ value }) => GENERATOR_TARGET.test(value)) : -1;
    if (GENERATOR_TARGET.test(program.value) || generatorAt >= 0)
        return invocation.slice(generatorAt + 1);
    // The shell scanner emits evaluated text separately. Its synthetic readings
    // can start with an evaluator option such as -c.
    if (isShellEvaluator(name) || program.value.startsWith("-") || DATA_CONSUMERS.has(name))
        return undefined;
    const target = parameters.find(({ value }) => value.includes("pm-changelog") || GENERATOR_TARGET.test(value));
    if (target !== undefined) {
        throw new Error(`Unrecognized wrapper ${JSON.stringify(program.value)} before possible pm-changelog command ${JSON.stringify(target.value)}`);
    }
    return undefined;
}
/** Read generator arguments during an audit, where only declared forwards are trusted. */
export function changelogArguments(words, scriptNames) {
    return changelogInvocation(words, scriptNames)?.slice(1);
}
/** Decode literal date options and retain their shell words for edits. */
export function readReleaseDateOptions(args) {
    const options = [];
    for (const [index, token] of args.entries()) {
        if (token.unresolved && token.value.startsWith("-")) {
            const name = fixedOptionName(token);
            if (name !== undefined && name !== DATE_FLAG && name !== FALLBACK_DATE_FLAG)
                continue;
            throw new Error(`Unresolved option word in pm-changelog hook: ${JSON.stringify(token.value)}`);
        }
        if (token.value === DATE_FLAG) {
            options.push({ kind: "version", first: token, last: token });
            continue;
        }
        const separate = token.value === FALLBACK_DATE_FLAG;
        if (!separate && !token.value.startsWith(FALLBACK_DATE_FLAG + "="))
            continue;
        const operand = separate ? args[index + 1] : token;
        const day = separate ? operand?.value : token.value.slice(FALLBACK_DATE_FLAG.length + 1);
        if (day === undefined || operand?.unresolved || !ISO_DAY.test(day)) {
            options.push({ kind: "missing-day", first: token, last: token });
            continue;
        }
        options.push({ kind: isRealCalendarDay(day) ? "pin" : "invalid-day", first: token, last: operand, day });
    }
    return options;
}
/** Read date options only from commands that actually invoke the generator. */
function hookDateOptions(commands) {
    return commands.flatMap(words => readReleaseDateOptions(changelogInvocation(words)?.slice(1) ?? []));
}
/** Render a calendar version using the same day and suffix rules as pm-changelog. */
function versionHeadingDay(version) {
    const match = version?.trim().match(/^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d+)?$/i);
    if (match) {
        const [, year, month, date] = match;
        const day = `${year}-${month.padStart(2, "0")}-${date.padStart(2, "0")}`;
        // The generator validates with Date.UTC, which shifts years 0 to 99.
        if (Number(year) >= 100 && isRealCalendarDay(day))
            return day;
    }
    throw new Error(`Cannot verify the prepared release heading for calendar version ${JSON.stringify(version)}. Refusing to publish; re-prepare the candidate with a valid calendar version.`);
}
/** Refuse publication when the verified merge day differs from the prepared heading day. */
export function assertReleaseHeadingDate(scripts, mergeDay, packageVersion) {
    for (const script of scripts) {
        for (const option of hookDateOptions(tokenizeCommands(script))) {
            const day = option.kind === "version" ? versionHeadingDay(packageVersion) : "day" in option ? option.day : undefined;
            if (day !== undefined && day !== mergeDay) {
                throw new Error(`Prepared release heading day ${day} differs from verified merge commit day ${mergeDay}. Refusing to publish; re-prepare the candidate for the merge day. The reviewed commit and verified artifact cannot be rewritten during continuation.`);
            }
        }
    }
}
/** Apply source edits back to front so their offsets stay valid. */
function applyHookEdits(script, edits) {
    for (const { start, end, text } of [...edits].sort((a, b) => b.start - a.start)) {
        script = script.slice(0, start) + text + script.slice(end);
    }
    return script;
}
/** Enable empty sections on each generator while preserving shell operators and redirections. */
export function includeEmptyReleaseSections(script) {
    const { commands, spans } = tokenizeCommandsWithSpans(script);
    const edits = new Map();
    for (const words of commands) {
        const invocation = changelogInvocation(words);
        if (invocation === undefined || invocation.some(token => !token.unresolved && token.value === INCLUDE_EMPTY_FLAG))
            continue;
        const last = spans.get(invocation.at(-1));
        if (!last)
            throw new Error("The --include-empty option needs an editable shell word in the changelog hook");
        edits.set(last.end, { start: last.end, end: last.end, text: " " + INCLUDE_EMPTY_FLAG });
    }
    return applyHookEdits(script, edits.values());
}
/** Refresh the inline pins, or restore the standing policy for a current version. */
export function rewriteReleaseHeadingDate(script, headingDate) {
    const { commands, spans } = tokenizeCommandsWithSpans(script);
    const edits = new Map();
    const replacement = headingDate ? FALLBACK_DATE_FLAG + " " + headingDate : DATE_FLAG;
    for (const option of hookDateOptions(commands)) {
        if (option.kind !== "pin" && !(option.kind === "version" && headingDate))
            continue;
        const first = spans.get(option.first);
        const last = spans.get(option.last);
        if (!first || !last)
            throw new Error("Release heading date option needs an editable shell word in the changelog hook");
        // A redirection between the option and its operand can be dropped from
        // argv by commandCandidates. Preserve it when rewriting the source.
        if (option.first !== option.last && !/^(?:[ \t\r]|\\\n)*$/.test(script.slice(first.end, last.start))) {
            edits.set(last.start, { ...last, text: "" });
            edits.set(first.start, { ...first, text: replacement });
        }
        else {
            edits.set(first.start, { start: first.start, end: last.end, text: replacement });
        }
    }
    return applyHookEdits(script, edits.values());
}
//# sourceMappingURL=release-changelog-options.js.map