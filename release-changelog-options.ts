/**
 * Canonical release hooks are lists of direct pm-changelog commands, local
 * npm/bun/pnpm script forwards, literal checks and ordinary helper commands.
 * Newlines, &&, || and ; sequence commands. A pipeline audits each command.
 * timeout, nice, env, command, exec, stdbuf, time and package runners have
 * explicit argv boundaries. npm runs pre/main/post with argv only on main.
 * Source spans belong to the script that wrote each word. Shell evaluation,
 * unknown wrappers and ambiguous policies require a canonical invocation.
 */
import { basename, posix } from "node:path";
import {
  RELEASE_CONTEXT_VARIABLE, RELEASE_PROJECT_OPTION, releaseHookCommand, shellRedirection, withoutRedirections,
  type ReleaseContextChange, type ShellCommand, type ShellToken, type ShellTokenSpan,
} from "./shell-scan.ts";
import {
  describeReleaseContextChange, hasBraceExpansion, hookSyntaxProblem, inheritedVariable, isContinuedDescriptor, isIsolatedReleaseCommand,
  isReleaseLoopCondition, literalOptionName, mentionsGenerator, parseReleaseHook, refuseHook,
} from "./release-hook-grammar.ts";

/** The flag that makes an untagged heading version-derived. */
export const DATE_FLAG = "--date-from-version";

/** The option that pins the heading day of a resumed release. */
export const FALLBACK_DATE_FLAG = "--date-fallback";

const OVERRIDE_DATE_FLAG = "--date";
const UNTIL_FLAG = "--until";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Match executables and registry package specifiers left by package runner prefixes. */
const GENERATOR_TARGET = /^pm-changelog@[^/]+$|(?:^|\/)(?:pm-changelog(?:\.ts)?|dist\/cli\.js)$/;
/** The three generator inputs that bind a heading to a release. */
export const VERSION_INPUTS = ["--release-version-from-package", "--release-version", "--version"] as const;
const INDIRECT_RELEASE_OPTIONS = new Set<string>([...VERSION_INPUTS, DATE_FLAG, FALLBACK_DATE_FLAG, UNTIL_FLAG]);

/** True when a command supplies an explicit release version. */
export function hasVersionInput(args: readonly ShellToken[]): boolean {
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

/** Whether a YYYY-MM-DD string names an existing day, including years 0–99. */
export function isRealCalendarDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const [year, month, date] = day.split("-").map(Number);
  const round = new Date(0);
  round.setUTCFullYear(year, month - 1, date);
  return round.getUTCFullYear() === year && round.getUTCMonth() === month - 1 && round.getUTCDate() === date;
}

/** Mirror pm-changelog by preserving the date prefix of the committer timestamp. */
export function releaseCommitDay(timestamp: string): string {
  const day = timestamp.slice(0, 10);
  if (!isRealCalendarDay(day)) throw new Error("Expected a committer timestamp with a real YYYY-MM-DD day");
  return day;
}

/** Recognize package-manager commands that run a script in the same manifest. */
function isScriptForward(program: string, subcommand: string | undefined): boolean {
  return (subcommand === "run" && SCRIPT_RUNNERS.has(program)) || ((program === "npm" || program === "pnpm") && subcommand === "run-script");
}

/** Skip local npm switches and retain the last explicit optional-script setting. */
function afterNpmRunOptions(tokens: readonly ShellToken[], start: number, optional = false, lifecycle?: boolean) {
  let index = start;
  for (;;) {
    const option = tokens[index];
    if (!option || option.unresolved) return { index, optional, lifecycle };
    const setting = NPM_BOOLEAN.exec(option.value);
    if (setting) {
      let value = setting[3];
      const operand = tokens[index + 1]?.value;
      if (value === undefined && BOOLEAN_VALUE.test(operand ?? "")) {
        value = operand;
        index++;
      }
      const enabled = setting[1] ? value === "false" : value !== "false";
      if (setting[2] === "if-present") optional = enabled;
      else lifecycle = !enabled;
      index++;
    } else if (NPM_LOCAL_RUN_SWITCH.test(option.value)
      || (option.value.startsWith("--loglevel=") && NPM_LOG_LEVEL.test(option.value.slice("--loglevel=".length)))) {
      index++;
    } else if (option.value === "--loglevel" && NPM_LOG_LEVEL.test(tokens[index + 1]?.value ?? "")) {
      index += 2;
    } else {
      return { index, optional, lifecycle };
    }
  }
}

/** Read a script target only when the command supplies its literal name. */
function literalScriptName(target: ShellToken | undefined): string | undefined {
  return target?.value && !target.unresolved && !target.value.startsWith("-") ? target.value : undefined;
}

/** Skip runner flags that appear before the subcommand or script name. */
function afterRunOptions(program: string, tokens: readonly ShellToken[], start: number, optional = false, lifecycle?: boolean): { index: number; optional: boolean; lifecycle?: boolean } {
  if (program === "npm") return afterNpmRunOptions(tokens, start, optional, lifecycle);
  let index = start;
  for (;;) {
    const option = tokens[index];
    if (!option || option.unresolved) return { index, optional };
    if (option.value === "--if-present") optional = true;
    else if (program !== "bun" || !BUN_LOCAL_RUN_SWITCHES.has(option.value)) return { index, optional };
    index++;
  }
}

/** Locate the target and optionality of a package-script forward. */
function scriptForward(program: string, parameters: readonly ShellToken[], scriptNames?: ReadonlySet<string>): {
  target: string | undefined; optional: boolean; runner: string; lifecycle?: NpmLifecycle; unsupported?: string; args: readonly ShellToken[]; forwardedSeparator?: ShellToken;
  npmSeparator?: ShellToken;
} | undefined {
  const command = afterRunOptions(program, parameters, 0);
  if (!isScriptForward(program, parameters[command.index]?.value)) return undefined;
  const entry = afterRunOptions(program, parameters, command.index + 1, command.optional, command.lifecycle);
  const target = literalScriptName(parameters[entry.index]);
  // Bun also runs source files and local binaries when there is no named script.
  if (program === "bun" && target !== undefined && !scriptNames?.has(target)
    && (BUN_SOURCE_FILE.test(target) || GENERATOR_TARGET.test(target))) return undefined;
  const tail = parameters.slice(entry.index + 1);
  if (program !== "npm") {
    const separator = tail[0]?.value === "--" ? tail[0] : undefined;
    if (program === "pnpm") return { target, runner: program, optional: entry.optional, args: tail, forwardedSeparator: separator };
    return { target, runner: program, optional: entry.optional, args: separator ? tail.slice(1) : tail };
  }
  const separator = tail.findIndex(token => token.value === "--" && !token.unresolved);
  // An older preparation saved this flag on npm itself. npm consumes it,
  // so it contributes no generator argv until preparation repairs the hook.
  const legacyFlag = separator < 0 && tail.at(-1)?.value === INCLUDE_EMPTY_FLAG;
  const flags = separator < 0 ? (legacyFlag ? tail.slice(0, -1) : tail)
    : tail.slice(0, separator).filter(token => token.value !== INCLUDE_EMPTY_FLAG);
  const settings = afterNpmRunOptions(flags, 0, entry.optional, entry.lifecycle);
  return { target, runner: program, lifecycle: settings.lifecycle, optional: settings.optional, unsupported: flags[settings.index]?.value,
    args: separator < 0 ? [] : tail.slice(separator + 1), npmSeparator: tail[separator] };
}

