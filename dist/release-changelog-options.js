/**
 * Canonical release hooks are lists of direct pm-changelog commands, local
 * npm/bun/pnpm script forwards, literal checks and ordinary helper commands.
 * Newlines, &&, || and ; sequence commands. A pipeline audits each command.
 * timeout, nice, env, command, exec, stdbuf, time and package runners have
 * explicit argv boundaries. npm runs pre/main/post with argv only on main.
 * Source spans belong to the script that wrote each word. Shell evaluation,
 * unknown wrappers and ambiguous policies require a canonical invocation.
 */
import { basename } from "node:path";
import { releaseHookCommand, } from "./shell-scan.js";
import { mentionsGenerator, hookSyntaxProblem, literalOptionName, parseReleaseHook, refuseHook } from "./release-hook-grammar.js";
/** The flag that makes an untagged heading version-derived. */
export const DATE_FLAG = "--date-from-version";
/** The option that pins the heading day of a resumed release. */
export const FALLBACK_DATE_FLAG = "--date-fallback";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Match executables and registry package specifiers left by package runner prefixes. */
const GENERATOR_TARGET = /^pm-changelog@[^/]+$|(?:^|\/)(?:pm-changelog(?:\.ts)?|dist\/cli\.js)$/;
/** The three generator inputs that bind a heading to a release. */
export const VERSION_INPUTS = ["--release-version-from-package", "--release-version", "--version"];
/** True when a command supplies an explicit release version. */
export function hasVersionInput(args) {
    return optionPositions(args).some(index => {
        const word = args[index];
        return (word.unresolved && !word.value.startsWith("-"))
            || VERSION_INPUTS.some(flag => word.value === flag || word.value.startsWith(flag + "="));
    });
}
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "bun"]);
const BUN_SOURCE_FILE = /^(?:\.\/|\/)|\.(?:[cm]?[jt]s|[jt]sx)$/;
const BUN_LOCAL_RUN_SWITCHES = new Set([
    "-b", "--bun", "--silent", "--watch", "--hot", "--no-clear-screen",
    "--smol", "--no-install", "--prefer-offline", "--prefer-latest",
]);
const NPM_LOCAL_RUN_SWITCH = /^(?:-[sq]|-d{1,3}|--silent|--quiet|--verbose|--(?:no-)?(?:ignore-scripts|foreground-scripts)(?:=(?:true|false))?)$/;
const NPM_LOG_LEVEL = /^(?:silent|error|warn|notice|http|info|verbose|silly)$/;
const NPM_BOOLEAN = /^--(no-)?(if-present|ignore-scripts)(?:=(true|false))?$/;
const BOOLEAN_VALUE = /^(?:true|false)$/;
const PACKAGE_ADMIN_COMMANDS = new Set([
    "add", "audit", "ci", "dedupe", "explain", "i", "info", "install", "list", "ls", "outdated",
    "remove", "rm", "search", "show", "uninstall", "update", "upgrade", "view", "why",
]);
const DATA_CONSUMERS = new Set(["echo", "printf", "test", "[", "[[", "command", "which", "type", "ls"]);
/** Options that accept a separate operand in the pinned pm-changelog CLI. */
const VALUE_OPTIONS = new Set([
    "--audit-receipts", "-i", "-o", "--body-preview", "--date", FALLBACK_DATE_FLAG, "--exclude-tag", "--exclude-tags",
    "--format", "--group-by", "--input", "--item-ref-style", "--item-url-base", "--limit", "--mode", "--output",
    "--pm-arg", "--pm-bin", "--pm-cwd", "--pm-root", "--release-tag-pattern", "--release-version", "--entry-from",
    "--section-by", "--since", "--since-version", "--status", "--statuses", "--title", "--until", "--version",
]);
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
function afterNpmRunOptions(tokens, start, optional = false, lifecycle) {
    let index = start;
    for (;;) {
        const option = tokens[index];
        if (!option || option.unresolved)
            return { index, optional, lifecycle };
        const setting = NPM_BOOLEAN.exec(option.value);
        if (setting) {
            let value = setting[3];
            const operand = tokens[index + 1]?.value;
            if (value === undefined && BOOLEAN_VALUE.test(operand ?? "")) {
                value = operand;
                index++;
            }
            const enabled = setting[1] ? value === "false" : value !== "false";
            if (setting[2] === "if-present")
                optional = enabled;
            else
                lifecycle = !enabled;
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
            return { index, optional, lifecycle };
        }
    }
}
/** Read a script target only when the command supplies its literal name. */
function literalScriptName(target) {
    return target?.value && !target.unresolved && !target.value.startsWith("-") ? target.value : undefined;
}
/** Skip runner flags that appear before the subcommand or script name. */
function afterRunOptions(program, tokens, start, optional = false, lifecycle) {
    if (program === "npm")
        return afterNpmRunOptions(tokens, start, optional, lifecycle);
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
    const entry = afterRunOptions(program, parameters, command.index + 1, command.optional, command.lifecycle);
    const target = literalScriptName(parameters[entry.index]);
    // Bun also runs source files and local binaries when there is no named script.
    if (program === "bun" && target !== undefined && !scriptNames?.has(target)
        && (BUN_SOURCE_FILE.test(target) || GENERATOR_TARGET.test(target)))
        return undefined;
    const tail = parameters.slice(entry.index + 1);
    if (program !== "npm") {
        const separator = tail[0]?.value === "--" ? tail[0] : undefined;
        if (program === "pnpm")
            return { target, optional: entry.optional, args: tail, forwardedSeparator: separator };
        return { target, optional: entry.optional, args: separator ? tail.slice(1) : tail };
    }
    const separator = tail.findIndex(token => token.value === "--" && !token.unresolved);
    const flags = separator < 0 ? tail : tail.slice(0, separator);
    const settings = afterNpmRunOptions(flags, 0, entry.optional, entry.lifecycle);
    return { target, npm: true, lifecycle: settings.lifecycle, optional: settings.optional, args: separator < 0 ? [] : tail.slice(separator + 1) };
}
/** Expand a runner invocation. npm executes lifecycle siblings once without forwarded arguments. */
function scriptSequence(name, names, lifecycle = false) {
    return lifecycle ? [`pre${name}`, name, `post${name}`].filter(script => script === name || names.has(script)) : [name];
}
/** Resolve the same invocation graph used by preparation and continuation, including comment-only hooks. */
export function resolveChangelogHooks(scripts, hooks) {
    const all = new Map(Object.entries(scripts ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : ""]));
    const resolved = new Map();
    visitChangelogScriptCommands(all, ({ effective, names }) => { changelogInvocation(effective, names); }, hooks, resolved);
    return resolved;
}
/** Administrative package operands are dependency names rather than commands. */
function isPackageAdmin(program, parameters) {
    const name = basename(program.value);
    if (program.unresolved || !PACKAGE_MANAGERS.has(name))
        return false;
    const subcommand = parameters[afterRunOptions(name, parameters, 0).index];
    return subcommand !== undefined && !subcommand.unresolved && PACKAGE_ADMIN_COMMANDS.has(subcommand.value);
}
/** Return the generator word and arguments, or refuse a possible hook behind an unknown wrapper. */
function changelogInvocation(words, scriptNames, audit = false) {
    const invocation = releaseHookCommand(words);
    const mentions = words.some(mentionsGenerator);
    const problem = hookSyntaxProblem(words);
    if (problem && mentions) {
        const dynamicOption = words.some(word => word.unresolved && word.value.startsWith("-"));
        if (dynamicOption && invocation && GENERATOR_TARGET.test(invocation[0].value) && !hasVersionInput(invocation.slice(1))
            && !words.some(word => word.value.startsWith("--date-")))
            return undefined;
        refuseHook(dynamicOption ? "Unresolved option word: " + problem : problem);
    }
    if (!invocation) {
        if (mentions && words.some(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)))
            refuseHook("Incomplete wrapper before pm-changelog");
        return undefined;
    }
    const [program, ...parameters] = invocation;
    const name = basename(program.value);
    const forward = scriptForward(name, parameters, scriptNames);
    if (forward && (!audit || (forward.target !== undefined && (forward.optional || scriptNames.has(forward.target)))))
        return undefined;
    const [subcommand] = parameters;
    if (isPackageAdmin(program, parameters))
        return undefined;
    if (program.unresolved && mentionsGenerator(program))
        refuseHook("Indirect pm-changelog executable " + JSON.stringify(program.value));
    if (GENERATOR_TARGET.test(program.value))
        return invocation;
    if (name === "node" || name === "bun") {
        let index = 0;
        if (name === "bun" && subcommand?.value === "run")
            index++;
        while (parameters[index]?.value === "--enable-source-maps" || BUN_LOCAL_RUN_SWITCHES.has(parameters[index]?.value))
            index++;
        const file = parameters[index];
        if (file && !file.unresolved && GENERATOR_TARGET.test(file.value))
            return parameters.slice(index);
    }
    if (name === "command") {
        const lookup = parameters.find(word => word.value !== "-p");
        if (/^-p*[vV][pvV]*$/.test(lookup?.value ?? ""))
            return undefined;
    }
    else if (DATA_CONSUMERS.has(name))
        return undefined;
    const nested = words.flatMap(word => word.value.split(/[^\w.:-]+/));
    const indirect = scriptNames instanceof HookScriptNames && nested.some(word => SCRIPT_RUNNERS.has(word))
        && nested.some(word => word === "run" || word === "run-script") && nested.some(word => scriptNames.canGenerate(word));
    if (mentions || indirect)
        refuseHook(`Unrecognized wrapper or executable ${JSON.stringify(program.value)} before possible pm-changelog command`);
    return undefined;
}
/** Check indirect references inside unknown wrappers only for dependencies that can reach a generator. */
class HookScriptNames extends Set {
    scripts;
    constructor(scripts) {
        super(scripts.keys());
        this.scripts = scripts;
    }
    /** Follow literal script references without recursively evaluating the wrapper's shell payload. */
    canGenerate(name, seen = new Set()) {
        if (!this.has(name) || seen.has(name))
            return false;
        seen.add(name);
        return parseReleaseHook(this.scripts.get(name)).commands.some(words => {
            const command = releaseHookCommand(words);
            if (!command)
                return false;
            const [program, ...parameters] = command;
            if (DATA_CONSUMERS.has(basename(program.value)) || isPackageAdmin(program, parameters))
                return false;
            const forward = scriptForward(basename(program.value), parameters, this);
            if (forward?.target)
                return scriptSequence(forward.target, this, forward.npm && forward.lifecycle !== false).some(target => this.canGenerate(target, seen));
            return words.some(mentionsGenerator);
        });
    }
}
/** Read generator arguments during an audit, where only declared forwards are trusted. */
export function changelogArguments(words, scriptNames) {
    return changelogInvocation(words, scriptNames, true)?.slice(1);
}
/** Identify the original command that would receive argv appended by a script runner. */
function commandReceivingArguments(text, commands, spans) {
    const marker = "__pm_ops_forwarded_argument__";
    const appended = parseReleaseHook(text + " " + marker);
    const recipient = appended.commands.find(words => words.length > 1 && words.at(-1).value === marker
        && appended.spans.get(words.at(-1))?.start === text.length + 1);
    if (!recipient)
        return undefined;
    const start = appended.spans.get(recipient[0]).start;
    return commands.find(words => spans.get(words[0])?.start === start);
}
/** Scan local scripts in invocation order and join forwarded argv at its actual destination. */
export function visitChangelogScriptCommands(scripts, inspect, hooks, resolved) {
    const names = new HookScriptNames(scripts);
    const targeted = new Set();
    const parsed = new Map([...scripts].map(([name, text]) => {
        const { commands, spans } = parseReleaseHook(text);
        return [name, { text, commands, spans }];
    }));
    /** Return a forward only when its script has a body in this manifest. */
    function forwardToScript(words) {
        const command = releaseHookCommand(words);
        if (!command)
            return undefined;
        const [program, ...parameters] = command;
        const forward = scriptForward(basename(program.value), parameters, names);
        return forward;
    }
    const visited = new Set();
    const withoutArgs = new Map();
    const recipients = new Map();
    const forwardedSeparators = new WeakSet();
    /** Walk one invocation, preserving token identity back to each supplying script. */
    function visit(name, args, parents, lifecycle = true) {
        const chain = [...parents, name].join(" -> ");
        if (parents.includes(name)) {
            if (hooks)
                refuseHook("Changelog script forward cycle: " + chain);
            return;
        }
        if (hooks && parents.length > MAX_SCRIPT_FORWARDS)
            refuseHook(`Changelog script forward depth exceeds ${MAX_SCRIPT_FORWARDS}: ${chain}`);
        const script = parsed.get(name);
        if (!script?.text.trim()) {
            if (!hooks)
                return;
            refuseHook(parents.length === 0 ? "Missing changelog hook: " + name
                : "Cannot resolve changelog script forward " + chain + ": missing or empty package.json script");
        }
        if (args.length === 0) {
            const key = Number(lifecycle) + ":" + name;
            const depth = hooks ? parents.length : 0;
            if ((withoutArgs.get(key) ?? -1) >= depth)
                return;
            withoutArgs.set(key, depth);
        }
        visited.add(name);
        const { text, commands, spans } = script;
        resolved?.set(name, text);
        let recipient;
        if (args.length > 0) {
            if (!recipients.has(name))
                recipients.set(name, commandReceivingArguments(text, commands, spans));
            recipient = recipients.get(name);
        }
        for (const words of commands) {
            const effective = words === recipient ? [...words, ...args] : words;
            const forward = forwardToScript(effective);
            // pnpm passes its delimiter through verbatim. A nested runner can consume
            // it, but the generator only accepts named options.
            const separators = effective.filter(token => forwardedSeparators.has(token));
            inspect({ name, names, text, words, effective: effective.filter(token => !forwardedSeparators.has(token)), spans, forwardedSeparators: separators });
            if (forward) {
                if (forward.target === undefined) {
                    if (hooks)
                        refuseHook(`Cannot resolve changelog script forward in ${JSON.stringify(name)}: expected a literal package.json script name`);
                    continue;
                }
                if (!names.has(forward.target) && (forward.optional || !hooks))
                    continue;
                if (forward.forwardedSeparator)
                    forwardedSeparators.add(forward.forwardedSeparator);
                const enabled = forward.lifecycle ?? lifecycle;
                for (const target of scriptSequence(forward.target, names, forward.npm && enabled)) {
                    visit(target, target === forward.target ? forward.args : [], [...parents, name], enabled);
                }
            }
        }
    }
    if (hooks) {
        for (const hook of hooks)
            for (const name of scriptSequence(hook, names, true))
                visit(name, [], []);
        return;
    }
    for (const { commands } of parsed.values()) {
        for (const words of commands) {
            const forward = forwardToScript(words);
            if (forward?.target)
                targeted.add(forward.target);
        }
    }
    for (const name of names) {
        if (!targeted.has(name))
            visit(name, [], []);
    }
    // A disconnected cycle has no root. Its own commands still need auditing.
    for (const name of names) {
        if (!visited.has(name))
            visit(name, [], []);
    }
}
/** Preserve option/operand boundaries, including option-shaped --pm-arg data. */
function optionPositions(args) {
    const positions = [];
    for (let i = 0; i < args.length; i++) {
        positions.push(i);
        const flag = args[i].value;
        if (VALUE_OPTIONS.has(flag) && args[i + 1] && (flag === "--pm-arg" || !args[i + 1].value.startsWith("--")))
            i++;
    }
    return positions;
}
/** Decode literal date options and retain their shell words for edits. */
export function readReleaseDateOptions(args) {
    const options = [];
    for (const index of optionPositions(args)) {
        const token = args[index];
        if (VALUE_OPTIONS.has(token.value) && args[index + 1]?.multipleWords) {
            refuseHook(`Unquoted or multiword expansion in the operand of ${token.value}`);
        }
        if (token.unresolved) {
            const name = literalOptionName(token);
            if (name !== undefined && name !== DATE_FLAG && name !== FALLBACK_DATE_FLAG)
                continue;
            refuseHook(`Unresolved option word in pm-changelog hook: ${JSON.stringify(token.value)}`);
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
    if (options.some(option => option.kind === "version") && options.some(option => option.kind !== "version")) {
        refuseHook(`Mutually exclusive ${DATE_FLAG} and ${FALLBACK_DATE_FLAG}`);
    }
    return options;
}
/** Validate date options on the effective generator argv before editing or checking the heading. */
function hookDateOptions(args) {
    if (!hasVersionInput(args) && !args.some(({ value }) => value.startsWith("--date-")))
        return [];
    const options = readReleaseDateOptions(args);
    if (!options.length)
        refuseHook("Versioned pm-changelog invocation without a date policy");
    return options.map(option => {
        if (option.kind === "missing-day" || option.kind === "invalid-day")
            refuseHook("Invalid --date-fallback operand, expected a real YYYY-MM-DD day");
        return option;
    });
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
/** Compare the options on one generator command with the verified merge day. */
function assertHeadingOptions(words, mergeDay, packageVersion, names) {
    const args = changelogInvocation(words, names)?.slice(1) ?? [];
    for (const option of hookDateOptions(args)) {
        let day;
        if (option.kind === "version") {
            let version = packageVersion;
            for (const i of optionPositions(args)) {
                const [flag, inline] = args[i].value.split("=");
                if (flag === "--version" || flag === "--release-version")
                    version = inline ?? args[i + 1]?.value;
            }
            day = versionHeadingDay(version);
        }
        else
            day = option.day;
        if (day !== mergeDay) {
            throw new Error(`Prepared release heading day ${day} differs from verified merge commit day ${mergeDay}. Refusing to publish. Manually dispatch the workflow with retire-unpublished set to retire the unpublished candidate.`);
        }
    }
}
/** Refuse publication when a standalone generator's heading differs from the verified merge day. */
export function assertReleaseHeadingDate(scripts, mergeDay, packageVersion, scriptNames) {
    for (const script of scripts) {
        for (const words of parseReleaseHook(script).commands)
            assertHeadingOptions(words, mergeDay, packageVersion, scriptNames);
    }
}
/** Verify the complete generator argv from each release hook before publication. */
export function assertReleaseHookHeadingDate(scripts, hooks, mergeDay, packageVersion) {
    visitChangelogScriptCommands(scripts, ({ effective, names }) => assertHeadingOptions(effective, mergeDay, packageVersion, names), hooks);
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
    const { commands, spans } = parseReleaseHook(script);
    const edits = new Map();
    for (const words of commands) {
        const invocation = changelogInvocation(words, scriptNames);
        if (invocation === undefined || optionPositions(invocation.slice(1)).some(i => invocation[i + 1].value === INCLUDE_EMPTY_FLAG))
            continue;
        const token = invocation.at(-1);
        const last = spans.get(token);
        // A caller can supply the operand of the final option. Insert before an
        // open option so its operand remains adjacent across the script boundary.
        const before = VALUE_OPTIONS.has(token.value) && optionPositions(invocation.slice(1)).includes(invocation.length - 2);
        const offset = before ? last.start : last.end;
        edits.set(offset, { start: offset, end: offset, text: before ? INCLUDE_EMPTY_FLAG + " " : " " + INCLUDE_EMPTY_FLAG });
    }
    return applyHookEdits(script, edits.values());
}
/** Refresh the inline pins, or restore the standing policy for a current version. */
export function rewriteReleaseHeadingDate(script, headingDate, scriptNames) {
    const { commands, spans } = parseReleaseHook(script);
    const source = { text: script, spans, edits: new Map() };
    rewriteDateOptions(commands.flatMap(words => hookDateOptions(changelogInvocation(words, scriptNames)?.slice(1) ?? [])), headingDate, () => source);
    return applyHookEdits(script, source.edits.values());
}
/** Pin or restore the original words, even when a caller supplied the date operand. */
function rewriteDateOptions(options, headingDate, sourceOf) {
    const replacement = headingDate ? FALLBACK_DATE_FLAG + " " + headingDate : DATE_FLAG;
    for (const option of options) {
        if (option.kind === "version" && !headingDate)
            continue;
        const firstSource = sourceOf(option.first);
        const lastSource = sourceOf(option.last);
        const first = firstSource.spans.get(option.first);
        const last = lastSource.spans.get(option.last);
        // A redirection between the option and its operand can be dropped from
        // argv by commandCandidates. Preserve it when rewriting the source.
        if (firstSource !== lastSource || (option.first !== option.last
            && !/^(?:[ \t\r]|\\\n)*$/.test(firstSource.text.slice(first.end, last.start)))) {
            lastSource.edits.set(last.start, { ...last, text: "" });
            firstSource.edits.set(first.start, { ...first, text: replacement });
        }
        else {
            firstSource.edits.set(first.start, { start: first.start, end: last.end, text: replacement });
        }
    }
}
/** Rewrite all heading options received by the manifest's resolved release hooks. */
export function rewriteReleaseHookDates(scripts, hooks, headingDate) {
    const sources = new Map();
    const owners = new WeakMap();
    visitChangelogScriptCommands(scripts, ({ name, names, text, spans, words, effective, forwardedSeparators }) => {
        let source = sources.get(name);
        if (!source) {
            source = { text, spans, edits: new Map() };
            sources.set(name, source);
        }
        for (const token of words)
            owners.set(token, source);
        const options = hookDateOptions(changelogInvocation(effective, names)?.slice(1) ?? []);
        rewriteDateOptions(options, headingDate, token => owners.get(token));
        if (options.length > 0) {
            for (const separator of forwardedSeparators) {
                const owner = owners.get(separator);
                const span = owner.spans.get(separator);
                const space = /^[ \t]*/.exec(owner.text.slice(span.end))[0];
                owner.edits.set(span.start, { start: span.start, end: span.end + space.length, text: "" });
            }
        }
    }, hooks);
    return new Map([...sources].map(([name, { text, edits }]) => [name, applyHookEdits(text, edits.values())]));
}
//# sourceMappingURL=release-changelog-options.js.map