/** Read and rewrite pm-changelog date policies using the shared shell scanner. */
import { basename } from "node:path";
import { fixedOptionName, isShellEvaluator, packageScriptCommand, tokenizeCommands, tokenizeCommandsWithSpans, } from "./shell-scan.js";
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
const BUN_SOURCE_FILE = /^(?:\.\/|\/)|\.(?:[cm]?[jt]s|[jt]sx)$/;
const BUN_LOCAL_RUN_SWITCHES = new Set([
    "-b", "--bun", "--silent", "--watch", "--hot", "--no-clear-screen",
    "--smol", "--no-install", "--prefer-offline", "--prefer-latest",
]);
const NPM_LOCAL_RUN_SWITCH = /^(?:-[sq]|-d{1,3}|--silent|--quiet|--verbose|--(?:no-)?(?:ignore-scripts|foreground-scripts)(?:=(?:true|false))?)$/;
const NPM_LOG_LEVEL = /^(?:silent|error|warn|notice|http|info|verbose|silly)$/;
const NPM_IF_PRESENT = /^--(no-)?if-present(?:=(true|false))?$/;
const BOOLEAN_VALUE = /^(?:true|false)$/;
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
/** Skip local npm switches and retain the last explicit optional-script setting. */
function afterNpmRunOptions(tokens, start, optional = false) {
    let index = start;
    for (;;) {
        const option = tokens[index];
        if (!option || option.unresolved)
            return { index, optional };
        const ifPresent = NPM_IF_PRESENT.exec(option.value);
        if (ifPresent) {
            let value = ifPresent[2];
            const operand = tokens[index + 1]?.value;
            if (value === undefined && BOOLEAN_VALUE.test(operand ?? "")) {
                value = operand;
                index++;
            }
            const enabled = value !== "false";
            optional = ifPresent[1] ? !enabled : enabled;
            index++;
        }
        else if (NPM_LOCAL_RUN_SWITCH.test(option.value)
            || (option.value.startsWith("--loglevel=") && NPM_LOG_LEVEL.test(option.value.slice("--loglevel=".length)))) {
            index++;
        }
        else if (option.value === "--loglevel" && NPM_LOG_LEVEL.test(tokens[index + 1]?.value ?? "")) {
            index += 2;
        }
        else {
            return { index, optional };
        }
    }
}
/** Read a script target only when the command supplies its literal name. */
function literalScriptName(target) {
    return target?.value && !target.unresolved && !target.value.startsWith("-") ? target.value : undefined;
}
/** Skip runner flags that appear before the subcommand or script name. */
function afterRunOptions(program, tokens, start, optional = false) {
    if (program === "npm")
        return afterNpmRunOptions(tokens, start, optional);
    let index = start;
    for (;;) {
        const option = tokens[index];
        if (!option || option.unresolved)
            return { index, optional };
        if (option.value === "--if-present")
            optional = true;
        else if (program !== "bun" || !BUN_LOCAL_RUN_SWITCHES.has(option.value))
            return { index, optional };
        index++;
    }
}
/** Locate the target and optionality of a package-script forward. */
function scriptForward(program, parameters, scriptNames) {
    const command = afterRunOptions(program, parameters, 0);
    if (!isScriptForward(program, parameters[command.index]?.value))
        return undefined;
    const entry = afterRunOptions(program, parameters, command.index + 1, command.optional);
    const target = literalScriptName(parameters[entry.index]);
    // Bun also runs source files and local binaries when there is no named script.
    if (program === "bun" && target !== undefined && !scriptNames?.has(target)
        && (BUN_SOURCE_FILE.test(target) || GENERATOR_TARGET.test(target)))
        return undefined;
    const optional = program === "npm" ? afterNpmRunOptions(parameters, entry.index + 1, entry.optional).optional : entry.optional;
    return { target, optional };
}
/** Resolve the hook scripts and their local script dependencies before editing or verifying them. */
export function resolveChangelogHooks(scripts, hooks) {
    const resolved = new Map();
    const scriptNames = new Set(Object.keys(scripts ?? {}));
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
            const invocation = packageScriptCommand(words);
            if (!invocation)
                continue;
            const [program, ...parameters] = invocation;
            const forward = scriptForward(basename(program.value), parameters, scriptNames);
            if (!forward)
                continue;
            const { target, optional } = forward;
            if (target === undefined) {
                throw new Error(`Cannot resolve changelog script forward in ${JSON.stringify(name)}: expected a literal package.json script name`);
            }
            if (optional && !Object.hasOwn(scripts, target))
                continue;
            depth = Math.max(depth, 1 + visit(target, chain));
        }
        resolved.set(name, { script, depth });
        return depth;
    }
    for (const name of hooks)
        visit(name, []);
    return new Map([...resolved].map(([name, { script }]) => [name, script]));
}
/** Return the generator word and arguments, or refuse a possible hook behind an unknown wrapper. */
function changelogInvocation(words, scriptNames, audit = false) {
    const invocation = packageScriptCommand(words);
    if (invocation === undefined)
        return undefined;
    const [program, ...parameters] = invocation;
    const name = basename(program.value);
    const forward = scriptForward(name, parameters, scriptNames);
    if (forward
        && (!audit || (forward.target !== undefined && (forward.optional || scriptNames.has(forward.target)))))
        return undefined;
    const [subcommand] = parameters;
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
    return changelogInvocation(words, scriptNames, true)?.slice(1);
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
function hookDateOptions(commands, scriptNames) {
    return commands.flatMap(words => readReleaseDateOptions(changelogInvocation(words, scriptNames)?.slice(1) ?? []));
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
export function assertReleaseHeadingDate(scripts, mergeDay, packageVersion, scriptNames) {
    for (const script of scripts) {
        for (const option of hookDateOptions(tokenizeCommands(script), scriptNames)) {
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
export function includeEmptyReleaseSections(script, scriptNames) {
    const { commands, spans } = tokenizeCommandsWithSpans(script);
    const edits = new Map();
    for (const words of commands) {
        const invocation = changelogInvocation(words, scriptNames);
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
export function rewriteReleaseHeadingDate(script, headingDate, scriptNames) {
    const { commands, spans } = tokenizeCommandsWithSpans(script);
    const edits = new Map();
    const replacement = headingDate ? FALLBACK_DATE_FLAG + " " + headingDate : DATE_FLAG;
    for (const option of hookDateOptions(commands, scriptNames)) {
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