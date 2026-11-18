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
const PACKAGE_ADMIN_COMMANDS = new Set([
    "add", "audit", "ci", "dedupe", "explain", "i", "info", "install", "list", "ls", "outdated",
    "remove", "rm", "search", "show", "uninstall", "update", "upgrade", "view", "why",
]);
/** Whether a YYYY-MM-DD string names an existing day, including years 0–99. */
export function isRealCalendarDay(day) {
    const [year, month, date] = day.split("-").map(Number);
    const round = new Date(0);
    round.setUTCFullYear(year, month - 1, date);
    return round.getUTCFullYear() === year && round.getUTCMonth() === month - 1 && round.getUTCDate() === date;
}
/** Return the generator's arguments, or refuse a possible hook behind an unknown wrapper. */
export function changelogArguments(words) {
    const invocation = commandCandidates(words)[0];
    if (invocation === undefined)
        return undefined;
    const [program, ...parameters] = invocation;
    const name = basename(program.value);
    const [subcommand] = parameters;
    if (PACKAGE_MANAGERS.has(name) && !program.unresolved && subcommand && !subcommand.unresolved
        && PACKAGE_ADMIN_COMMANDS.has(subcommand.value))
        return undefined;
    const isLauncher = GENERATOR_LAUNCHERS.has(name);
    const generatorAt = isLauncher ? parameters.findIndex(({ value }) => GENERATOR_TARGET.test(value)) : -1;
    if (GENERATOR_TARGET.test(program.value) || generatorAt >= 0)
        return parameters.slice(generatorAt + 1);
    // The shell scanner emits evaluated text separately. Its synthetic readings
    // can start with an evaluator option such as -c. Prints carry data only.
    if (isShellEvaluator(name) || program.value.startsWith("-") || name === "echo" || name === "printf")
        return undefined;
    const target = parameters.find(({ value }) => value.includes("pm-changelog") || GENERATOR_TARGET.test(value));
    if (target !== undefined) {
        throw new Error(`Unrecognized wrapper ${JSON.stringify(program.value)} before possible pm-changelog command ${JSON.stringify(target.value)}`);
    }
    return undefined;
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
    return commands.flatMap(words => readReleaseDateOptions(changelogArguments(words) ?? []));
}
/** Refuse publication when the verified merge day differs from a prepared pin. */
export function assertReleaseHeadingDate(scripts, mergeDay) {
    for (const script of scripts) {
        for (const option of hookDateOptions(tokenizeCommands(script))) {
            if ((option.kind === "pin" || option.kind === "invalid-day") && option.day !== mergeDay) {
                throw new Error(`Prepared release heading day ${option.day} differs from verified merge commit day ${mergeDay}. Refusing to publish; re-prepare the candidate for the merge day. The reviewed commit and verified artifact cannot be rewritten during continuation.`);
            }
        }
    }
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
    for (const { start, end, text } of [...edits.values()].sort((a, b) => b.start - a.start)) {
        script = script.slice(0, start) + text + script.slice(end);
    }
    return script;
}
//# sourceMappingURL=release-changelog-options.js.map