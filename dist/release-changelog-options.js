/**
 * Canonical release hooks are lists of direct pm-changelog commands, local
 * npm/bun/pnpm script forwards, literal checks and ordinary helper commands.
 * Newlines, &&, || and ; sequence commands. A pipeline audits each command.
 * timeout, nice, env, command, exec, stdbuf and package runners have
 * explicit argv boundaries. npm runs pre/main/post with argv only on main.
 * Source spans belong to the script that wrote each word. Shell evaluation,
 * unknown wrappers and ambiguous policies require a canonical invocation.
 */
import { describeUnsupportedReleaseHook, isShellAssignment, unsupportedReleaseConstruct } from "./release-shell-constructs.js";
import { basename, posix } from "node:path";
import { isShellEvaluator, RELEASE_CONTEXT_VARIABLE, RELEASE_PROJECT_OPTION, releaseHookCommand, releaseHookConstructProblem, shellRedirection, withoutRedirections, } from "./shell-scan.js";
import { describeReleaseContextChange, followingReleaseOperator, hasBraceExpansion, hookSyntaxProblem, inheritedVariable, isContinuedDescriptor, isIsolatedReleaseCommand, isReleaseIterationHeader, isReleaseLoopCondition, literalOptionName, mentionsGenerator, parseReleaseHook, refuseHook, releaseLoopScope, releaseOutputProducer, } from "./release-hook-grammar.js";
/** The flag that makes an untagged heading version-derived. */
export const DATE_FLAG = "--date-from-version";
/** The option that pins the heading day of a resumed release. */
export const FALLBACK_DATE_FLAG = "--date-fallback";
const OVERRIDE_DATE_FLAG = "--date";
const UNTIL_FLAG = "--until";
const PACKAGE_VERSION_FLAG = "--release-version-from-package";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Match executables and registry package specifiers left by package runner prefixes. */
const GENERATOR_TARGET = /^pm-changelog@[^/]+$|(?:^|\/)(?:pm-changelog(?:\.ts)?|dist\/cli\.js)$/;
/** The three generator inputs that bind a heading to a release. */
export const VERSION_INPUTS = [PACKAGE_VERSION_FLAG, "--release-version", "--version"];
const INDIRECT_RELEASE_OPTIONS = new Set([...VERSION_INPUTS, DATE_FLAG, FALLBACK_DATE_FLAG, UNTIL_FLAG]);
/** Detect option expansions whose literal prefix could name a version input. */
function unresolvedVersionOption(word) {
    if (!word.unresolved || !word.value.startsWith("-"))
        return false;
    const prefix = word.value.split(/[$`*?[]/, 1)[0];
    return VERSION_INPUTS.some(flag => flag.startsWith(prefix));
}
/** Explain the version and date policy required in place of an expanded option name. */
function refuseUnresolvedVersionOption(word) {
    refuseHook(`Unresolved option name ${JSON.stringify(word.value)} could select a release version. Spell the version input literally and use ${DATE_FLAG} or ${FALLBACK_DATE_FLAG} <YYYY-MM-DD>`);
}
/** True when a command supplies an explicit release version. */
export function hasVersionInput(args) {
    return optionPositions(args).some(index => {
        const word = args[index];
        return (word.unresolved && !word.value.startsWith("-"))
            || unresolvedVersionOption(word)
            || VERSION_INPUTS.some(flag => word.value === flag || word.value.startsWith(flag + "="));
    });
}
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPM_LIFECYCLE_COMMAND = /^(?:start|stop|restart|test)$/;
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "bun"]);
/** Bun dispatches its own subcommands before package scripts with the same name. */
const BUN_SUBCOMMANDS = new Set([
    "a", "add", "audit", "auth", "build", "bun", "c", "ci", "cloud", "completions", "config", "create", "deploy",
    "discord", "exec", "getcompletes", "help", "i", "info", "init", "install", "link", "list", "login", "logout",
    "outdated", "patch", "patch-commit", "pm", "prune", "publish", "r", "remove", "repl", "rm", "run", "test",
    "uninstall", "unlink", "update", "upgrade", "use", "whoami", "why", "x",
]);
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
const DATA_CONSUMERS = new Set(["echo", "printf", "test", "[", "[[", "command", "which", "type", "ls", "grep"]);
/** Options that accept a separate operand in the pinned pm-changelog CLI. */
const VALUE_OPTIONS = new Set([
    "--audit-receipts", "-i", "-o", "--body-preview", OVERRIDE_DATE_FLAG, FALLBACK_DATE_FLAG, "--exclude-tag", "--exclude-tags",
    "--format", "--group-by", "--input", "--item-ref-style", "--item-url-base", "--limit", "--mode", "--output",
    "--pm-arg", "--pm-bin", "--pm-cwd", "--pm-root", "--release-tag-pattern", "--release-version", "--entry-from",
    "--section-by", "--since", "--since-version", "--status", "--statuses", "--title", UNTIL_FLAG, "--version",
]);
const INCLUDE_EMPTY_FLAG = "--include-empty";
const MAX_SCRIPT_FORWARDS = 8;
const RETIRE_UNPUBLISHED = "Refusing to publish. Manually dispatch the workflow with retire-unpublished set to retire the unpublished candidate.";
const SCRIPT_FILE_ADVICE = ". Move the logic into a script file";
const CHANGELOG_TRAVERSAL = "Path traversal in a redirection destination writes CHANGELOG.md" + SCRIPT_FILE_ADVICE;
const NODE_OPTION_OPERANDS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
/** Whether a YYYY-MM-DD string names an existing day, including years 0–99. */
export function isRealCalendarDay(day) {
    if (!ISO_DAY.test(day))
        return false;
    const [year, month, date] = day.split("-").map(Number);
    const round = new Date(0);
    round.setUTCFullYear(year, month - 1, date);
    return round.getUTCFullYear() === year && round.getUTCMonth() === month - 1 && round.getUTCDate() === date;
}
/** Mirror pm-changelog by preserving the date prefix of the committer timestamp. */
export function releaseCommitDay(timestamp) {
    const day = timestamp.slice(0, 10);
    if (!isRealCalendarDay(day))
        throw new Error("Expected a committer timestamp with a real YYYY-MM-DD day");
    return day;
}
/** Recognize package-manager commands that run a script in the same manifest. */
function isScriptForward(program, subcommand) {
    return (program === "npm" && NPM_LIFECYCLE_COMMAND.test(subcommand ?? "")) || (subcommand === "run" && SCRIPT_RUNNERS.has(program)) || ((program === "npm" || program === "pnpm") && subcommand === "run-script");
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
    const subcommand = parameters[command.index]?.value;
    if (!isScriptForward(program, subcommand))
        return undefined;
    const entry = afterRunOptions(program, parameters, command.index + 1, command.optional, command.lifecycle);
    const named = subcommand === "run" || subcommand === "run-script";
    const target = named ? literalScriptName(parameters[entry.index]) : subcommand;
    // Bun also runs source files and local binaries when there is no named script.
    if (program === "bun" && target !== undefined && !scriptNames?.has(target)
        && (BUN_SOURCE_FILE.test(target) || GENERATOR_TARGET.test(target)))
        return undefined;
    const tail = parameters.slice(named ? entry.index + 1 : entry.index);
    if (program !== "npm") {
        const separator = tail[0]?.value === "--" ? tail[0] : undefined;
        if (program === "pnpm")
            return { target, runner: program, optional: entry.optional, args: tail, forwardedSeparator: separator };
        return { target, runner: program, optional: entry.optional, args: separator ? tail.slice(1) : tail };
    }
    const separator = tail.findIndex(token => token.value === "--" && !token.unresolved);
    // An older preparation saved this flag on npm itself. npm consumes it,
    // so it contributes no generator argv until preparation repairs the hook.
    const legacyFlag = separator < 0 && tail.at(-1)?.value === INCLUDE_EMPTY_FLAG;
    const flags = separator < 0 ? (legacyFlag ? tail.slice(0, -1) : tail)
        : tail.slice(0, separator).filter(token => token.value !== INCLUDE_EMPTY_FLAG);
    const settings = afterNpmRunOptions(flags, 0, entry.optional, entry.lifecycle);
    return { target, runner: program, lifecycle: settings.lifecycle, optional: settings.optional && target !== "start" && target !== "restart", unsupported: flags[settings.index]?.value,
        args: separator < 0 ? [] : tail.slice(separator + 1), npmSeparator: tail[separator] };
}
/** Read the active setting from either a simple policy or the richer npm environment. */
export function activeNpmLifecycle(policy) {
    return typeof policy === "object" ? policy.active : policy;
}
/** Read the policy npm falls back to when it clears its exported environment key. */
function configuredNpmLifecycle(policy) {
    return typeof policy === "object" ? policy.configured : policy;
}
/** Convert npm's literal ignore-scripts setting into lifecycle execution. */
function lifecycleSetting(value) {
    if (value === true || value === "true")
        return false;
    if (value === false || value === "false")
        return true;
    return "unknown";
}
/** Collect the nonempty environment aliases npm can read as ignore-scripts. */
export function npmLifecycleEnvironmentValues(environment) {
    return Object.entries(environment).filter(([name, value]) => /^npm_config_ignore[-_]scripts$/i.test(name) && value !== "")
        .map(([, value]) => value);
}
/** Resolve CLI-independent npm configuration from the workflow env and project .npmrc. */
export function npmLifecycle(projectConfig, environment = {}) {
    const settings = npmLifecycleEnvironmentValues(environment).map(lifecycleSetting);
    if (settings.length > 0)
        return settings.every(setting => setting === settings[0]) ? settings[0] : "unknown";
    let setting = "unknown";
    for (const line of projectConfig?.split(/\r?\n/) ?? []) {
        if (/^\s*\[[^\]]*\]\s*$/.test(line))
            break;
        const entry = /^\s*(["']?)ignore-scripts(\[\])?\1\s*(?:=\s*(.*)|[;#].*)?$/.exec(line);
        if (!entry)
            continue;
        const raw = entry[3]?.trim();
        const literal = raw?.replace(/^(["'])(true|false)\1$|^(true|false)\s*(?:[;#].*)?$/, "$2$3");
        setting = entry[2] ? "unknown" : lifecycleSetting(literal ?? true);
    }
    return setting;
}
/** Read command-prefix npm settings, including aliases that survive clearing the canonical key. */
function lifecycleEnvironment(assignments) {
    const entries = new Map();
    for (const token of assignments) {
        const match = /^(npm_config_ignore[-_]scripts)=(.*)$/is.exec(token.value);
        if (match)
            entries.set(match[1], match[2]);
    }
    // Reassignment preserves the original environment entry's position. npm
    // skips empty entries and then normalizes the spelling of each key.
    const ordered = [...entries].reverse();
    const active = ordered.find(([, value]) => value !== "");
    if (entries.size === 0)
        return undefined;
    const aliases = ordered.filter(([name, value]) => name !== "npm_config_ignore_scripts" && value !== "");
    const portable = aliases.find(([name]) => !name.includes("-"));
    return {
        active: active && lifecycleSetting(active[1]),
        clearsCanonical: entries.get("npm_config_ignore_scripts") === "",
        clearsAlias: ordered.some(([name, value]) => name !== "npm_config_ignore_scripts" && value === ""),
        alias: aliases[0] && lifecycleSetting(aliases[0][1]),
        portableAlias: portable && lifecycleSetting(portable[1]),
    };
}
/** Resolve this npm command and the environment it exports to its scripts. */
function forwardedLifecycle(override, inherited, inheritedFallback, environment) {
    // Some script shells drop environment names containing hyphens.
    const clearsFallback = environment?.clearsAlias && (environment.clearsCanonical || environment.active === undefined);
    const fallback = clearsFallback ? "unknown" : inheritedFallback;
    const retained = environment?.alias ?? fallback;
    const portable = environment?.portableAlias ?? fallback;
    const configured = retained === portable ? portable : "unknown";
    const ambient = environment?.active ?? (environment?.clearsCanonical ? configured : environment?.clearsAlias ? "unknown" : inherited);
    // npm exports ignore-scripts=true. An override back to false writes
    // an empty value unless the environment already supplied false.
    if (override !== true || ambient === true)
        return { enabled: override ?? ambient, nested: override ?? ambient, configured };
    return { enabled: true, nested: ambient === "unknown" && configured !== true ? "unknown" : configured, configured };
}
/** Resolve the same graph used by preparation and continuation, including comment-only hooks. */
export function resolveChangelogHooks(scripts, hooks, lifecycle = "unknown") {
    const all = new Map(Object.entries(scripts ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : ""]));
    const resolved = new Map();
    visitChangelogScriptCommands(all, ({ effective, names, name }) => { changelogInvocation(effective, names, name); }, hooks, resolved, undefined, { lifecycle });
    return resolved;
}
/** Administrative package operands are dependency names rather than commands. */
function isPackageAdmin(program, parameters) {
    const name = basename(program.value);
    if (program.unresolved || !PACKAGE_MANAGERS.has(name))
        return false;
    const subcommand = parameters[afterRunOptions(name, parameters, 0).index];
    return subcommand !== undefined && !subcommand.unresolved && PACKAGE_ADMIN_COMMANDS.has(subcommand.value)
        && (name !== "bun" || BUN_SUBCOMMANDS.has(subcommand.value));
}
/** Detect a literal script runner and generator-writing target inside an opaque command. */
function scriptReferenceWords(words) {
    const nested = words.flatMap(word => word.value.split(/[^\w.:-]+/));
    const runner = nested.some(word => SCRIPT_RUNNERS.has(word)) && nested.some(word => word === "run" || word === "run-script");
    return runner || (nested.includes("npm") && nested.some(word => NPM_LIFECYCLE_COMMAND.test(word))) ? nested : [];
}
/** Preserve exact script names in argv and in literal payloads of opaque commands. */
function candidateScriptRunners(words) {
    const commands = [words];
    for (const command of commands) {
        for (const word of command) {
            if (word.quoted && !word.unresolved && /\b(?:npm|pnpm|bun)\b/.test(word.value)) {
                commands.push(...parseReleaseHook(word.value).commands);
            }
        }
    }
    return commands.flatMap(command => command.flatMap((word, index) => !word.unresolved && SCRIPT_RUNNERS.has(basename(word.value)) ? [command.slice(index)] : []));
}
/** A Bun subcommand can name a local script without an explicit run keyword. */
function bunShorthand(program, args) {
    if (basename(program.value) !== "bun")
        return undefined;
    const target = literalScriptName(args[afterRunOptions("bun", args, 0).index]);
    return target && !BUN_SUBCOMMANDS.has(target) ? target : undefined;
}
/** Follow script references even in a chain that contains opaque commands. */
function referencesWriter(words, scriptNames, seen) {
    if (!(scriptNames instanceof HookScriptNames))
        return false;
    return candidateScriptRunners(words).some(([program, ...args]) => {
        const target = scriptForward(basename(program.value), args, scriptNames)?.target ?? bunShorthand(program, args);
        return target !== undefined && scriptNames.mayInvoke(target, seen);
    }) || scriptReferenceWords(words).some(word => scriptNames.mayInvoke(word, seen));
}
/** Locate the executable or the file selected by a supported Node/Bun adapter. */
function generatorEntryIndex([program, ...parameters]) {
    const name = basename(program.value);
    if (name !== "node" && name !== "node.exe" && name !== "bun")
        return 0;
    let index = name === "bun" ? afterRunOptions(name, parameters, 0).index : 0;
    if (name === "bun" && parameters[index]?.value === "run")
        index = afterRunOptions(name, parameters, index + 1).index;
    while (parameters[index]?.value === "--enable-source-maps" || BUN_LOCAL_RUN_SWITCHES.has(parameters[index]?.value))
        index++;
    return index + 1;
}
/** Recognize direct generator invocations and the supported Node/Bun adapters. */
function generatorCommand(invocation) {
    const index = generatorEntryIndex(invocation);
    const file = invocation[index];
    return file && !file.unresolved && GENERATOR_TARGET.test(file.value) ? invocation.slice(index) : undefined;
}
/** Check whether a copy can resolve to the root changelog, including directory targets. */
function copyWritesChangelog(args) {
    const operands = [];
    let options = true;
    let directory;
    let directoryValue = "";
    let noTargetDirectory = false;
    let backups = false;
    let backupMode;
    let suffix;
    for (let index = 0; index < args.length; index++) {
        const word = args[index];
        if (options && /^-.+/.test(word.value)) {
            if (word.value === "--")
                options = false;
            // The first short option that takes a value consumes the rest of its word.
            const operandOption = /^-[^-St]*[St]/.exec(word.value)?.[0];
            const equals = word.value.indexOf("=");
            const name = equals < 0 ? word.value : word.value.slice(0, equals);
            const suffixOption = name.startsWith("--su") && "--suffix".startsWith(name);
            const backupOption = name.startsWith("--b") && "--backup".startsWith(name);
            const directoryOption = name.startsWith("--t") && "--target-directory".startsWith(name)
                ? (equals < 0 ? name : word.value.slice(0, equals + 1))
                : (operandOption?.endsWith("t") ? operandOption : undefined);
            if (directoryOption) {
                const inline = directoryOption.endsWith("=") || directoryOption.length < word.value.length;
                directory = inline ? word : args[++index];
                if (!directory)
                    return false;
                directoryValue = inline ? word.value.slice(directoryOption.length) : directory.value;
            }
            else if (suffixOption || operandOption?.endsWith("S")) {
                backups = true;
                const offset = operandOption?.length ?? (equals < 0 ? word.value.length : equals + 1);
                const inline = (suffixOption && equals >= 0) || word.value.length > offset;
                const value = inline ? word : args[++index];
                if (!value)
                    return false;
                suffix = value.unresolved || hasBraceExpansion(value) ? undefined
                    : inline ? word.value.slice(offset) : value.value;
            }
            if (backupOption || /^-[^-]*b/.test(operandOption ?? word.value))
                backups = true;
            if (backupOption && equals >= 0)
                backupMode = word.value.slice(equals + 1);
            if (word.value === "--no-target-directory" || /^-[^-St]*T/.test(operandOption ?? word.value))
                noTargetDirectory = true;
        }
        else
            operands.push(word);
    }
    const simpleBackup = backups && !/^(?:none|off|numbered|t)$/.test(backupMode ?? "");
    const writes = (path) => posix.normalize(path) === "CHANGELOG.md"
        || (simpleBackup && (suffix === undefined ? "CHANGELOG.md".startsWith(posix.normalize(path))
            : posix.normalize(path + (suffix || "~")) === "CHANGELOG.md"));
    if (directory)
        return copyDirectoryWritesChangelog(directory, directoryValue, operands, writes);
    const destination = operands.at(-1);
    return operands.length >= 2 && (destination.unresolved || hasBraceExpansion(destination)
        || writes(destination.value)
        || (!noTargetDirectory && copyDirectoryWritesChangelog(destination, destination.value, operands.slice(0, -1), writes)));
}
/** A directory copy uses each source basename under its target directory. */
function copyDirectoryWritesChangelog(directory, value, sources, writes) {
    return (directory.unresolved || hasBraceExpansion(directory) || (value !== "" && posix.join(value, "CHANGELOG.md") === "CHANGELOG.md"))
        && sources.some(source => source.unresolved || hasBraceExpansion(source) || writes(posix.basename(source.value)));
}
/** Look for a reachable generator without interpreting an opaque command as executable argv. */
function canReachGenerator(words, names, seen, writing = false, lifecycle = "unknown", configured = lifecycle) {
    if (writing && redirectsChangelog(words))
        return true;
    const assignments = [];
    const invocation = releaseHookCommand(words, undefined, assignments);
    if (!invocation)
        return hookSyntaxProblem(words) !== undefined && words.some(mentionsGenerator);
    const [program, ...parameters] = invocation;
    const name = basename(program.value);
    if (writing && name === "tee") {
        return parameters.some(word => word.unresolved || hasBraceExpansion(word) || posix.normalize(word.value) === "CHANGELOG.md");
    }
    if (writing && name === "cp")
        return copyWritesChangelog(parameters);
    if (DATA_CONSUMERS.has(name) || isPackageAdmin(program, parameters))
        return false;
    const forward = scriptForward(name, parameters, names);
    if (forward?.target && names instanceof HookScriptNames) {
        const isNpm = forward.runner === "npm";
        const environment = isNpm ? lifecycleEnvironment(assignments) : undefined;
        const policy = forwardedLifecycle(forward.lifecycle, lifecycle, configured, environment);
        return names.sequence(forward.target, !isNpm || policy.enabled !== false).some(target => names.canGenerate(target, seen, writing, target === forward.target ? forward.args : [], policy.nested, policy.configured))
            || (!writing && forward.args.some(mentionsGenerator));
    }
    const generator = generatorCommand(invocation);
    if (generator)
        return !writing || writesChangelog(generator);
    return words.some(mentionsGenerator) || referencesWriter(words, names, seen);
}
/** Find definite or possible Bash writes to the changelog, including on helper commands. */
function redirectsChangelog(words, traversalOnly = false) {
    return words.some((word, index) => {
        const redirect = shellRedirection(word);
        if (!redirect?.operator.includes(">"))
            return false;
        const target = redirect.joined ? word : words[index + 1];
        if (target && (target.unresolved || hasBraceExpansion(target)))
            return !traversalOnly;
        const destination = redirect.joined ? word.value.slice(redirect.operator.length) : target?.value ?? "";
        return posix.normalize(destination) === "CHANGELOG.md"
            && (!traversalOnly || destination.split("/").includes(".."));
    });
}
/** Read file redirects without confusing their operands with executable argv. */
function* hookRedirects(words) {
    for (let index = 0; index < words.length; index++) {
        const word = words[index];
        const redirect = shellRedirection(word);
        if (!redirect)
            continue;
        const target = redirect.joined ? word : words[index + 1];
        if (!target || (!redirect.joined && shellRedirection(target)))
            continue;
        const path = redirect.joined ? target.value.slice(redirect.operator.length) : target.value;
        if (!redirect.joined)
            index++;
        if (path)
            yield { operator: redirect.operator, path: hookFilePath(path, target.unresolved) };
    }
}
/** Give relative path aliases and the two simple variable spellings the same identity. */
function hookFilePath(path, unresolved) {
    return posix.normalize(unresolved ? path.replace(/\$\{([A-Za-z_]\w*)\}/g, "$$$1") : path);
}
/** Locate the script file an interpreter reads before any of the script's own arguments. */
function interpretedHookFile(name, args, words) {
    const shell = name !== "eval" && isShellEvaluator(name);
    let index = 0;
    for (; args[index]?.value.startsWith("-"); index++) {
        const flag = args[index].value;
        if (flag === "--") {
            index++;
            break;
        }
        if (flag === "-")
            break;
        if (shell) {
            if (/^-[^-]*[cn]/.test(flag))
                return undefined;
            if (/^-[^-]*s/.test(flag)) {
                index = args.length;
                break;
            }
            if (/^-[^-]*[oO]$/.test(flag))
                index++;
        }
        else {
            if (/^(?:-[cep]|--(?:check|eval|print)(?:=|$))/.test(flag))
                return undefined;
            if (NODE_OPTION_OPERANDS.has(flag))
                index++;
        }
    }
    const file = args[index];
    if (file && file.value !== "-")
        return hookFilePath(file.value, file.unresolved);
    const input = [...hookRedirects(words)].reverse().find(({ operator }) => /^(?:0)?</.test(operator));
    return input && /^(?:0)?(?:<|<>)$/.test(input.operator) ? input.path : undefined;
}
/** Detect file execution while allowing a committed helper to read paths as ordinary arguments. */
function executedHookFile(words, written) {
    const invocation = releaseHookCommand(words);
    if (!invocation)
        return undefined;
    const [program, ...args] = invocation;
    if (program.value.includes("/")) {
        const file = hookFilePath(program.value, program.unresolved);
        if (!posix.isAbsolute(file) || written.has(file))
            return file;
    }
    const name = basename(program.value);
    if (program.value === "source" || program.value === ".") {
        const file = args[args[0]?.value === "--" ? 1 : 0];
        return file && hookFilePath(file.value, file.unresolved);
    }
    if (name === "node" || name === "node.exe" || (name !== "eval" && isShellEvaluator(name)))
        return interpretedHookFile(name, args, words);
    return undefined;
}
/** Refuse a redirect-to-execution path, including paths spanning loop iterations. */
function generatedHookProblem(words, written, recordWrites = true, loopReads) {
    const problem = (file) => "Cannot execute generated release hook file " + JSON.stringify(file) + ". Commit the script to the repository instead";
    if (written.size || loopReads) {
        const file = executedHookFile(words, written);
        if (file !== undefined) {
            if (written.has(file))
                return problem(file);
            loopReads?.add(file);
        }
    }
    if (!recordWrites)
        return undefined;
    for (const { operator, path } of hookRedirects(words)) {
        if (/^(?:\d*(?:>>?|>\||<>)|&>>?)$/.test(operator) || (operator === ">&" && !/^(?:\d+|-)$/.test(path))) {
            if (loopReads?.has(path))
                return problem(path);
            written.add(path);
        }
    }
    return undefined;
}
/** Executions in one loop can follow writes from any of its iterations. */
function repeatedHookReads(words, loops) {
    const scope = releaseLoopScope(words);
    if (!scope)
        return undefined;
    let reads = loops.get(scope);
    if (!reads) {
        reads = new Set();
        loops.set(scope, reads);
    }
    return reads;
}
/** Keep alternative bodies independent while retaining condition and joined writes. */
function advanceHookWriteBranches(words, written, branches) {
    for (const word of words) {
        if (!word.releaseKeyword)
            continue;
        if (word.value === "if") {
            branches.push({ condition: new Set(written), completed: new Set() });
            continue;
        }
        const branch = branches.at(-1);
        if (!branch)
            continue;
        if (word.value === "then") {
            branch.condition = new Set(written);
        }
        else if (word.value === "elif" || word.value === "else") {
            for (const path of written)
                branch.completed.add(path);
            written.clear();
            for (const path of branch.condition)
                written.add(path);
        }
        else if (word.value === "fi") {
            branches.pop();
            for (const path of branch.completed)
                written.add(path);
        }
    }
}
/** Outside a release hook, trace only redirects carrying a generator or a known script forward. */
export function generatedWriterProblem(words, written, heredoc, names, seen) {
    const payload = heredoc ? [heredoc] : ["echo", "printf"].includes(words[0].value) ? words : [];
    const writer = payload.some(mentionsGenerator) || referencesWriter(payload, names, seen);
    return generatedHookProblem(words, written, writer);
}
/** Classify only the generator outputs that may write the changelog. */
function writesChangelog([program, ...args]) {
    const { output, outputWord, invalidOption, check, stdout, positions } = changelogOutputTarget(args);
    const summary = !program.value.endsWith("pm-changelog.ts") && positions.some(index => args[index].value === "--summary");
    return !summary && !check && !stdout
        && (invalidOption !== undefined || output.unresolved === true || (outputWord !== undefined && hasBraceExpansion(outputWord))
            || /(?:^|\/)CHANGELOG\.md$/.test(posix.normalize(output.value)));
}
/** Project selectors on runners precede the delimiter that separates generator arguments. */
function runnerProjectOption([program, ...args]) {
    const name = basename(program.value);
    if (!SCRIPT_RUNNERS.has(name))
        return undefined;
    const separator = args.findIndex(word => word.value === "--");
    const flags = separator < 0 ? args : args.slice(0, separator);
    if (!flags.some(word => isScriptForward(name, word.value) || (name === "npm" && word.value === "exec")))
        return undefined;
    return flags.find(word => RELEASE_PROJECT_OPTION.test(word.value))?.value;
}
/** Find the first set switch outside the shell modes modeled by the hook grammar. */
function unsupportedSetSwitch(args) {
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag.unresolved)
            return "set " + flag.value;
        if (flag.value === "--" || !/^[+-]./.test(flag.value))
            break;
        if (/^[+-][eu]+$/.test(flag.value))
            continue;
        if (!/^[+-][eu]*o[eu]*$/.test(flag.value))
            return "set " + flag.value;
        const option = args[++i];
        if (option?.unresolved)
            return "set " + flag.value;
        if (option && !/^(?:errexit|nounset|pipefail)$/.test(option.value))
            return "set " + flag.value + " " + option.value;
    }
    return undefined;
}
/** Expose the shell command beneath command and builtin prefixes. */
function unwrapShellBuiltin(words) {
    let command = releaseHookCommand(words);
    while (command?.[0].value === "builtin") {
        command = releaseHookCommand(command.slice(command[1]?.value === "--" ? 2 : 1));
    }
    return command;
}
/** A release hook cannot change shell parsing, builtin lookup, or pipeline isolation. */
function unsupportedShellSemantics(words) {
    const first = shellCommandStart(words);
    if (first < 0)
        return undefined;
    const command = unwrapShellBuiltin(words.slice(first));
    if (!command)
        return undefined;
    const [program, ...args] = command;
    if (program.value === "set")
        return unsupportedSetSwitch(args);
    return /^(?:shopt|enable|alias|source|\.)$/.test(program.value) ? program.value : undefined;
}
/** Locate the command after any shell list introducers. */
function shellCommandStart(words) {
    const inCondition = isReleaseLoopCondition(words);
    return words.findIndex(word => word.quoted || (!/^(?:if|then|elif|else|do|\{|!)$/.test(word.value)
        && !(inCondition && /^(?:while|until)$/.test(word.value))));
}
/** Shell edits apply to later commands in this script and to their descendants. */
function shellContextChange(words) {
    const first = shellCommandStart(words);
    if (first < 0)
        return undefined;
    const inner = withoutRedirections(words.slice(first));
    const head = inner[0];
    if (!head)
        return undefined;
    const command = /^(?:builtin$|command$|time$|[A-Za-z_]\w*\+?=)/.test(head.value) ? unwrapShellBuiltin(inner) ?? inner : inner;
    const [program, ...args] = command;
    const name = basename(program.value);
    if (/^(?:cd|pushd|popd)$/.test(name))
        return { construct: name, directory: true };
    if (/^(?:export|unset|declare|typeset|readonly|local)$/.test(name)) {
        if (/^(?:declare|typeset|readonly|local)$/.test(name) && args.some(word => /^-[a-zA-Z]*p[a-zA-Z]*$/.test(word.value)))
            return undefined;
        const variable = args.map(word => RELEASE_CONTEXT_VARIABLE.exec(word.value)?.[0]).find(Boolean);
        if (variable)
            return { construct: name + " " + variable };
    }
    if (command.every(word => isShellAssignment(word))) {
        const variable = RELEASE_CONTEXT_VARIABLE.exec(program.value)?.[0]
            ?? args.map(word => RELEASE_CONTEXT_VARIABLE.exec(word.value)?.[0]).find(Boolean);
        if (variable)
            return { construct: variable + " assignment" };
    }
    return undefined;
}
/** Find context changes made for a single invocation. */
function commandContextChanges(words) {
    const context = [];
    const assignments = [];
    const invocation = releaseHookCommand(words, context, assignments);
    // The npm forward resolver models this assignment, including dynamic values.
    if (invocation && basename(invocation[0].value) === "npm" && scriptForward("npm", invocation.slice(1))) {
        const known = lifecycleEnvironment(assignments);
        if (known !== undefined) {
            const setting = /^(?:env )?npm_config_ignore[-_]scripts assignment$/i;
            for (let i = context.length - 1; i >= 0; i--)
                if (setting.test(context[i].construct))
                    context.splice(i, 1);
        }
    }
    const project = invocation && runnerProjectOption(invocation);
    if (project)
        context.push({ construct: project, directory: true });
    const generator = invocation && generatorCommand(invocation);
    if (generator) {
        const args = generator.slice(1);
        if (optionPositions(args).some(index => args[index].value.split("=", 1)[0] === "--pm-cwd"))
            context.push({ construct: "--pm-cwd", directory: true });
    }
    return context;
}
/** Carry persistent shell changes forward and prefer directory edits over variable edits. */
function nextShellContext(words, preceding, effective = words) {
    const change = isIsolatedReleaseCommand(words) ? undefined : shellContextChange(effective);
    return change?.directory ? change : preceding ?? change;
}
/** Apply one context rule to the shell path and the effective argv at each script depth. */
function releaseContextProblem(words, names, preceding, hookPath = true) {
    if (hookPath) {
        if (words.some(isContinuedDescriptor))
            return "Continued descriptor redirection" + SCRIPT_FILE_ADVICE;
        const loopChange = isReleaseLoopCondition(words) && !isIsolatedReleaseCommand(words) ? shellContextChange(words) : undefined;
        if (loopChange?.directory)
            return "Directory change " + loopChange.construct + " in a loop condition" + SCRIPT_FILE_ADVICE;
    }
    const shell = hookPath ? unsupportedShellSemantics(words) : undefined;
    if (shell)
        return describeReleaseContextChange(shell);
    const changes = commandContextChanges(words);
    if (preceding)
        changes.unshift(preceding);
    const change = changes.find(context => context.directory ? needsReleaseProject(words, names) : canReachGenerator(words, names));
    return change && describeReleaseContextChange(change.construct);
}
/** Return the generator word and arguments, or refuse a possible hook behind an unknown wrapper. */
function changelogInvocation(words, scriptNames, hook = "standalone", audit = false) {
    const invocation = releaseHookCommand(words);
    const mentions = words.some(mentionsGenerator);
    const problem = hookSyntaxProblem(words);
    if (problem && (mentions || referencesWriter(words, scriptNames))) {
        const generatorArgs = invocation && generatorCommand(invocation)?.slice(1);
        const versionName = generatorArgs && optionPositions(generatorArgs).map(index => generatorArgs[index]).find(unresolvedVersionOption);
        if (versionName)
            refuseUnresolvedVersionOption(versionName);
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
    const shorthand = bunShorthand(program, parameters);
    if (shorthand && scriptNames instanceof HookScriptNames && scriptNames.mayInvoke(shorthand)) {
        refuseHook(`Ambiguous Bun shorthand for local release script. Use bun run ${shorthand}`);
    }
    const forward = scriptForward(name, parameters, scriptNames);
    if (forward?.runner === "pnpm" && forward.target && scriptNames instanceof HookScriptNames
        && ["pre", "post"].some(prefix => scriptNames.canGenerate(prefix + forward.target))) {
        refuseHook("Configuration-dependent pnpm lifecycle writer for " + JSON.stringify(forward.target));
    }
    if (forward?.unsupported && (mentions || (forward.target && scriptNames instanceof HookScriptNames && scriptNames.mayInvoke(forward.target)))) {
        refuseHook("Unsupported npm run option or positional argument " + JSON.stringify(forward.unsupported) + " before --");
    }
    if (forward && (!audit || (forward.target !== undefined && (forward.optional || scriptNames.has(forward.target)))))
        return undefined;
    const [subcommand] = parameters;
    if (isPackageAdmin(program, parameters))
        return undefined;
    if (program.unresolved && mentionsGenerator(program))
        refuseHook("Indirect pm-changelog executable " + JSON.stringify(program.value));
    const generator = generatorCommand(invocation);
    if (generator) {
        const args = generator.slice(1);
        if (args.some(hasBraceExpansion) && (hasVersionInput(args) || args.some(({ value }) => /^--date(?:[-=]|$)/.test(value)))) {
            refuseHook("Unquoted brace expansion in versioned generator options" + SCRIPT_FILE_ADVICE);
        }
        assertSingleWordGeneratorOperands(args);
        return generator;
    }
    if (name === "npm" && subcommand?.value === "exec" && mentions) {
        refuseHook("Unsupported npm exec options before pm-changelog. Use npm exec -- pm-changelog in the current project");
    }
    if (name === "command") {
        const lookup = parameters.find(word => word.value !== "-p");
        if (lookup && !program.unresolved && !lookup.unresolved && /^-p*[vV][pvV]*$/.test(lookup.value))
            return undefined;
    }
    else if (DATA_CONSUMERS.has(name))
        return undefined;
    if (mentions || referencesWriter(words, scriptNames))
        refuseHook(describeUnsupportedReleaseHook(`Unrecognized wrapper or executable ${JSON.stringify(program.value)} before possible pm-changelog command`, hook)
            + " Use a direct pm-changelog invocation.");
    return undefined;
}
/** Check indirect references inside unknown wrappers only for dependencies that can reach a generator. */
class HookScriptNames extends Set {
    scripts;
    allowUnresolvedProjects;
    constructor(scripts, allowUnresolvedProjects = true) {
        super(scripts.keys());
        this.scripts = scripts;
        this.allowUnresolvedProjects = allowUnresolvedProjects;
    }
    /** npm skips empty implicit lifecycle scripts and passes args only to main. */
    sequence(name, lifecycle) {
        return lifecycle ? [`pre${name}`, name, `post${name}`].filter(script => script === name || this.scripts.get(script)?.text.trim()) : [name];
    }
    /** An opaque npm invocation may run the named script and both lifecycle siblings. */
    mayInvoke(name, seen = new Set()) {
        return this.has(name) && this.sequence(name, true).some(script => this.canGenerate(script, seen));
    }
    /** Follow literal script references without recursively evaluating the wrapper's shell payload. */
    canGenerate(name, seen = new Set(), writing = false, args = [], lifecycle = "unknown", configured = lifecycle) {
        if (!this.has(name) || seen.has(name))
            return false;
        const ancestors = new Set(seen).add(name);
        const { text, commands, spans, heredocBodies } = this.scripts.get(name);
        const written = new Set();
        const recipient = args.length ? commandReceivingArguments(text, commands, spans) : undefined;
        let preceding;
        for (const command of commands) {
            const words = command === recipient ? [...command, ...args] : command;
            if (generatedWriterProblem(words, written, heredocBodies.get(command), this, ancestors) || canReachGenerator(words, this, ancestors, writing, lifecycle, configured))
                return true;
            if (!this.allowUnresolvedProjects)
                continue;
            if ((preceding?.directory || commandContextChanges(words).some(context => context.directory))
                && maySelectUnresolvedScript(words, this))
                return true;
            preceding = nextShellContext(command, preceding, words);
        }
        return false;
    }
}
/** A project change can resolve a literal script missing from the inspected manifest. */
function maySelectUnresolvedScript(words, names) {
    const invocation = releaseHookCommand(words);
    if (!invocation)
        return false;
    const [program, ...parameters] = invocation;
    if (DATA_CONSUMERS.has(basename(program.value)) || isPackageAdmin(program, parameters))
        return false;
    return candidateScriptRunners(words).some(command => {
        const [program, ...args] = command;
        const forward = scriptForward(basename(program.value), args, names);
        return (forward?.target !== undefined && !names?.has(forward.target)) || runnerProjectOption(command) !== undefined;
    });
}
/** Whether a non-root step could run a generator or delegate to its local package scripts. */
export function needsReleaseProject(words, names) {
    return canReachGenerator(words, names) || maySelectUnresolvedScript(words, names);
}
/** Read generator arguments during an audit, where only declared forwards are trusted. */
export function changelogArguments(words, scriptNames, hook = "standalone") {
    return changelogInvocation(words, scriptNames, hook, true)?.slice(1);
}
/** Identify the original command that would receive argv appended by a script runner. */
function commandReceivingArguments(text, commands, spans) {
    const marker = "__pm_ops_forwarded_argument__";
    const appended = parseReleaseHook(text + " " + marker);
    const recipient = appended.commands.find(words => words.length > 1 && words.at(-1).value === marker
        && !(words.length === 2 && words[0].releaseKeyword)
        && appended.spans.get(words.at(-1))?.start === text.length + 1);
    if (!recipient)
        return undefined;
    const start = appended.spans.get(recipient[0]).start;
    return commands.find(words => spans.get(words[0])?.start === start);
}
const HEADING_ONLY_ARGUMENT = /^(?:--release-version-from-package|--date-from-version|--date-fallback(?:=\d{4}-\d{2}-\d{2})?|--include-empty|--stdout|\d{4}-\d{2}-\d{2})$/;
/** A standard generator with default paths and arguments leaves npm configuration alone. */
function mayChangeNpmConfig([program, ...args]) {
    if (args.length === 0 && /^(?::|true|false)$/.test(program.value))
        return false;
    return program.value !== "pm-changelog" || args.some(arg => !HEADING_ONLY_ARGUMENT.test(arg.value));
}
/** Find versioned generator options on a command that expands an inherited assignment. */
function forwardedBindingProblem(words, bindings) {
    if (!bindings.size)
        return undefined;
    const invocation = releaseHookCommand(words);
    if (!invocation)
        return undefined;
    const entry = generatorEntryIndex(invocation);
    const args = invocation.slice(entry + 1);
    const positions = optionPositions(args);
    const selectors = [];
    if (positions.some(index => INDIRECT_RELEASE_OPTIONS.has(args[index].value.split("=", 1)[0]))) {
        selectors.push(...invocation.slice(0, 1), ...invocation.slice(entry, entry + 1));
    }
    if (generatorCommand(invocation)) {
        for (const index of positions) {
            const word = args[index];
            const policy = INDIRECT_RELEASE_OPTIONS.has(word.value.split("=", 1)[0]);
            if (policy || (word.unresolved && !literalOptionName(word)))
                selectors.push(word);
            if (policy && VALUE_OPTIONS.has(word.value) && args[index + 1])
                selectors.push(args[index + 1]);
        }
    }
    const binding = selectors.map(word => inheritedVariable(word, bindings)).find(Boolean);
    return binding && ("Generator binding through variable assignment " + binding + " crosses an npm run forward" + SCRIPT_FILE_ADVICE);
}
/** Scan local scripts in invocation order and join forwarded argv at its actual destination. */
export function visitChangelogScriptCommands(scripts, inspect, hooks, resolved, entryPoints = new Set(), npm = { lifecycle: "unknown" }) {
    const parsed = new Map([...scripts].map(([name, text]) => {
        const scope = npm.workflowSteps?.has(name) ? "workflow" : "hook";
        return [name, { text, scope, ...parseReleaseHook(text, scope) }];
    }));
    const names = new HookScriptNames(parsed);
    const knownWriters = new HookScriptNames(parsed, false);
    const targeted = new Set();
    /** Read the local script target, arguments, and command-prefix assignments. */
    function forwardToScript(words) {
        const assignments = [];
        const command = releaseHookCommand(words, undefined, assignments);
        if (!command)
            return undefined;
        const [program, ...parameters] = command;
        const forward = scriptForward(basename(program.value), parameters, names);
        if (!forward)
            return undefined;
        return { ...forward, bindings: assignments.map(word => word.value.split(/[+=]/, 1)[0]),
            environment: forward.runner === "npm" ? lifecycleEnvironment(assignments) : undefined };
    }
    const entryLifecycles = new Map();
    const visited = new Set();
    const reportedConstructs = new Set();
    const withoutArgs = new Map();
    const recipients = new Map();
    const forwardedSeparators = new WeakSet();
    /** Walk one invocation, preserving token identity back to each supplying script. */
    function visit(name, args, parents, policy, releasePath, bindings = new Set(), uncertainLifecycle = false, config = { reloadable: activeNpmLifecycle(policy) !== false, mayHaveChanged: false }, written = new Set(), inheritedLoopReads, configuredHook = false) {
        const lifecycle = activeNpmLifecycle(policy);
        const configured = configuredNpmLifecycle(policy);
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
        const { text, commands, spans, scope } = script;
        const step = npm.workflowSteps?.get(name);
        const job = step?.containerJob;
        const containerCommand = job !== undefined && unsupportedReleaseConstruct("container job", scope) && commands.find(words => {
            const target = forwardToScript(words)?.target;
            return (target !== undefined && entryPoints.has(target)) || needsReleaseProject(words, knownWriters);
        });
        const construct = containerCommand ? {
            words: containerCommand,
            problem: describeUnsupportedReleaseHook("container job " + JSON.stringify(job), forwardToScript(containerCommand)?.target ?? job),
        } : (releasePath || scope === "workflow") && releaseHookConstructProblem(commands, text, spans, step?.label ?? name, scope);
        if (construct) {
            if (hooks)
                throw new Error(construct.problem);
            if (!reportedConstructs.has(name)) {
                const { words, problem: contextProblem } = construct;
                inspect({ parents, name, names, text, words, effective: words, spans, forwardedSeparators: [], contextProblem });
                reportedConstructs.add(name);
            }
            visited.add(name);
            return;
        }
        let recipient;
        if (args.length > 0) {
            if (!recipients.has(name))
                recipients.set(name, commandReceivingArguments(text, commands, spans));
            recipient = recipients.get(name);
        }
        const checkContext = releasePath || knownWriters.canGenerate(name)
            || (recipient !== undefined && canReachGenerator([...recipient, ...args], knownWriters));
        const writtenCount = written.size;
        const cacheKey = args.length === 0 && !inheritedLoopReads
            ? JSON.stringify([checkContext, configuredHook, lifecycle, configured, uncertainLifecycle, config, name, [...bindings].sort(), [...written].sort()])
            : undefined;
        let memo;
        if (cacheKey !== undefined) {
            const depth = hooks ? parents.length : 0;
            const cached = withoutArgs.get(cacheKey);
            if (cached && cached.depth >= depth) {
                for (const file of cached.written)
                    written.add(file);
                return;
            }
            memo = { depth, written: [] };
            withoutArgs.set(cacheKey, memo);
        }
        visited.add(name);
        const invocationNames = checkContext ? names : knownWriters;
        if (uncertainLifecycle && knownWriters.canGenerate(name, undefined, true, [], lifecycle, configured)) {
            const lifecycleProblem = `Cannot determine npm ignore-scripts for lifecycle hook ${JSON.stringify(name)} that may write CHANGELOG.md. Set npm_config_ignore_scripts on the consuming step or use an explicit npm --ignore-scripts=true/false option. A project .npmrc applies when no environment override is present; user/global npm config and external env are uncertain`;
            const contextProblem = commands.some(words => redirectsChangelog(words, true)) ? lifecycleProblem + ". " + CHANGELOG_TRAVERSAL : lifecycleProblem;
            if (hooks)
                refuseHook(contextProblem);
            const words = commands[0];
            inspect({ parents, name, names, text, words, effective: words, spans, forwardedSeparators: [], contextProblem });
            return;
        }
        resolved?.set(name, text);
        let preceding;
        let mayHaveChanged = config.mayHaveChanged;
        const branches = [];
        const loops = new Map();
        for (const words of commands) {
            // Different branches can both run across separate loop iterations.
            const loopReads = checkContext ? inheritedLoopReads ?? repeatedHookReads(words, loops) : undefined;
            if (checkContext && !loopReads)
                advanceHookWriteBranches(words, written, branches);
            const previouslyRan = mayHaveChanged;
            const effective = words === recipient ? [...words, ...args] : words;
            mayHaveChanged ||= mayChangeNpmConfig(effective);
            const forward = forwardToScript(effective);
            // pnpm passes its delimiter through verbatim. A nested runner can consume
            // it, but the generator only accepts named options.
            const separators = effective.filter(token => forwardedSeparators.has(token));
            const contextProblem = (checkContext ? generatedHookProblem(effective, written, true, loopReads) : undefined)
                ?? forwardedBindingProblem(effective, bindings)
                ?? (checkContext ? releaseContextProblem(effective, names, preceding) : undefined);
            if (checkContext)
                preceding = nextShellContext(words, preceding, effective);
            if (contextProblem) {
                if (hooks)
                    refuseHook(contextProblem);
                inspect({ parents, name, names, text, words, effective, spans, forwardedSeparators: separators, contextProblem });
                return;
            }
            inspect({ parents, name, names: invocationNames, text, words, effective, spans, forwardedSeparators: separators, configuredHook });
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
                const isNpm = forward.runner === "npm";
                const clearsCanonical = forward.environment?.clearsCanonical;
                const fallback = clearsCanonical && previouslyRan ? "unknown" : configured;
                const policy = forwardedLifecycle(forward.lifecycle, lifecycle, fallback, forward.environment);
                const inheritsSetting = forward.lifecycle === undefined && forward.environment === undefined;
                // An implicit reload can enable a sibling that preparation skipped.
                if (isNpm && checkContext && !npm.mainOnly && lifecycle === false && config.reloadable && previouslyRan && inheritsSetting
                    && names.sequence(forward.target, true).length > 1) {
                    const problem = `Cannot verify nested npm lifecycle for ${JSON.stringify(forward.target)} after an earlier command may have changed npm configuration. Use an explicit npm --ignore-scripts=true/false option`;
                    if (hooks)
                        refuseHook(problem);
                    inspect({ parents, name, names, text, words, effective, spans, forwardedSeparators: separators, contextProblem: problem });
                    return;
                }
                if (isNpm && entryPoints.has(forward.target) && collectingWorkflowEntries) {
                    const settings = entryLifecycles.get(forward.target) ?? [];
                    settings.push(policy);
                    entryLifecycles.set(forward.target, settings);
                }
                const ambient = forward.environment?.active ?? lifecycle;
                const reloadable = isNpm
                    ? clearsCanonical === true || (forward.lifecycle === true && ambient !== true) || (inheritsSetting && config.reloadable)
                    : config.reloadable;
                visitSequence(forward.target, [...parents, name], policy, checkContext, isNpm, forward.args, isNpm && forward.bindings.length ? new Set([...bindings, ...forward.bindings]) : bindings, { reloadable, mayHaveChanged: previouslyRan }, written, loopReads, configuredHook || (scope === "workflow" && entryPoints.has(forward.target)));
            }
        }
        // A cached visit must still leave its possible writes visible to the caller.
        if (memo && written.size !== writtenCount)
            memo.written = [...written];
    }
    /** Take the implicit siblings from this invocation, and pass its exported policy into their bodies. */
    function visitSequence(target, parents, policy, releasePath, isNpm, args = [], bindings, config = { reloadable: policy.nested !== false, mayHaveChanged: false }, written = new Set(), loopReads, configuredHook = releasePath && parents.length === 0) {
        for (const name of names.sequence(target, !npm.mainOnly && (!isNpm || policy.enabled !== false))) {
            const main = name === target;
            visit(name, main ? args : [], parents, { active: policy.nested, configured: policy.configured }, releasePath, bindings, isNpm && !main && policy.enabled === "unknown", config, written, loopReads, configuredHook);
            if ((main && args.length > 0) || parsed.get(name).commands.some(mayChangeNpmConfig))
                config = { ...config, mayHaveChanged: true };
        }
    }
    const { lifecycle, workflowSteps } = npm;
    let collectingWorkflowEntries = true;
    for (const [step, { lifecycle }] of workflowSteps ?? [])
        visit(step, [], [], lifecycle, false);
    collectingWorkflowEntries = false;
    const projectPolicy = { enabled: activeNpmLifecycle(lifecycle), nested: activeNpmLifecycle(lifecycle), configured: configuredNpmLifecycle(lifecycle) };
    for (const hook of hooks ?? entryPoints) {
        if (!hooks && !names.has(hook))
            continue;
        const stepPolicies = entryLifecycles.get(hook) ?? [];
        if (stepPolicies.length === 0 || npm.projectEntryPoints?.has(hook))
            visitSequence(hook, [], projectPolicy, true, true);
        for (const policy of stepPolicies) {
            visitSequence(hook, [], policy, true, true);
        }
    }
    if (hooks)
        return;
    for (const { commands } of parsed.values()) {
        for (const words of commands) {
            const forward = forwardToScript(words);
            if (forward?.target)
                targeted.add(forward.target);
        }
    }
    for (const name of names) {
        if (!entryPoints.has(name) && !targeted.has(name))
            visit(name, [], [], workflowSteps?.get(name)?.lifecycle ?? lifecycle, false);
    }
    // A disconnected cycle has no root. Its own commands still need auditing.
    for (const name of names) {
        if (!visited.has(name))
            visit(name, [], [], workflowSteps?.get(name)?.lifecycle ?? lifecycle, false);
    }
}
/** Check standalone commands against the same context rule before reading their options. */
function* standaloneHookCommands(commands, names) {
    const hookPath = commands.some(words => needsReleaseProject(words, names));
    let preceding;
    const written = new Set();
    const branches = [];
    const loops = new Map();
    for (const words of commands) {
        const loopReads = repeatedHookReads(words, loops);
        if (!loopReads)
            advanceHookWriteBranches(words, written, branches);
        const problem = generatedHookProblem(words, written, true, loopReads) ?? releaseContextProblem(words, names, preceding, hookPath);
        if (problem)
            refuseHook(problem);
        yield words;
        preceding = nextShellContext(words, preceding);
    }
}
/** Preserve option/operand boundaries, including option-shaped --pm-arg data. */
function optionPositions(args, allowOptionOperands = false) {
    const positions = [];
    for (let i = 0; i < args.length; i++) {
        positions.push(i);
        const flag = args[i].value;
        if (VALUE_OPTIONS.has(flag) && args[i + 1] && (allowOptionOperands || flag === "--pm-arg" || !args[i + 1].value.startsWith("--")))
            i++;
    }
    return positions;
}
/** A split option operand could inject a release option even in an otherwise unversioned invocation. */
function assertSingleWordGeneratorOperands(args) {
    for (const index of optionPositions(args)) {
        const flag = args[index].value;
        if (flag === "--version" || flag === "--release-version")
            continue; // The date-policy reader has a dedicated diagnostic.
        if (VALUE_OPTIONS.has(flag) && args[index + 1]?.multipleWords) {
            refuseHook("Unquoted or multiword expansion in the operand of " + flag);
        }
    }
}
/** Resolve the output, inspection flags, and argv consumed by the changelog adapter. */
export function changelogOutputTarget(args) {
    let output = { value: "CHANGELOG.md" };
    let outputWord;
    let invalidOption;
    let check = false;
    let stdout = false;
    const consumed = new Set();
    const positions = optionPositions(args);
    for (const index of positions) {
        const word = args[index];
        if (word.value === "--check" || word.value === "--stdout") {
            check ||= word.value === "--check";
            stdout ||= word.value === "--stdout";
            consumed.add(index);
            continue;
        }
        const match = /^(-o|--output)(?:=(.*))?$/s.exec(word.value);
        if (!match)
            continue;
        const target = match[2] === undefined ? args[index + 1] : { value: match[2], unresolved: word.unresolved };
        if (!target?.value || target.value.startsWith("--")) {
            invalidOption ??= match[1];
            continue;
        }
        output = target;
        outputWord = match[2] === undefined ? args[index + 1] : word;
        consumed.add(index);
        if (match[2] === undefined)
            consumed.add(index + 1);
    }
    return { output, outputWord, invalidOption, check, stdout, consumed, positions };
}
/** Decode literal date options and retain their shell words for edits. */
export function readReleaseDateOptions(args) {
    const options = [];
    for (const index of optionPositions(args)) {
        const token = args[index];
        if (unresolvedVersionOption(token))
            refuseUnresolvedVersionOption(token);
        const flag = token.value.split("=", 1)[0];
        if (flag === "--pm-arg") {
            const separate = token.value === flag;
            const operand = separate ? args[index + 1]?.value : token.value.slice(flag.length + 1);
            if (!operand)
                refuseHook("--pm-arg requires a value");
            const equals = operand.indexOf("=");
            if (separate && equals > 0 && VALUE_OPTIONS.has(operand.slice(0, equals))) {
                refuseHook("--pm-arg splits this separate option operand. Use the --pm-arg=<value> form");
            }
        }
        if (flag === "--")
            refuseHook("Unexpected delimiter -- in generator arguments");
        if (flag === OVERRIDE_DATE_FLAG)
            refuseHook("Explicit --date overrides the release heading. Remove --date and use a single release date policy");
        if ((flag === "--version" || flag === "--release-version") && (token.unresolved || (token.value === flag && args[index + 1]?.unresolved))) {
            refuseHook(`Unresolved ${flag} operand. Use --release-version-from-package or supply a literal release version`);
        }
        if (flag === "--version" || flag === "--release-version") {
            const value = token.value === flag ? args[index + 1]?.value : token.value.slice(flag.length + 1);
            if (!value || value.startsWith("--"))
                refuseHook(flag + " requires a value");
        }
        if (token.unresolved) {
            const name = literalOptionName(token);
            if (name !== undefined && name !== DATE_FLAG && name !== FALLBACK_DATE_FLAG && name !== PACKAGE_VERSION_FLAG)
                continue;
            refuseHook(`Unresolved option word in pm-changelog hook: ${JSON.stringify(token.value)}`);
        }
        if ((flag === DATE_FLAG || flag === PACKAGE_VERSION_FLAG) && token.value !== flag) {
            refuseHook("Unexpected value on the boolean " + flag);
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
    if (!hasVersionInput(args) && !args.some(({ value }) => /^--date(?:[-=]|$)/.test(value)))
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
/** Normalize calendar padding while preserving the release's sequence suffix. */
function calendarRelease(version) {
    const match = version?.trim().match(/^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(-\d+)?$/i);
    if (match) {
        const [, year, month, date, suffix = ""] = match;
        const day = `${year}-${month.padStart(2, "0")}-${date.padStart(2, "0")}`;
        // The generator validates with Date.UTC, which shifts years 0 to 99.
        if (Number(year) >= 100 && isRealCalendarDay(day))
            return { day, suffix };
    }
    throw new Error(`Cannot verify the prepared release heading for calendar version ${JSON.stringify(version)}. A valid calendar version is required. ${RETIRE_UNPUBLISHED}`);
}
/** Read the last explicit version option, which takes precedence over the manifest. */
function literalReleaseVersion(args, positions) {
    let version;
    for (const i of positions) {
        const word = args[i].value;
        const equals = word.indexOf("=");
        const flag = equals === -1 ? word : word.slice(0, equals);
        if (flag === "--version" || flag === "--release-version") {
            version = equals === -1 ? args[i + 1].value : word.slice(equals + 1);
        }
    }
    return version;
}
/** Ensure a literal version selects the same release as the stamped manifest. */
function assertReleaseCoordinate(explicit, packageVersion, advice = "") {
    if (explicit === undefined || packageVersion === undefined)
        return;
    const actual = calendarRelease(explicit);
    const expected = calendarRelease(packageVersion);
    if (actual.day + actual.suffix !== expected.day + expected.suffix) {
        throw new Error(`Prepared release version ${JSON.stringify(explicit)} does not match package release version ${JSON.stringify(packageVersion)}.${advice}`);
    }
}
/** Compare the options on one generator command with the verified merge day and release coordinate. */
function assertHeadingOptions(words, mergeDay, packageVersion, names, hook) {
    const args = changelogInvocation(words, names, hook)?.slice(1) ?? [];
    const positions = optionPositions(args);
    const policies = hookDateOptions(args);
    if (policies.length) {
        const explicit = literalReleaseVersion(args, positions);
        for (const option of policies) {
            const day = option.kind === "version" ? calendarRelease(explicit ?? packageVersion).day : option.day;
            if (day !== mergeDay) {
                throw new Error(`Prepared release heading day ${day} differs from verified merge commit day ${mergeDay}. ${RETIRE_UNPUBLISHED}`);
            }
        }
        assertReleaseCoordinate(explicit, packageVersion, " " + RETIRE_UNPUBLISHED);
    }
    assertAllTagsCutoff(args, positions, mergeDay, packageVersion, " " + RETIRE_UNPUBLISHED);
}
/** Refuse suppression of the pending heading in a versioned all-tags release. */
export function assertPendingRelease(args, positions = optionPositions(args), advice = "") {
    if (hasVersionInput(args) && positions.some(i => args[i].value === "--all-release-tags")
        && positions.some(i => /^--no-pending-release(?:=|$)/.test(args[i].value))) {
        throw new Error("--no-pending-release suppresses the candidate heading. Remove it from the versioned --all-release-tags release hook." + advice);
    }
}
/** All-tags generation uses an explicit cutoff as the pending release timestamp. */
function assertAllTagsCutoff(args, positions, headingDate, packageVersion, advice = "") {
    assertPendingRelease(args, positions, advice);
    if (!hasVersionInput(args) || !positions.some(i => args[i].value === "--all-release-tags"))
        return;
    for (const i of positions) {
        const token = args[i];
        const [flag] = token.value.split("=", 1);
        if (flag !== UNTIL_FLAG)
            continue;
        const day = headingDate || calendarRelease(literalReleaseVersion(args, positions) ?? packageVersion).day;
        const cutoff = token.value === flag ? args[i + 1]?.value : token.value.slice(flag.length + 1);
        if (!cutoff || !isRealCalendarDay(cutoff)) {
            throw new Error(`Invalid --until operand for a versioned --all-release-tags hook, expected a real YYYY-MM-DD day. Remove --until or set it to ${day}.${advice}`);
        }
        if (cutoff !== day) {
            throw new Error(`The --until day ${cutoff} overrides the prepared release heading day ${day}. Remove --until or set it to ${day}.${advice}`);
        }
    }
}
/** Refuse publication when a standalone generator's heading differs from the verified merge day. */
export function assertReleaseHeadingDate(scripts, mergeDay, packageVersion, scriptNames) {
    for (const script of scripts) {
        for (const words of standaloneHookCommands(parseSupportedReleaseHook(script).commands, scriptNames))
            assertHeadingOptions(words, mergeDay, packageVersion, scriptNames);
    }
}
/** Verify the complete generator argv from each release hook before publication. */
export function assertReleaseHookHeadingDate(scripts, hooks, mergeDay, packageVersion, lifecycle = "unknown") {
    visitChangelogScriptCommands(scripts, ({ effective, names, name }) => assertHeadingOptions(effective, mergeDay, packageVersion, names, name), hooks, undefined, undefined, { lifecycle });
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
    const { commands, spans } = parseSupportedReleaseHook(script);
    const edits = new Map();
    for (const words of standaloneHookCommands(commands, scriptNames)) {
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
/** A standalone literal redirect has no executable that can render notes. */
function literalRedirectOnly(words) {
    let index = words.findIndex(word => !word.releaseKeyword);
    if (index < 0 || hookSyntaxProblem(words))
        return false;
    for (; index < words.length; index++) {
        const word = words[index];
        const redirect = shellRedirection(word);
        if (!redirect)
            return false;
        const target = redirect.joined ? word : words[++index];
        if (!target || (!redirect.joined && shellRedirection(target)) || target.unresolved || hasBraceExpansion(target))
            return false;
    }
    return true;
}
/** Find possible final renderers, including those retained when an OR fallback masks a failed AND-list. */
function finalHookCommands(commands) {
    const alternatives = [];
    const loopEntries = [];
    const skippedByLoopControl = new Set();
    let last = [];
    let skipped = [];
    let skippedInPreviousList = [];
    let afterOr = false;
    let afterAnd = false;
    let terminated;
    for (const words of commands) {
        let completedBranch = false;
        for (const word of words) {
            if (!word.releaseKeyword)
                break;
            if (word.value === "do")
                loopEntries.push({ before: last });
            if (word.value === "done") {
                const loop = loopEntries.pop();
                if (loop)
                    last = [...new Set([...loop.before, ...last])];
            }
            if (word.value === "if") {
                // A successful conditional can mask the preceding list's failure.
                // An arm that renders again will replace these candidates.
                if (!afterAnd && !afterOr)
                    last = [...new Set([...last, ...skippedInPreviousList])];
                alternatives.push({
                    before: last, branches: [], skipped: [], hasElse: false, beforeExit: terminated, branchExit: undefined,
                });
            }
            const branch = alternatives.at(-1);
            if (branch && (word.value === "elif" || word.value === "else")) {
                branch.branches.push(...last);
                branch.skipped.push(...skippedInPreviousList);
                branch.hasElse = word.value === "else";
                last = branch.before;
                branch.branchExit ??= terminated;
                terminated = branch.beforeExit;
            }
            if (branch && word.value === "fi") {
                alternatives.pop();
                last = [...new Set([...branch.branches, ...last, ...(branch.hasElse ? [] : branch.before)])];
                terminated ??= branch.branchExit;
                skippedInPreviousList = [...branch.skipped, ...skippedInPreviousList];
                completedBranch = true;
            }
        }
        if (isReleaseIterationHeader(words))
            continue;
        if (terminated && releaseHookCommand(words)) {
            const effect = terminated === "exec" ? "exec replaces" : "exit terminates";
            refuseHook("Cannot select a later renderer after " + effect + " the shell. Use a single script entry point");
        }
        const terminator = rendererShellTerminator(words);
        terminated ??= terminator;
        if (terminator === "exit" && !afterAnd && overridesFailureWithSuccess(words)) {
            last = [...new Set([...last, ...skippedInPreviousList])];
        }
        const following = followingReleaseOperator(words);
        if (following === "pipe")
            continue;
        const producer = releaseOutputProducer(words);
        const status = rendererStatusName(producer);
        if ((status === "break" || status === "continue") && !isIsolatedReleaseCommand(producer)) {
            const level = Number(rendererBuiltin(producer)?.[1]?.value ?? 1);
            const scopes = Number.isInteger(level) && level > 0 ? loopEntries.slice(-level) : loopEntries;
            for (const loop of scopes)
                loop.maySkipRenderer = true;
        }
        else if (!status && releaseHookCommand(producer) && loopEntries.some(loop => loop.maySkipRenderer)) {
            skippedByLoopControl.add(producer);
        }
        const isStatus = status !== undefined;
        const redirectOnly = literalRedirectOnly(words);
        if (afterOr && (redirectOnly || (isStatus && (status !== "false" || producer !== words)))) {
            last = [...new Set([...last, ...skipped])];
        }
        // Keep the selected renderers when a trailing status would make
        // the fallback search reconsider setup already superseded after a loop.
        const statusAfterSetupLoop = isStatus && !terminator && !afterOr && !afterAnd
            && loopEntries.length === 0 && alternatives.length === 0 && skippedByLoopControl.size > 0 && last.length > 0;
        if (statusAfterSetupLoop)
            last = [...new Set([...last, ...skippedInPreviousList])];
        if ((!words[0].releaseKeyword || words.length > 1)
            && terminator !== "exit"
            && !redirectOnly
            && !statusAfterSetupLoop
            && !((alternatives.length > 0 || loopEntries.length > 0 || isReleaseLoopCondition(words)
                || afterOr || (afterAnd && following !== undefined)) && isStatus)) {
            const prior = afterOr ? last.filter(command => !rendererStatusCommand(releaseOutputProducer(command))) : [];
            if (afterAnd)
                skipped.push(...last.filter(command => !rendererStatusCommand(releaseOutputProducer(command))));
            if (afterOr)
                skipped = [];
            last = [...prior, words];
        }
        if (following === undefined) {
            if (!completedBranch)
                skippedInPreviousList = skipped;
            skipped = [];
        }
        afterOr = following === "or";
        afterAnd = following === "and";
    }
    return { last, skippedByLoopControl };
}
/** Refuse a selected renderer that might be skipped by loop control. */
function assertLoopRendererReachable(renderers, skippedByLoopControl) {
    if (skippedByLoopControl.size && renderers.some(words => skippedByLoopControl.has(releaseOutputProducer(words)))) {
        refuseHook("Cannot select a later renderer after loop control. Use a single script entry point");
    }
}
/** Apply the same construct refusal to standalone options and renderer selection. */
function parseSupportedReleaseHook(text, hook = "standalone") {
    const parsed = parseReleaseHook(text);
    const construct = releaseHookConstructProblem(parsed.commands, text, parsed.spans, hook, "hook");
    if (construct)
        throw new Error(construct.problem);
    return parsed;
}
/** Check whether all terminal renderers receive the flag without editing their caller. */
function allPreparedRenderers(last, scripts, names, hasGenerator, depth, hook, recipient, args = []) {
    return depth <= MAX_SCRIPT_FORWARDS && last.length > 0 && last.every(words => {
        const producer = releaseOutputProducer(words);
        const command = releaseHookCommand(producer === recipient ? [...producer, ...args] : producer);
        if (!command)
            return false;
        if (hasGenerator && generatorCommand(command))
            return true;
        const forward = scriptForward(basename(command[0].value), command.slice(1), names);
        if (!forward)
            return !hasGenerator && customRendererOptions(command, hook).options.length > 0;
        if (!forward.target)
            return false;
        const body = scripts.get(forward.target);
        if (!body)
            return false;
        const { commands, spans } = parseSupportedReleaseHook(body, forward.target);
        const nextRecipient = forward.args.length ? commandReceivingArguments(body, commands, spans) : undefined;
        const { last: next, skippedByLoopControl } = finalHookCommands(commands);
        assertLoopRendererReachable(next, skippedByLoopControl);
        return allPreparedRenderers(next, scripts, names, hasGenerator, depth + 1, forward.target, nextRecipient, forward.args);
    });
}
const RENDERER_SWITCHES = new Set([
    INCLUDE_EMPTY_FLAG, DATE_FLAG, PACKAGE_VERSION_FLAG, "--all-release-tags", "--check", "--github-step-summary",
    "--no-pending-release", "--respect-item-release", "--since-previous-tag", "--stdout", "--until-release-tag",
]);
/** Find both the separator and actual flags with the same renderer operand rules. */
function customRendererOptions(invocation, hook) {
    const args = invocation.slice(generatorEntryIndex(invocation) + 1);
    const options = [];
    for (const index of optionPositions(args, true)) {
        const token = args[index];
        if (token.value === "--")
            return { terminator: token, options };
        if (token.value === INCLUDE_EMPTY_FLAG)
            options.push(token);
        const next = args[index + 1];
        if (VALUE_OPTIONS.has(token.value)) {
            if (!next)
                refuseHook(describeUnsupportedReleaseHook("Missing custom renderer operand for " + token.value, hook));
        }
        else if (/^--?[a-z]/i.test(token.value) && !token.value.includes("=") && !RENDERER_SWITCHES.has(token.value)
            && (!next || next.value === INCLUDE_EMPTY_FLAG || next.value === "--")) {
            refuseHook(describeUnsupportedReleaseHook("Ambiguous custom renderer operand for " + token.value, hook));
        }
    }
    return { options };
}
const RENDERER_STATUS_COMMANDS = new Set(["git", "test", "[", "[[", "true", "false", ":"]);
/** Read the actual status command name through its wrappers. */
function rendererStatusName(words) {
    const builtin = rendererBuiltin(words)?.[0].value;
    if (builtin === "break" || builtin === "continue" || (builtin === "exit" && !isIsolatedReleaseCommand(words)))
        return builtin;
    const command = releaseHookCommand(words);
    const name = command && basename(command[0].value);
    return name && RENDERER_STATUS_COMMANDS.has(name) ? name : undefined;
}
/** Identify a shell status check or repository bookkeeping after rendering. */
function rendererStatusCommand(words) {
    return rendererStatusName(words) !== undefined;
}
/** Read literal shell builtins with their own arguments through shell-only wrappers. */
function rendererBuiltin(words) {
    if (!releaseHookCommand(words))
        return undefined;
    const argv = withoutRedirections(words);
    let index = argv.findIndex(word => !word.releaseKeyword && !isShellAssignment(word));
    while (argv[index]?.value === "command" || argv[index]?.value === "builtin") {
        const command = argv[index].value === "command";
        index++;
        if (command && argv[index]?.value === "-p")
            index++;
        if (argv[index]?.value === "--")
            index++;
    }
    return argv[index] && !argv[index].unresolved ? argv.slice(index) : undefined;
}
/** Identify a builtin that can prevent the rest of the current shell from running. */
function rendererShellTerminator(words) {
    if (isIsolatedReleaseCommand(words))
        return undefined;
    const builtin = rendererBuiltin(words);
    if (builtin?.[0].value === "exit")
        return "exit";
    if (builtin?.[0].value === "exec" && builtin.length > 1)
        return "exec";
    return undefined;
}
/** An explicit exit operand can turn a failed preceding list into a successful hook. */
function overridesFailureWithSuccess(words) {
    const args = rendererBuiltin(words);
    const operand = args[args[1]?.value === "--" ? 2 : 1];
    return operand !== undefined && (Boolean(operand.unresolved)
        || (/^[+-]?\d+$/.test(operand.value) && BigInt(operand.value) % 256n === 0n));
}
/** Alternatives need no custom argument when all of their terminal generators receive the flag directly. */
function finalHookCommand(commands, hasGenerator, scripts, allowStatusOnly, hook) {
    const { last, skippedByLoopControl } = finalHookCommands(commands);
    assertLoopRendererReachable(last, skippedByLoopControl);
    if (last.length > 1) {
        if (allPreparedRenderers(last, scripts, new Set(scripts.keys()), hasGenerator, 0, hook))
            return undefined;
        refuseHook("Custom hook has alternative renderers. Use a single script entry point");
    }
    const terminal = last.at(-1) ?? [];
    if (isIsolatedReleaseCommand(terminal) && hookSyntaxProblem(terminal) === "Shell grouping or substitution") {
        refuseHook("Cannot edit a renderer inside shell grouping. Use a single script entry point");
    }
    if (!rendererStatusCommand(releaseOutputProducer(terminal)))
        return terminal;
    const candidates = [...new Set(commands.map(releaseOutputProducer))].filter(words => !isReleaseIterationHeader(words) && releaseHookCommand(words) && !rendererStatusCommand(words));
    // A trailing status command can belong to the same list as its renderer.
    // A separate status-only list still needs the rest of the hook for context.
    const end = commands.indexOf(terminal);
    let start = end;
    while (start > 0 && followingReleaseOperator(commands[start - 1]) !== undefined)
        start--;
    const list = new Set(commands.slice(start, end).map(releaseOutputProducer));
    const listRenderers = candidates.filter(words => list.has(words));
    const renderers = listRenderers.length === 0 ? candidates : listRenderers;
    assertLoopRendererReachable(renderers, skippedByLoopControl);
    if (renderers.length === 0 && allowStatusOnly)
        return undefined;
    if (renderers.length === 1)
        return renderers[0];
    if (allPreparedRenderers(renderers, scripts, new Set(scripts.keys()), hasGenerator, 0, hook))
        return undefined;
    refuseHook("Cannot identify one renderer before the trailing status command. Use a single script entry point");
}
/** Count npm option boundaries between a configured custom hook and its final executable. */
function customForwardDelimiters(invocation, scripts, hasGenerator, allowStatusOnly, hook) {
    const names = new Set(scripts.keys());
    let count = 0;
    let blockedTarget;
    for (let depth = 0; depth <= MAX_SCRIPT_FORWARDS; depth++) {
        const program = basename(invocation[0].value);
        const forward = scriptForward(program, invocation.slice(1), names);
        if (!forward) {
            // Preserve a generator's trailing status checks, logging and Git steps.
            if (hasGenerator && (generatorCommand(invocation) || DATA_CONSUMERS.has(program)
                || [":", "true", "false", "git"].includes(program)))
                return undefined;
            const { terminator, options } = customRendererOptions(invocation, hook);
            if (blockedTarget && options.length === 0)
                refuseHook("Custom script " + JSON.stringify(blockedTarget) + " cannot receive forwarded arguments. Move the logic into a script file");
            return { count, terminator, options };
        }
        if (forward.unsupported) {
            refuseHook(describeUnsupportedReleaseHook("Custom renderer argument " + JSON.stringify(forward.unsupported) + " before npm's --", hook));
        }
        if (forward.runner === "npm" && !forward.npmSeparator)
            count++;
        const text = scripts.get(forward.target);
        if (!text)
            return hasGenerator ? undefined : { count }; // An optional missing target runs no command.
        hook = forward.target;
        const { commands, spans } = parseSupportedReleaseHook(text, hook);
        const recipient = commandReceivingArguments(text, commands, spans);
        const terminal = finalHookCommand(commands, hasGenerator, scripts, allowStatusOnly, hook);
        if (!terminal)
            return undefined;
        const producer = releaseOutputProducer(recipient && releaseHookCommand(recipient) && !rendererStatusCommand(recipient) ? recipient : terminal);
        if (producer !== recipient)
            blockedTarget = forward.target;
        const next = releaseHookCommand(producer === recipient ? [...producer, ...forward.args] : producer);
        if (!next)
            refuseHook("Custom script " + JSON.stringify(forward.target) + " cannot receive forwarded arguments. Move the logic into a script file");
        invocation = next;
    }
    refuseHook("Custom script forward depth exceeds " + MAX_SCRIPT_FORWARDS);
}
/** Save the flag and any npm delimiters on the root caller, preserving shared target scripts. */
export function includeEmptyCustomHook(script, scripts, hasGenerator = false, allowStatusOnly = false, hook = "release:notes") {
    const { commands, spans } = parseSupportedReleaseHook(script, hook);
    const terminal = finalHookCommand(commands, hasGenerator, scripts, allowStatusOnly, hook);
    const invocation = terminal && releaseHookCommand(releaseOutputProducer(terminal));
    if (!invocation)
        return script;
    const [program, ...args] = invocation;
    const separator = scriptForward(basename(program.value), args)?.npmSeparator;
    const boundary = separator ? args.indexOf(separator) : -1;
    const route = customForwardDelimiters(invocation, scripts, hasGenerator, allowStatusOnly, hook);
    if (!route)
        return script; // The generator receives the flag in its own script.
    const { count, terminator, options = [] } = route;
    const redundant = args.slice(0, Math.max(0, boundary)).filter(word => word.value === INCLUDE_EMPTY_FLAG);
    // Removal requires evidence that both the local token and the one supplied
    // by a callee are flags. Preserve historical placement for saved argv.
    if (options.some(word => !spans.has(word)))
        redundant.push(...options.filter(word => spans.has(word)));
    const edits = [];
    for (const word of redundant) {
        const { start, end } = spans.get(word);
        const padding = /^[ \t]*/.exec(script.slice(end))[0].length;
        edits.push({ start, end: end + padding, text: "" });
    }
    if (options.length)
        return applyHookEdits(script, edits);
    if (terminator && !spans.has(terminator)) {
        refuseHook("Custom renderer ends option parsing in a shared script. Use a single script entry point");
    }
    // Reuse a saved flag still blocked by an npm boundary. If all boundaries are
    // open, the effective argv already showed that this text is only an operand.
    const flag = count > 0 ? args.slice(boundary + 1).find(word => word.value === INCLUDE_EMPTY_FLAG) : undefined;
    const before = flag ?? terminator;
    const offset = before ? spans.get(before).start : spans.get(invocation.at(-1)).end;
    const option = "-- ".repeat(count) + INCLUDE_EMPTY_FLAG;
    const text = flag ? "-- ".repeat(count) : terminator ? option + " " : " " + option;
    edits.push({ start: offset, end: offset, text });
    return applyHookEdits(script, edits);
}
/** An empty replacement restores the standing version policy. */
function validateReplacementDay(headingDate) {
    if (headingDate && !isRealCalendarDay(headingDate)) {
        refuseHook("Release heading date must be YYYY-MM-DD and name a real calendar day, received " + JSON.stringify(headingDate));
    }
}
/** Refresh the inline pins, or restore the standing policy for a current version. */
export function rewriteReleaseHeadingDate(script, headingDate, scriptNames) {
    validateReplacementDay(headingDate);
    const { commands, spans } = parseSupportedReleaseHook(script);
    const source = { text: script, spans, edits: new Map() };
    const options = [...standaloneHookCommands(commands, scriptNames)].flatMap(words => hookDateOptions(changelogInvocation(words, scriptNames)?.slice(1) ?? []));
    rewriteDateOptions(options, headingDate, () => source);
    return applyHookEdits(script, source.edits.values());
}
/** Add the empty-section flag at the call site when it supplies the generator entrypoint. */
export function includeEmptyForwardedGenerators(scripts, hooks, lifecycle) {
    const sources = new Map();
    const owners = new WeakMap();
    visitChangelogScriptCommands(scripts, ({ name, names, text, spans, words, effective }) => {
        const source = sources.get(name) ?? { text, spans, edits: new Map() };
        sources.set(name, source);
        for (const word of words)
            owners.set(word, source);
        const invocation = changelogInvocation(effective, names, name);
        if (!invocation)
            return;
        const [entry, ...args] = invocation;
        const caller = owners.get(entry);
        if (caller === source || optionPositions(args).some(index => args[index].value === INCLUDE_EMPTY_FLAG))
            return;
        const { end } = caller.spans.get(entry);
        caller.edits.set(end, { start: end, end, text: " " + INCLUDE_EMPTY_FLAG });
    }, hooks, undefined, undefined, { lifecycle });
    return new Map([...sources].map(([name, { text, edits }]) => [name, applyHookEdits(text, edits.values())]));
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
        if (firstSource !== lastSource && headingDate) {
            lastSource.edits.set(last.start, { ...last, text: headingDate });
        }
        else if (firstSource !== lastSource || (option.first !== option.last
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
export function rewriteReleaseHookDates(scripts, hooks, headingDate, lifecycle = "unknown", packageVersion) {
    validateReplacementDay(headingDate);
    const sources = new Map();
    const owners = new WeakMap();
    const changedContracts = new Set();
    visitChangelogScriptCommands(scripts, ({ parents, name, names, text, spans, words, effective, forwardedSeparators }) => {
        let source = sources.get(name);
        if (!source) {
            source = { name, text, spans, edits: new Map() };
            sources.set(name, source);
        }
        for (const token of words)
            owners.set(token, source);
        const received = changelogInvocation(effective, names, name)?.slice(1) ?? [];
        // Preparation can repair a delimiter from an older pnpm hook at its source.
        // A separator consumed as --pm-arg data must remain in the command.
        const separators = optionPositions(received).map(i => received[i]).filter(token => forwardedSeparators.includes(token));
        const args = received.filter(token => !separators.includes(token));
        const options = hookDateOptions(args);
        const positions = optionPositions(args);
        if (options.length)
            assertReleaseCoordinate(literalReleaseVersion(args, positions), packageVersion);
        assertAllTagsCutoff(args, positions, headingDate, packageVersion);
        if (!headingDate) {
            for (const { first, last } of options) {
                const caller = owners.get(last);
                if (owners.get(first) === caller)
                    continue;
                const path = [...parents, name];
                for (const target of path.slice(path.indexOf(caller.name) + 1))
                    changedContracts.add(target);
            }
        }
        rewriteDateOptions(options, headingDate, token => owners.get(token));
        if (options.length > 0) {
            for (const separator of separators) {
                const owner = owners.get(separator);
                const span = owner.spans.get(separator);
                const space = /^[ \t]*/.exec(owner.text.slice(span.end))[0];
                owner.edits.set(span.start, { start: span.start, end: span.end + space.length, text: "" });
            }
        }
    }, hooks, undefined, undefined, { lifecycle });
    if (changedContracts.size) {
        for (const [name, text] of scripts) {
            if (sources.has(name))
                continue;
            for (const words of parseReleaseHook(text).commands) {
                const invocation = releaseHookCommand(words);
                if (invocation && DATA_CONSUMERS.has(basename(invocation[0].value)) && !hookSyntaxProblem(words))
                    continue;
                const callers = candidateScriptRunners(words);
                if (callers.some(([runner, ...args]) => {
                    const forward = scriptForward(basename(runner.value), args);
                    const target = forward?.target ?? bunShorthand(runner, args);
                    return (forward && !target) || (target && changedContracts.has(target));
                }) || scriptReferenceWords(words).some(word => changedContracts.has(word))) {
                    refuseHook("Restoring a forwarded date operand would change the argument contract used by " + JSON.stringify(name));
                }
            }
        }
    }
    return new Map([...sources].map(([name, { text, edits }]) => [name, applyHookEdits(text, edits.values())]));
}
//# sourceMappingURL=release-changelog-options.js.map