/** Whether npm automatically runs the named script's pre/post scripts. */
export type NpmLifecycle = boolean | "unknown";

/** Convert npm's literal ignore-scripts setting into lifecycle execution. */
function lifecycleSetting(value: unknown): NpmLifecycle {
  if (value === true || value === "true") return false;
  if (value === false || value === "false") return true;
  return "unknown";
}

/** Resolve CLI-independent npm configuration from the workflow env and project .npmrc. */
export function npmLifecycle(
  projectConfig: string | undefined, environment: Readonly<Record<string, unknown>> = {},
): NpmLifecycle {
  const settings = Object.entries(environment)
    .filter(([name, value]) => /^npm_config_ignore_scripts$/i.test(name) && value !== "")
    .map(([, value]) => lifecycleSetting(value));
  if (settings.length > 0) return settings.every(setting => setting === settings[0]) ? settings[0] : "unknown";

  let setting: NpmLifecycle = "unknown";
  for (const line of projectConfig?.split(/\r?\n/) ?? []) {
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) break;
    const entry = /^\s*(["']?)ignore-scripts(\[\])?\1\s*(?:=\s*(.*)|[;#].*)?$/.exec(line);
    if (!entry) continue;
    const raw = entry[3]?.trim();
    const literal = raw?.replace(/^(["'])(true|false)\1$|^(true|false)\s*(?:[;#].*)?$/, "$2$3");
    setting = entry[2] ? "unknown" : lifecycleSetting(literal ?? true);
  }
  return setting;
}

/** Read an explicit npm lifecycle assignment on the runner's command prefix. */
function lifecycleEnvironment(words: ShellCommand, program: ShellToken): NpmLifecycle | undefined {
  let setting: NpmLifecycle | undefined;
  for (const token of withoutRedirections(words.slice(0, words.indexOf(program)))) {
    const match = /^npm_config_ignore_scripts=(.*)$/i.exec(token.value);
    if (match && match[1] !== "") setting = lifecycleSetting(match[1]);
  }
  return setting;
}

/** Resolve the same graph used by preparation and continuation, including comment-only hooks. */
export function resolveChangelogHooks(
  scripts: Record<string, unknown> | undefined, hooks: readonly string[], lifecycle: NpmLifecycle = "unknown",
): Map<string, string> {
  const all = new Map(Object.entries(scripts ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : ""]));
  const resolved = new Map<string, string>();
  visitChangelogScriptCommands(all, ({ effective, names }) => { changelogInvocation(effective, names); }, hooks, resolved, undefined, { lifecycle });
  return resolved;
}

/** Administrative package operands are dependency names rather than commands. */
function isPackageAdmin(program: ShellToken, parameters: ShellCommand): boolean {
  const name = basename(program.value);
  if (program.unresolved || !PACKAGE_MANAGERS.has(name)) return false;
  const subcommand = parameters[afterRunOptions(name, parameters, 0).index];
  return subcommand !== undefined && !subcommand.unresolved && PACKAGE_ADMIN_COMMANDS.has(subcommand.value);
}

/** Detect a literal script runner and generator-writing target inside an opaque command. */
function scriptReferenceWords(words: ShellCommand): string[] {
  const nested = words.flatMap(word => word.value.split(/[^\w.:-]+/));
  return nested.some(word => SCRIPT_RUNNERS.has(word)) && nested.some(word => word === "run" || word === "run-script") ? nested : [];
}

/** Preserve exact script names in argv and in literal payloads of opaque commands. */
function candidateScriptRunners(words: ShellCommand): ShellCommand[] {
  const commands = [words];
  for (const command of commands) {
    for (const word of command) {
      if (word.quoted && !word.unresolved && /\b(?:npm|pnpm|bun)\b/.test(word.value)) {
        commands.push(...parseReleaseHook(word.value).commands);
      }
    }
  }
  return commands.flatMap(command => command.flatMap((word, index) =>
    !word.unresolved && SCRIPT_RUNNERS.has(basename(word.value)) ? [command.slice(index)] : []));
}

/** Follow script references even in a chain that contains opaque commands. */
function referencesWriter(words: ShellCommand, scriptNames?: ReadonlySet<string>, seen?: Set<string>): boolean {
  if (!(scriptNames instanceof HookScriptNames)) return false;
  return candidateScriptRunners(words).some(([program, ...args]) => {
    const target = scriptForward(basename(program.value), args, scriptNames)?.target;
    return target !== undefined && scriptNames.mayInvoke(target, seen);
  }) || scriptReferenceWords(words).some(word => scriptNames.mayInvoke(word, seen));
}

/** Locate the executable or the file selected by a supported Node/Bun adapter. */
function generatorEntryIndex([program, ...parameters]: ShellCommand): number {
  const name = basename(program.value);
  if (name !== "node" && name !== "bun") return 0;
  let index = name === "bun" ? afterRunOptions(name, parameters, 0).index : 0;
  if (name === "bun" && parameters[index]?.value === "run") index = afterRunOptions(name, parameters, index + 1).index;
  while (parameters[index]?.value === "--enable-source-maps" || BUN_LOCAL_RUN_SWITCHES.has(parameters[index]?.value)) index++;
  return index + 1;
}

/** Recognize direct generator invocations and the supported Node/Bun adapters. */
function generatorCommand(invocation: ShellCommand): ShellCommand | undefined {
  const index = generatorEntryIndex(invocation);
  const file = invocation[index];
  return file && !file.unresolved && GENERATOR_TARGET.test(file.value) ? invocation.slice(index) : undefined;
}

/** Look for a reachable generator without interpreting an opaque command as executable argv. */
function canReachGenerator(
  words: ShellCommand, names?: ReadonlySet<string>, seen?: Set<string>, writing = false, lifecycle: NpmLifecycle = "unknown",
): boolean {
  if (writing && redirectsChangelog(words)) return true;
  const invocation = releaseHookCommand(words);
  if (!invocation) return hookSyntaxProblem(words) !== undefined && words.some(mentionsGenerator);
  const [program, ...parameters] = invocation;
  const name = basename(program.value);
  if (DATA_CONSUMERS.has(name) || isPackageAdmin(program, parameters)) return false;
  const forward = scriptForward(name, parameters, names);
  if (forward?.target && names instanceof HookScriptNames) {
    const isNpm = forward.runner === "npm";
    const enabled = forward.lifecycle ?? (isNpm ? lifecycleEnvironment(words, program) : undefined) ?? lifecycle;
    return names.sequence(forward.target, !isNpm || enabled !== false).some(target =>
      names.canGenerate(target, seen, writing, target === forward.target ? forward.args : [], enabled))
      || (!writing && forward.args.some(mentionsGenerator));
  }
  const generator = generatorCommand(invocation);
  if (generator) return !writing || writesChangelog(generator.slice(1));
  return words.some(mentionsGenerator) || referencesWriter(words, names, seen);
}

/** Find definite or possible Bash writes to the changelog, including on helper commands. */
function redirectsChangelog(words: ShellCommand, traversalOnly = false): boolean {
  return words.some((word, index) => {
    const redirect = shellRedirection(word);
    if (!redirect?.operator.includes(">")) return false;
    const target = redirect.joined ? word : words[index + 1];
    if (target?.unresolved) return !traversalOnly;
    const destination = redirect.joined ? word.value.slice(redirect.operator.length) : target?.value ?? "";
    return posix.normalize(destination) === "CHANGELOG.md"
      && (!traversalOnly || destination.split("/").includes(".."));
  });
}

/** Classify only the generator outputs that may write the changelog. */
function writesChangelog(args: ShellCommand): boolean {
  const { output, invalidOption, check, stdout } = changelogOutputTarget(args);
  return !check && !stdout
    && (invalidOption !== undefined || output.unresolved === true || /(?:^|\/)CHANGELOG\.md$/.test(posix.normalize(output.value)));
}

/** Project selectors on runners precede the delimiter that separates generator arguments. */
function runnerProjectOption([program, ...args]: ShellCommand): string | undefined {
  const name = basename(program.value);
  if (!SCRIPT_RUNNERS.has(name)) return undefined;
  const separator = args.findIndex(word => word.value === "--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  if (!flags.some(word => isScriptForward(name, word.value) || (name === "npm" && word.value === "exec"))) return undefined;
  return flags.find(word => RELEASE_PROJECT_OPTION.test(word.value))?.value;
}

/** Find the first set switch outside the shell modes modeled by the hook grammar. */
function unsupportedSetSwitch(args: ShellCommand): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag.unresolved) return "set " + flag.value;
    if (flag.value === "--" || !/^[+-]./.test(flag.value)) break;
    if (/^[+-][eu]+$/.test(flag.value)) continue;
    if (!/^[+-][eu]*o[eu]*$/.test(flag.value)) return "set " + flag.value;
    const option = args[++i];
    if (option?.unresolved) return "set " + flag.value;
    if (option && !/^(?:errexit|nounset|pipefail)$/.test(option.value)) return "set " + flag.value + " " + option.value;
  }
  return undefined;
}

/** Expose the shell command beneath command and builtin prefixes. */
function unwrapShellBuiltin(words: ShellCommand): ShellCommand | undefined {
  let command = releaseHookCommand(words);
  while (command?.[0].value === "builtin") {
    command = releaseHookCommand(command.slice(command[1]?.value === "--" ? 2 : 1));
  }
  return command;
}

/** A release hook cannot change shell parsing, builtin lookup, or pipeline isolation. */
function unsupportedShellSemantics(words: ShellCommand): string | undefined {
  const first = shellCommandStart(words);
  if (first < 0) return undefined;
  const command = unwrapShellBuiltin(words.slice(first));
  if (!command) return undefined;
  const [program, ...args] = command;
  if (program.value === "set") return unsupportedSetSwitch(args);
  return /^(?:shopt|enable|alias|source|\.)$/.test(program.value) ? program.value : undefined;
}

/** Locate the command after any shell list introducers. */
function shellCommandStart(words: ShellCommand): number {
  const inCondition = isReleaseLoopCondition(words);
  return words.findIndex(word => word.quoted || (!/^(?:if|then|elif|else|do|\{|!)$/.test(word.value)
    && !(inCondition && /^(?:while|until)$/.test(word.value))));
}

/** Shell edits apply to later commands in this script and to their descendants. */
function shellContextChange(words: ShellCommand): ReleaseContextChange | undefined {
  const first = shellCommandStart(words);
  if (first < 0) return undefined;
  const inner = withoutRedirections(words.slice(first));
  const head = inner[0];
  if (!head) return undefined;
  const command = /^(?:builtin$|command$|time$|[A-Za-z_]\w*\+?=)/.test(head.value) ? unwrapShellBuiltin(inner) ?? inner : inner;
  const [program, ...args] = command;
  const name = basename(program.value);
  if (/^(?:cd|pushd|popd)$/.test(name)) return { construct: name, directory: true };
  if (name === "export" || name === "unset") {
    const variable = args.map(word => RELEASE_CONTEXT_VARIABLE.exec(word.value)?.[0]).find(Boolean);
    if (variable) return { construct: name + " " + variable };
  }
  if (command.every(word => !word.startsQuoted && /^[A-Za-z_]\w*\+?=/.test(word.value))) {
    const variable = RELEASE_CONTEXT_VARIABLE.exec(program.value)?.[0]
      ?? args.map(word => RELEASE_CONTEXT_VARIABLE.exec(word.value)?.[0]).find(Boolean);
    if (variable) return { construct: variable + " assignment" };
  }
  return undefined;
}

/** Find context changes made for a single invocation. */
function commandContextChanges(words: ShellCommand): ReleaseContextChange[] {
  const context: ReleaseContextChange[] = [];
  const invocation = releaseHookCommand(words, context);
  // The npm forward resolver models this assignment, including dynamic values.
  if (invocation && basename(invocation[0].value) === "npm" && scriptForward("npm", invocation.slice(1))) {
    const known = lifecycleEnvironment(words, invocation[0]);
    if (known !== undefined) {
      const setting = /^(?:env )?npm_config_ignore_scripts assignment$/i;
      for (let i = context.length - 1; i >= 0; i--) if (setting.test(context[i].construct)) context.splice(i, 1);
    }
  }
  const project = invocation && runnerProjectOption(invocation);
  if (project) context.push({ construct: project, directory: true });
  const generator = invocation && generatorCommand(invocation);
  if (generator) {
    const args = generator.slice(1);
    if (optionPositions(args).some(index => args[index].value.split("=", 1)[0] === "--pm-cwd")) context.push({ construct: "--pm-cwd", directory: true });
  }
  return context;
}

/** Carry persistent shell changes forward and prefer directory edits over variable edits. */
function nextShellContext(words: ShellCommand, preceding?: ReleaseContextChange, effective = words): ReleaseContextChange | undefined {
  const change = isIsolatedReleaseCommand(words) ? undefined : shellContextChange(effective);
  return change?.directory ? change : preceding ?? change;
}

/** Apply one context rule to the shell path and the effective argv at each script depth. */
function releaseContextProblem(
  words: ShellCommand, names?: ReadonlySet<string>, preceding?: ReleaseContextChange, hookPath = true,
): string | undefined {
  if (hookPath) {
    if (words.some(isContinuedDescriptor)) return "Continued descriptor redirection" + SCRIPT_FILE_ADVICE;
    const loopChange = isReleaseLoopCondition(words) && !isIsolatedReleaseCommand(words) ? shellContextChange(words) : undefined;
    if (loopChange?.directory) return "Directory change " + loopChange.construct + " in a loop condition" + SCRIPT_FILE_ADVICE;
  }
  const shell = hookPath ? unsupportedShellSemantics(words) : undefined;
  if (shell) return describeReleaseContextChange(shell);
  const changes = commandContextChanges(words);
  if (preceding) changes.unshift(preceding);
  const change = changes.find(context => context.directory ? needsReleaseProject(words, names) : canReachGenerator(words, names));
  return change && describeReleaseContextChange(change.construct);
}

/** Return the generator word and arguments, or refuse a possible hook behind an unknown wrapper. */
function changelogInvocation(words: ShellCommand, scriptNames?: ReadonlySet<string>, audit = false): ShellCommand | undefined {
  const invocation = releaseHookCommand(words);
  const mentions = words.some(mentionsGenerator);
  const problem = hookSyntaxProblem(words);
  if (problem && (mentions || referencesWriter(words, scriptNames))) {
    const dynamicOption = words.some(word => word.unresolved && word.value.startsWith("-"));
    if (dynamicOption && invocation && GENERATOR_TARGET.test(invocation[0].value) && !hasVersionInput(invocation.slice(1))
      && !words.some(word => word.value.startsWith("--date-"))) return undefined;
    refuseHook(dynamicOption ? "Unresolved option word: " + problem : problem);
  }
  if (!invocation) {
    if (mentions && words.some(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value))) refuseHook("Incomplete wrapper before pm-changelog");
    return undefined;
  }
  const [program, ...parameters] = invocation;
  const name = basename(program.value);
  const forward = scriptForward(name, parameters, scriptNames);
  if (forward?.runner === "pnpm" && forward.target && scriptNames instanceof HookScriptNames
    && ["pre", "post"].some(prefix => scriptNames.canGenerate(prefix + forward.target))) {
    refuseHook("Configuration-dependent pnpm lifecycle writer for " + JSON.stringify(forward.target));
  }
  if (forward?.unsupported && (mentions || (forward.target && scriptNames instanceof HookScriptNames && scriptNames.mayInvoke(forward.target)))) {
    refuseHook("Unsupported npm run option or positional argument " + JSON.stringify(forward.unsupported) + " before --");
  }
  if (forward && (!audit || (forward.target !== undefined && (forward.optional || scriptNames!.has(forward.target))))) return undefined;
  const [subcommand] = parameters;
  if (isPackageAdmin(program, parameters)) return undefined;
  if (program.unresolved && mentionsGenerator(program)) refuseHook("Indirect pm-changelog executable " + JSON.stringify(program.value));
  const generator = generatorCommand(invocation);
  if (generator) {
    const args = generator.slice(1);
    if (args.some(hasBraceExpansion) && (hasVersionInput(args) || args.some(({ value }) => /^--date(?:[-=]|$)/.test(value)))) {
      refuseHook("Unquoted brace expansion in versioned generator options" + SCRIPT_FILE_ADVICE);
    }
    return generator;
  }
  if (name === "npm" && subcommand?.value === "exec" && mentions) {
    refuseHook("Unsupported npm exec options before pm-changelog. Use npm exec -- pm-changelog in the current project");
  }
  if (name === "command") {
    const lookup = parameters.find(word => word.value !== "-p");
    if (/^-p*[vV][pvV]*$/.test(lookup!.value)) return undefined;
  } else if (DATA_CONSUMERS.has(name)) return undefined;
  if (mentions || referencesWriter(words, scriptNames)) refuseHook(`Unrecognized wrapper or executable ${JSON.stringify(program.value)} before possible pm-changelog command`);
  return undefined;
}

/** Check indirect references inside unknown wrappers only for dependencies that can reach a generator. */
class HookScriptNames extends Set<string> {
  private readonly scripts: ReadonlyMap<string, string>;
  private readonly allowUnresolvedProjects: boolean;

  constructor(scripts: ReadonlyMap<string, string>, allowUnresolvedProjects = true) {
    super(scripts.keys());
    this.scripts = scripts;
    this.allowUnresolvedProjects = allowUnresolvedProjects;
  }

  /** npm skips empty implicit lifecycle scripts and passes args only to main. */
  sequence(name: string, lifecycle: boolean): string[] {
    return lifecycle ? [`pre${name}`, name, `post${name}`].filter(script => script === name || this.scripts.get(script)?.trim()) : [name];
  }

  /** An opaque npm invocation may run the named script and both lifecycle siblings. */
  mayInvoke(name: string, seen = new Set<string>()): boolean {
    return this.has(name) && this.sequence(name, true).some(script => this.canGenerate(script, seen));
  }

  /** Follow literal script references without recursively evaluating the wrapper's shell payload. */
  canGenerate(
    name: string, seen = new Set<string>(), writing = false, args: readonly ShellToken[] = [], lifecycle: NpmLifecycle = "unknown",
  ): boolean {
    if (!this.has(name) || seen.has(name)) return false;
    const ancestors = new Set(seen).add(name);
    const text = this.scripts.get(name)!;
    const { commands, spans } = parseReleaseHook(text);
    const recipient = args.length ? commandReceivingArguments(text, commands, spans) : undefined;
    let preceding: ReleaseContextChange | undefined;
    for (const command of commands) {
      const words = command === recipient ? [...command, ...args] : command;
      if (canReachGenerator(words, this, ancestors, writing, lifecycle)) return true;
      if (!this.allowUnresolvedProjects) continue;
      if ((preceding?.directory || commandContextChanges(words).some(context => context.directory))
        && maySelectUnresolvedScript(words, this)) return true;
      preceding = nextShellContext(command, preceding, words);
    }
    return false;
  }
}

/** A project change can resolve a literal script missing from the inspected manifest. */
function maySelectUnresolvedScript(words: ShellCommand, names?: ReadonlySet<string>): boolean {
  const invocation = releaseHookCommand(words);
  if (!invocation) return false;
  const [program, ...parameters] = invocation;
  if (DATA_CONSUMERS.has(basename(program.value)) || isPackageAdmin(program, parameters)) return false;
  return candidateScriptRunners(words).some(command => {
    const [program, ...args] = command;
    const forward = scriptForward(basename(program.value), args, names);
    return (forward?.target !== undefined && !names?.has(forward.target)) || runnerProjectOption(command) !== undefined;
  });
}

/** Whether a non-root step could run a generator or delegate to its local package scripts. */
export function needsReleaseProject(words: ShellCommand, names?: ReadonlySet<string>): boolean {
  return canReachGenerator(words, names) || maySelectUnresolvedScript(words, names);
}

/** Read generator arguments during an audit, where only declared forwards are trusted. */
export function changelogArguments(words: ShellCommand, scriptNames: ReadonlySet<string>): ShellToken[] | undefined {
  return changelogInvocation(words, scriptNames, true)?.slice(1);
}

/** One command in a decoded manifest script, with its source and effective argv. */
export interface ChangelogScriptCommand {
  /** Name of the script that supplied the command. */
  name: string;
  /** Local script names available to this command. */
  names: ReadonlySet<string>;
  /** Source text before shell tokenization. */
  text: string;
  /** Original command words, including any wrappers. */
  words: ShellCommand;
  /** Command words with inherited package-script arguments appended. */
  effective: ShellCommand;
  /** pnpm delimiters that reached this command as literal arguments. */
  forwardedSeparators: ShellToken[];
  /** Source offsets for editable words from this script. */
  spans: WeakMap<ShellToken, ShellTokenSpan>;
  /** Context refusal for an audit that collects diagnostics instead of throwing. */
  contextProblem?: string;
}

/** Identify the original command that would receive argv appended by a script runner. */
function commandReceivingArguments(
  text: string, commands: ShellCommand[], spans: WeakMap<ShellToken, ShellTokenSpan>,
): ShellCommand | undefined {
  const marker = "__pm_ops_forwarded_argument__";
  const appended = parseReleaseHook(text + " " + marker);
  const recipient = appended.commands.find(words => words.length > 1 && words.at(-1)!.value === marker
    && appended.spans.get(words.at(-1)!)?.start === text.length + 1);
  if (!recipient) return undefined;
  const start = appended.spans.get(recipient[0])!.start;
  return commands.find(words => spans.get(words[0])?.start === start);
}

/** Lifecycle inputs for direct npm hooks and standalone workflow shell bodies. */
interface NpmLifecycleInputs {
  /** Configuration inherited by the configured hooks. */
  lifecycle: NpmLifecycle;
  /** Inspect only explicitly invoked scripts when classifying the configured main command. */
  mainOnly?: boolean;
  /** Static environment of each standalone workflow step. */
  workflowSteps?: ReadonlyMap<string, NpmLifecycle>;
}

/** Find versioned generator options on a command that expands an inherited assignment. */
function forwardedBindingProblem(words: ShellCommand, bindings: ReadonlySet<string>): string | undefined {
  if (!bindings.size) return undefined;
  const invocation = releaseHookCommand(words);
  if (!invocation) return undefined;
  const entry = generatorEntryIndex(invocation);
  const args = invocation.slice(entry + 1);
  const positions = optionPositions(args);
  const selectors: ShellToken[] = [];
  if (positions.some(index => INDIRECT_RELEASE_OPTIONS.has(args[index].value.split("=", 1)[0]))) {
    selectors.push(...invocation.slice(0, 1), ...invocation.slice(entry, entry + 1));
  }
  if (generatorCommand(invocation)) {
    for (const index of positions) {
      const word = args[index];
      const policy = INDIRECT_RELEASE_OPTIONS.has(word.value.split("=", 1)[0]);
      if (policy || (word.unresolved && !literalOptionName(word))) selectors.push(word);
      if (policy && VALUE_OPTIONS.has(word.value) && args[index + 1]) selectors.push(args[index + 1]);
    }
  }
  const binding = selectors.map(word => inheritedVariable(word, bindings)).find(Boolean);
  return binding && ("Generator binding through variable assignment " + binding + " crosses an npm run forward" + SCRIPT_FILE_ADVICE);
}

/** Scan local scripts in invocation order and join forwarded argv at its actual destination. */
export function visitChangelogScriptCommands(
  scripts: ReadonlyMap<string, string>, inspect: (entry: ChangelogScriptCommand) => void, hooks?: readonly string[],
  resolved?: Map<string, string>, entryPoints: ReadonlySet<string> = new Set(), npm: NpmLifecycleInputs = { lifecycle: "unknown" },
): void {
  const names = new HookScriptNames(scripts);
  const knownWriters = new HookScriptNames(scripts, false);
  const targeted = new Set<string>();
  const parsed = new Map([...scripts].map(([name, text]) => {
    const { commands, spans } = parseReleaseHook(text);
    return [name, { text, commands, spans }];
  }));

  /** Read the local script target, arguments, and command-prefix assignments. */
  function forwardToScript(words: ShellCommand) {
    const assignments: ShellToken[] = [];
    const command = releaseHookCommand(words, undefined, assignments);
    if (!command) return undefined;
    const [program, ...parameters] = command;
    const forward = scriptForward(basename(program.value), parameters, names);
    if (!forward) return undefined;
    return { ...forward, bindings: assignments.map(word => word.value.split(/[+=]/, 1)[0]),
      lifecycle: forward.lifecycle ?? (forward.runner === "npm" ? lifecycleEnvironment(words, program) : undefined) };
  }

  // Workflow invocations supply their own lifecycle even when a hook must
  // also be checked as a standalone entry with no forwarded arguments.
  const entryLifecycles = new Map<string, Set<NpmLifecycle>>();
  const visited = new Set<string>();
  const withoutArgs = new Map<string, number>();
  const recipients = new Map<string, ShellCommand | undefined>();
  const forwardedSeparators = new WeakSet<ShellToken>();

  /** Walk one invocation, preserving token identity back to each supplying script. */
  function visit(
    name: string, args: readonly ShellToken[], parents: readonly string[], lifecycle: NpmLifecycle, releasePath: boolean, implicitNpm = false,
    bindings: ReadonlySet<string> = new Set(),
  ): void {
    const chain = [...parents, name].join(" -> ");
    if (parents.includes(name)) {
      if (hooks) refuseHook("Changelog script forward cycle: " + chain);
      return;
    }
    if (hooks && parents.length > MAX_SCRIPT_FORWARDS) refuseHook(`Changelog script forward depth exceeds ${MAX_SCRIPT_FORWARDS}: ${chain}`);
    const script = parsed.get(name);
    if (!script?.text.trim()) {
      if (!hooks) return;
      refuseHook(parents.length === 0 ? "Missing changelog hook: " + name
        : "Cannot resolve changelog script forward " + chain + ": missing or empty package.json script");
    }
    const { text, commands, spans } = script;
    let recipient: ShellCommand | undefined;
    if (args.length > 0) {
      if (!recipients.has(name)) recipients.set(name, commandReceivingArguments(text, commands, spans));
      recipient = recipients.get(name);
    }
    const checkContext = releasePath || knownWriters.canGenerate(name)
      || (recipient !== undefined && canReachGenerator([...recipient, ...args], knownWriters));
    if (args.length === 0) {
      const key = JSON.stringify([checkContext, lifecycle, implicitNpm, name, [...bindings].sort()]);
      const depth = hooks ? parents.length : 0;
      if ((withoutArgs.get(key) ?? -1) >= depth) return;
      withoutArgs.set(key, depth);
    }
    visited.add(name);
    const invocationNames = checkContext ? names : knownWriters;
    if (implicitNpm && lifecycle === "unknown" && knownWriters.canGenerate(name, undefined, true)) {
      const lifecycleProblem = `Cannot determine npm ignore-scripts for lifecycle hook ${JSON.stringify(name)} that may write CHANGELOG.md. Set a literal workflow env or project .npmrc value; user/global npm config and external env are uncertain`;
      const contextProblem = commands.some(words => redirectsChangelog(words, true)) ? lifecycleProblem + ". " + CHANGELOG_TRAVERSAL : lifecycleProblem;
      if (hooks) refuseHook(contextProblem);
      const words = commands[0];
      inspect({ name, names, text, words, effective: words, spans, forwardedSeparators: [], contextProblem });
      return;
    }
    resolved?.set(name, text);
    let preceding: ReleaseContextChange | undefined;
    for (const words of commands) {
      const effective = words === recipient ? [...words, ...args] : words;
      const forward = forwardToScript(effective);
      // pnpm passes its delimiter through verbatim. A nested runner can consume
      // it, but the generator only accepts named options.
      const separators = effective.filter(token => forwardedSeparators.has(token));
      const argv = forward ? effective : effective.filter(token => !forwardedSeparators.has(token));
      const contextProblem = forwardedBindingProblem(argv, bindings)
        ?? (checkContext ? releaseContextProblem(argv, names, preceding) : undefined);
      if (checkContext) preceding = nextShellContext(words, preceding, effective);
      if (contextProblem) {
        if (hooks) refuseHook(contextProblem);
        inspect({ name, names, text, words, effective: argv, spans, forwardedSeparators: separators, contextProblem });
        return;
      }
      inspect({ name, names: invocationNames, text, words, effective: argv, spans, forwardedSeparators: separators });
      if (forward) {
        if (forward.target === undefined) {
          if (hooks) refuseHook(`Cannot resolve changelog script forward in ${JSON.stringify(name)}: expected a literal package.json script name`);
          continue;
        }
        if (!names.has(forward.target) && (forward.optional || !hooks)) continue;
        if (forward.forwardedSeparator) forwardedSeparators.add(forward.forwardedSeparator);
        const enabled = forward.lifecycle ?? lifecycle;
        const isNpm = forward.runner === "npm";
        if (isNpm && entryPoints.has(forward.target) && collectingWorkflowEntries) {
          const settings = entryLifecycles.get(forward.target) ?? new Set<NpmLifecycle>();
          settings.add(enabled);
          entryLifecycles.set(forward.target, settings);
        }
        const inherited = isNpm && forward.bindings.length ? new Set([...bindings, ...forward.bindings]) : bindings;
        const sequence = names.sequence(forward.target, !npm.mainOnly && (!isNpm || enabled !== false));
        for (const target of sequence) {
          const main = target === forward.target;
          visit(target, main ? forward.args : [], [...parents, name], enabled, checkContext, isNpm && !main, inherited);
        }
      }
    }
  }

  const { lifecycle, workflowSteps } = npm;
  let collectingWorkflowEntries = true;
  for (const [step, setting] of workflowSteps ?? []) visit(step, [], [], setting, false);
  collectingWorkflowEntries = false;
  for (const hook of hooks ?? entryPoints) {
    if (!hooks && !names.has(hook)) continue;
    for (const setting of entryLifecycles.get(hook) ?? [lifecycle]) {
      for (const name of names.sequence(hook, !npm.mainOnly && setting !== false)) visit(name, [], [], setting, true, name !== hook);
    }
  }
  if (hooks) return;
  for (const { commands } of parsed.values()) {
    for (const words of commands) {
      const forward = forwardToScript(words);
      if (forward?.target) targeted.add(forward.target);
    }
  }
  for (const name of names) {
    if (!entryPoints.has(name) && !targeted.has(name)) visit(name, [], [], workflowSteps?.get(name) ?? lifecycle, false);
  }
  // A disconnected cycle has no root. Its own commands still need auditing.
  for (const name of names) {
    if (!visited.has(name)) visit(name, [], [], workflowSteps?.get(name) ?? lifecycle, false);
  }
}

/** Check standalone commands against the same context rule before reading their options. */
function* standaloneHookCommands(commands: ShellCommand[], names?: ReadonlySet<string>): Generator<ShellCommand> {
  const hookPath = commands.some(words => needsReleaseProject(words, names));
  let preceding: ReleaseContextChange | undefined;
  for (const words of commands) {
    const problem = releaseContextProblem(words, names, preceding, hookPath);
    if (problem) refuseHook(problem);
    yield words;
    preceding = nextShellContext(words, preceding);
  }
}

type DateOption =
  | { kind: "version"; first: ShellToken; last: ShellToken }
  | { kind: "pin"; first: ShellToken; last: ShellToken; day: string }
  | { kind: "missing-day"; first: ShellToken; last: ShellToken }
  | { kind: "invalid-day"; first: ShellToken; last: ShellToken; day: string };

type ValidDateOption = Extract<DateOption, { kind: "version" | "pin" }>;

/** Preserve option/operand boundaries, including option-shaped --pm-arg data. */
function optionPositions(args: readonly Pick<ShellToken, "value">[]): number[] {
  const positions: number[] = [];
  for (let i = 0; i < args.length; i++) {
    positions.push(i);
    const flag = args[i].value;
    if (VALUE_OPTIONS.has(flag) && args[i + 1] && (flag === "--pm-arg" || !args[i + 1].value.startsWith("--"))) i++;
  }
  return positions;
}

/** Resolve the output, inspection flags, and argv consumed by the changelog adapter. */
export function changelogOutputTarget(args: readonly Pick<ShellToken, "value" | "unresolved">[]) {
  let output: Pick<ShellToken, "value" | "unresolved"> = { value: "CHANGELOG.md" };
  let invalidOption: string | undefined;
  let check = false;
  let stdout = false;
  const consumed = new Set<number>();
  for (const index of optionPositions(args)) {
    const word = args[index];
    if (word.value === "--check" || word.value === "--stdout") {
      check ||= word.value === "--check";
      stdout ||= word.value === "--stdout";
      consumed.add(index);
      continue;
    }
    const match = /^(-o|--output)(?:=(.*))?$/s.exec(word.value);
    if (!match) continue;
    const target = match[2] === undefined ? args[index + 1] : { value: match[2], unresolved: word.unresolved };
    if (!target?.value || target.value.startsWith("--")) {
      invalidOption ??= match[1];
      continue;
    }
    output = target;
    consumed.add(index);
    if (match[2] === undefined) consumed.add(index + 1);
  }
  return { output, invalidOption, check, stdout, consumed };
}

/** Decode literal date options and retain their shell words for edits. */
export function readReleaseDateOptions(args: readonly ShellToken[]): DateOption[] {
  const options: DateOption[] = [];
  for (const index of optionPositions(args)) {
    const token = args[index];
    const flag = token.value.split("=", 1)[0];
    if (flag === OVERRIDE_DATE_FLAG) refuseHook("Explicit --date overrides the release heading. Remove --date and use a single release date policy");
    if ((flag === "--version" || flag === "--release-version") && (token.unresolved || (token.value === flag && args[index + 1]?.unresolved))) {
      refuseHook(`Unresolved ${flag} operand. Use --release-version-from-package or supply a literal release version`);
    }
    if (VALUE_OPTIONS.has(token.value) && args[index + 1]?.multipleWords) {
      refuseHook(`Unquoted or multiword expansion in the operand of ${token.value}`);
    }
    if (token.unresolved) {
      const name = literalOptionName(token);
      if (name !== undefined && name !== DATE_FLAG && name !== FALLBACK_DATE_FLAG) continue;
      refuseHook(`Unresolved option word in pm-changelog hook: ${JSON.stringify(token.value)}`);
    }
    if (token.value.startsWith(DATE_FLAG + "=")) refuseHook("Unexpected value on the boolean " + DATE_FLAG);
    if (token.value === DATE_FLAG) {
      options.push({ kind: "version", first: token, last: token });
      continue;
    }
    const separate = token.value === FALLBACK_DATE_FLAG;
    if (!separate && !token.value.startsWith(FALLBACK_DATE_FLAG + "=")) continue;
    const operand = separate ? args[index + 1] : token;
    const day = separate ? operand?.value : token.value.slice(FALLBACK_DATE_FLAG.length + 1);
    if (day === undefined || operand?.unresolved || !ISO_DAY.test(day)) {
      options.push({ kind: "missing-day", first: token, last: token });
      continue;
    }
    options.push({ kind: isRealCalendarDay(day) ? "pin" : "invalid-day", first: token, last: operand!, day });
  }
  if (options.some(option => option.kind === "version") && options.some(option => option.kind !== "version")) {
    refuseHook(`Mutually exclusive ${DATE_FLAG} and ${FALLBACK_DATE_FLAG}`);
  }
  return options;
}

/** Validate date options on the effective generator argv before editing or checking the heading. */
function hookDateOptions(args: readonly ShellToken[]): ValidDateOption[] {
  if (!hasVersionInput(args) && !args.some(({ value }) => /^--date(?:[-=]|$)/.test(value))) return [];
  const options = readReleaseDateOptions(args);
  if (!options.length) refuseHook("Versioned pm-changelog invocation without a date policy");
  return options.map(option => {
    if (option.kind === "missing-day" || option.kind === "invalid-day") refuseHook("Invalid --date-fallback operand, expected a real YYYY-MM-DD day");
    return option;
  });
}

/** Normalize calendar padding while preserving the release's sequence suffix. */
function calendarRelease(version: string | undefined): { day: string; suffix: string } {
  const match = version?.trim().match(/^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(-\d+)?$/i);
  if (match) {
    const [, year, month, date, suffix = ""] = match;
    const day = `${year}-${month.padStart(2, "0")}-${date.padStart(2, "0")}`;
    // The generator validates with Date.UTC, which shifts years 0 to 99.
    if (Number(year) >= 100 && isRealCalendarDay(day)) return { day, suffix };
  }
  throw new Error(`Cannot verify the prepared release heading for calendar version ${JSON.stringify(version)}. A valid calendar version is required. ${RETIRE_UNPUBLISHED}`);
}

/** Read the last explicit version option, which takes precedence over the manifest. */
function literalReleaseVersion(args: ShellCommand, positions: readonly number[]): string | undefined {
  let version: string | undefined;
  for (const i of positions) {
    const word = args[i].value;
    const equals = word.indexOf("=");
    const flag = equals === -1 ? word : word.slice(0, equals);
    if (flag === "--version" || flag === "--release-version") {
      version = equals === -1 ? args[i + 1]?.value ?? "" : word.slice(equals + 1);
    }
  }
  return version;
}

/** Ensure a literal version selects the same release as the stamped manifest. */
function assertReleaseCoordinate(explicit: string | undefined, packageVersion: string | undefined, advice = ""): void {
  if (explicit === undefined || packageVersion === undefined) return;
  const actual = calendarRelease(explicit);
  const expected = calendarRelease(packageVersion);
  if (actual.day + actual.suffix !== expected.day + expected.suffix) {
    throw new Error(`Prepared release version ${JSON.stringify(explicit)} does not match package release version ${JSON.stringify(packageVersion)}.${advice}`);
  }
}

/** Compare the options on one generator command with the verified merge day and release coordinate. */
function assertHeadingOptions(words: ShellCommand, mergeDay: string, packageVersion?: string, names?: ReadonlySet<string>): void {
  const args = changelogInvocation(words, names)?.slice(1) ?? [];
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

/** All-tags generation uses an explicit cutoff as the pending release timestamp. */
function assertAllTagsCutoff(
  args: ShellCommand, positions: readonly number[], headingDate: string, packageVersion?: string, advice = "",
): void {
  if (!hasVersionInput(args) || !positions.some(i => args[i].value === "--all-release-tags")) return;
  for (const i of positions) {
    const token = args[i];
    const [flag] = token.value.split("=", 1);
    if (flag !== UNTIL_FLAG) continue;
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
export function assertReleaseHeadingDate(scripts: readonly string[], mergeDay: string, packageVersion?: string, scriptNames?: ReadonlySet<string>): void {
  for (const script of scripts) {
    for (const words of standaloneHookCommands(parseReleaseHook(script).commands, scriptNames)) assertHeadingOptions(words, mergeDay, packageVersion, scriptNames);
  }
}

/** Verify the complete generator argv from each release hook before publication. */
export function assertReleaseHookHeadingDate(
  scripts: ReadonlyMap<string, string>, hooks: readonly string[], mergeDay: string, packageVersion?: string, lifecycle: NpmLifecycle = "unknown",
): void {
  visitChangelogScriptCommands(scripts, ({ effective, names }) => assertHeadingOptions(effective, mergeDay, packageVersion, names), hooks,
    undefined, undefined, { lifecycle });
}

type HookEdit = ShellTokenSpan & { text: string };

/** Apply source edits back to front so their offsets stay valid. */
function applyHookEdits(script: string, edits: Iterable<HookEdit>): string {
  for (const { start, end, text } of [...edits].sort((a, b) => b.start - a.start)) {
    script = script.slice(0, start) + text + script.slice(end);
  }
  return script;
}

/** Enable empty sections on each generator while preserving shell operators and redirections. */
export function includeEmptyReleaseSections(script: string, scriptNames?: ReadonlySet<string>): string {
  const { commands, spans } = parseReleaseHook(script);
  const edits = new Map<number, HookEdit>();
  for (const words of standaloneHookCommands(commands, scriptNames)) {
    const invocation = changelogInvocation(words, scriptNames);
    if (invocation === undefined || optionPositions(invocation.slice(1)).some(i => invocation[i + 1].value === INCLUDE_EMPTY_FLAG)) continue;
    const token = invocation.at(-1)!;
    const last = spans.get(token)!;
    // A caller can supply the operand of the final option. Insert before an
    // open option so its operand remains adjacent across the script boundary.
    const before = VALUE_OPTIONS.has(token.value) && optionPositions(invocation.slice(1)).includes(invocation.length - 2);
    const offset = before ? last.start : last.end;
    edits.set(offset, { start: offset, end: offset, text: before ? INCLUDE_EMPTY_FLAG + " " : " " + INCLUDE_EMPTY_FLAG });
  }
  return applyHookEdits(script, edits.values());
}

/** Count npm option boundaries between a configured custom hook and its final executable. */
function customForwardDelimiters(invocation: ShellCommand, scripts: ReadonlyMap<string, string>, hasGenerator: boolean): number | undefined {
  const names = new Set(scripts.keys());
  let count = 0;
  let blockedTarget: string | undefined;
  for (let depth = 0; depth <= MAX_SCRIPT_FORWARDS; depth++) {
    const program = basename(invocation[0].value);
    const forward = scriptForward(program, invocation.slice(1), names);
    if (!forward) {
      // Preserve a generator's trailing status checks, logging and Git steps.
      if (hasGenerator && (generatorCommand(invocation) || DATA_CONSUMERS.has(program)
        || [":", "true", "false", "git"].includes(program))) return undefined;
      if (blockedTarget) refuseHook("Custom script " + JSON.stringify(blockedTarget) + " cannot receive forwarded arguments. Move the logic into a script file");
      return count;
    }
    if (forward.runner === "npm" && !forward.npmSeparator) count++;
    const text = scripts.get(forward.target!);
    if (!text) return hasGenerator ? undefined : count; // An optional missing target runs no command.
    const { commands, spans } = parseReleaseHook(text);
    const recipient = commandReceivingArguments(text, commands, spans);
    if (!recipient) blockedTarget = forward.target;
    const next = releaseHookCommand(recipient ? [...recipient, ...forward.args] : commands.at(-1) ?? []);
    if (!next) refuseHook("Custom script " + JSON.stringify(forward.target) + " cannot receive forwarded arguments. Move the logic into a script file");
    invocation = next;
  }
  refuseHook("Custom script forward depth exceeds " + MAX_SCRIPT_FORWARDS);
}

/** Save the flag and any npm delimiters on the root caller, preserving shared target scripts. */
export function includeEmptyCustomHook(script: string, scripts: ReadonlyMap<string, string>, hasGenerator = false): string {
  const { commands, spans } = parseReleaseHook(script);
  const invocation = releaseHookCommand(commands.at(-1) ?? []);
  if (!invocation) return script;
  const [program, ...args] = invocation;
  const separator = scriptForward(basename(program.value), args)?.npmSeparator;
  const boundary = separator ? args.indexOf(separator) : -1;
  const flag = args.slice(boundary + 1).find(word => word.value === INCLUDE_EMPTY_FLAG);
  const edits: HookEdit[] = [];
  for (const word of args.slice(0, Math.max(0, boundary))) {
    if (word.value !== INCLUDE_EMPTY_FLAG) continue;
    const { start, end } = spans.get(word)!;
    const padding = /^[ \t]*/.exec(script.slice(end))![0].length;
    edits.push({ start, end: end + padding, text: "" });
  }
  const count = customForwardDelimiters(invocation, scripts, hasGenerator);
  if (count === undefined) return script; // The generator receives the flag in its own script.
  if (!flag || count > 0) {
    const offset = flag ? spans.get(flag)!.start : spans.get(invocation.at(-1)!)!.end;
    const text = flag ? "-- ".repeat(count) : " " + "-- ".repeat(count) + INCLUDE_EMPTY_FLAG;
    edits.push({ start: offset, end: offset, text });
  }
  return applyHookEdits(script, edits);
}

/** An empty replacement restores the standing version policy. */
function validateReplacementDay(headingDate: string): void {
  if (headingDate && !isRealCalendarDay(headingDate)) {
    refuseHook("Release heading date must be YYYY-MM-DD and name a real calendar day, received " + JSON.stringify(headingDate));
  }
}

/** Refresh the inline pins, or restore the standing policy for a current version. */
export function rewriteReleaseHeadingDate(script: string, headingDate: string, scriptNames?: ReadonlySet<string>): string {
  validateReplacementDay(headingDate);
  const { commands, spans } = parseReleaseHook(script);
  const source = { text: script, spans, edits: new Map<number, HookEdit>() };
  const options = [...standaloneHookCommands(commands, scriptNames)].flatMap(words => hookDateOptions(changelogInvocation(words, scriptNames)?.slice(1) ?? []));
  rewriteDateOptions(options, headingDate, () => source);
  return applyHookEdits(script, source.edits.values());
}

type EditableScript = Pick<ChangelogScriptCommand, "text" | "spans"> & { edits: Map<number, HookEdit> };

/** Pin or restore the original words, even when a caller supplied the date operand. */
function rewriteDateOptions(options: ValidDateOption[], headingDate: string, sourceOf: (token: ShellToken) => EditableScript): void {
  const replacement = headingDate ? FALLBACK_DATE_FLAG + " " + headingDate : DATE_FLAG;
  for (const option of options) {
    if (option.kind === "version" && !headingDate) continue;
    const firstSource = sourceOf(option.first);
    const lastSource = sourceOf(option.last);
    const first = firstSource.spans.get(option.first)!;
    const last = lastSource.spans.get(option.last)!;

    // A redirection between the option and its operand can be dropped from
    // argv by commandCandidates. Preserve it when rewriting the source.
    if (firstSource !== lastSource || (option.first !== option.last
      && !/^(?:[ \t\r]|\\\n)*$/.test(firstSource.text.slice(first.end, last.start)))) {
      lastSource.edits.set(last.start, { ...last, text: "" });
      firstSource.edits.set(first.start, { ...first, text: replacement });
    } else {
      firstSource.edits.set(first.start, { start: first.start, end: last.end, text: replacement });
    }
  }
}

/** Rewrite all heading options received by the manifest's resolved release hooks. */
export function rewriteReleaseHookDates(
  scripts: ReadonlyMap<string, string>, hooks: readonly string[], headingDate: string, lifecycle: NpmLifecycle = "unknown",
  packageVersion?: string,
): Map<string, string> {
  validateReplacementDay(headingDate);
  const sources = new Map<string, EditableScript>();
  const owners = new WeakMap<ShellToken, EditableScript>();
  visitChangelogScriptCommands(scripts, ({ name, names, text, spans, words, effective, forwardedSeparators }) => {
    let source = sources.get(name);
    if (!source) {
      source = { text, spans, edits: new Map() };
      sources.set(name, source);
    }
    for (const token of words) owners.set(token, source);
    const args = changelogInvocation(effective, names)?.slice(1) ?? [];
    const options = hookDateOptions(args);
    const positions = optionPositions(args);
    if (options.length) assertReleaseCoordinate(literalReleaseVersion(args, positions), packageVersion);
    assertAllTagsCutoff(args, positions, headingDate, packageVersion);
    rewriteDateOptions(options, headingDate, token => owners.get(token)!);
    if (options.length > 0) {
      for (const separator of forwardedSeparators) {
        const owner = owners.get(separator)!;
        const span = owner.spans.get(separator)!;
        const space = /^[ \t]*/.exec(owner.text.slice(span.end))![0];
        owner.edits.set(span.start, { start: span.start, end: span.end + space.length, text: "" });
      }
    }
  }, hooks, undefined, undefined, { lifecycle });
  return new Map([...sources].map(([name, { text, edits }]) => [name, applyHookEdits(text, edits.values())]));
}
