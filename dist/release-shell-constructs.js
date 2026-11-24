/** Shared shell classifications for release hooks and executable workflow bodies. */
/** Identify a construct outside the grammar in its current execution context. */
export function unsupportedReleaseConstruct(construct, scope, shell = "bash") {
    if (construct === "pipefail")
        return shell === "sh";
    return construct === "time prefix" || (construct === "container job" ? scope === "workflow" : scope === "hook");
}
/** Stable diagnostic code for package hook grammar refusals. */
export const UNSUPPORTED_RELEASE_HOOK = "release_hook_unsupported_construct";
/** Report a grammar refusal with owning hook and migration advice. */
export function describeUnsupportedReleaseHook(construct, hook) {
    return `${UNSUPPORTED_RELEASE_HOOK}: ${construct} in hook ${JSON.stringify(hook)}. Simplify the hook to the supported forms, or move the logic into a script file.`;
}
/** A shell prefix requires an unquoted identifier. The env utility accepts any nonempty name. */
export function isShellAssignment(word, utility = false) {
    if (utility)
        return /^[^=]+=/.test(word.value);
    const raw = literalWords.get(word);
    return /^[A-Za-z_]\w*\+?=/.test(raw === undefined ? word.startsQuoted ? "" : word.value : raw.replaceAll("\\\n", ""));
}
/** Whether a backslash introduces an escape inside double quotes. */
export function isDoubleQuotedShellEscape(next) {
    return /["$`\\\n]/.test(next);
}
/** A case can read its next pattern or the remaining words in a started pattern. */
export function inShellCasePattern(state) {
    return state === "pattern" || state === "pattern-data";
}
/** Classify case words before a scanner treats them as executable argv. */
export function readShellCaseWord(stack, value, literal, commandStart) {
    const state = stack.at(-1);
    if (inShellCasePattern(state)) {
        if (state === "pattern" && literal && value === "esac") {
            stack.pop();
            return "close";
        }
        stack[stack.length - 1] = "pattern-data";
        return "pattern";
    }
    if (state === "subject") {
        stack[stack.length - 1] = "in";
        return "header";
    }
    if (state === "in" && literal && value === "in") {
        stack[stack.length - 1] = "pattern";
        return "header";
    }
    if (commandStart && literal && value === "case") {
        stack.push("subject");
        return "open";
    }
    if (state === "body" && commandStart && literal && value === "esac") {
        stack.pop();
        return "close";
    }
    return undefined;
}
const literalWords = new WeakMap();
const pipedToNext = new WeakSet();
const timedGroupCommands = new WeakSet();
/** Shell control prefixes that can be followed by a reserved word. */
const CONTROL_PREFIX = /^(?:\(+|\{|!|if|then|elif|else|do|while|until)$/;
/** Recognize a standalone brace reserved word at a command boundary. */
export function isReleaseGroupBrace(brace, words) {
    if (brace === "}")
        return words.length === 0;
    const source = words.map(word => literalWords.get(word)?.replaceAll("\\\n", ""));
    // Bash accepts a function header with no parentheses before the group.
    const prefix = source.at(-2) === "function" ? source.slice(0, -2) : source;
    return prefix.every(raw => raw !== undefined && (CONTROL_PREFIX.test(raw) || raw === "time" || raw === "-p" && hasReleaseTiming(words)));
}
/** Whether a command is governed by a timing prefix, directly or through a group. */
export function hasReleaseTiming(command) {
    return timedGroupCommands.has(command) || unsupportedReleaseCommand(command.map(word => literalWords.get(word)), "workflow") === "time prefix";
}
/** Associate commands with a timing prefix outside their compound command. */
export function recordTimedReleaseGroup(command) {
    timedGroupCommands.add(command);
}
/** Preserve physical words even for commands reconstructed inside an evaluator. */
export function recordReleaseShellWord(word, raw) {
    literalWords.set(word, raw);
}
/** Record when the next command is a stage of the same shell pipeline. */
export function recordReleasePipeline(words) {
    pipedToNext.add(words);
}
/** Apply the same construct rules and pipeline scope to every shell reader. */
export function releaseCommandConstructs(commands, scope, rawWord) {
    const problems = new Map();
    let pipelineProblem;
    for (const command of commands) {
        const source = command.filter(word => !word.releaseKeyword);
        const physical = rawWord && source.map(rawWord);
        const words = physical?.every(word => word !== undefined) ? physical : source.map(word => literalWords.get(word));
        const construct = pipelineProblem ?? (timedGroupCommands.has(command) ? "time prefix" : unsupportedReleaseCommand(words, scope));
        if (construct)
            problems.set(command, construct);
        pipelineProblem = pipedToNext.has(command) ? construct : undefined;
    }
    return problems;
}
/** Find an unsupported reserved word in unquoted command position. */
function unsupportedReleaseCommand(words, scope) {
    let negation;
    for (const word of words) {
        if (word === undefined)
            break;
        const raw = word.replaceAll("\\\n", "");
        if (/^\(*time$/.test(raw) && unsupportedReleaseConstruct("time prefix", scope))
            return "time prefix";
        if (/^\(*!$/.test(raw)) {
            if (unsupportedReleaseConstruct("shell negation", scope))
                negation = "shell negation";
            continue;
        }
        if (CONTROL_PREFIX.test(raw))
            continue;
        if (/^\(*case$/.test(raw) && unsupportedReleaseConstruct("case arms", scope))
            return "case arms";
        break;
    }
    return negation;
}
/** Count the physical source characters occupied by a case arm terminator. */
export function shellCaseTerminator(text, index) {
    const match = /^;(?:\\\n)*(?:;(?:\\\n)*&|;|&)/.exec(text.slice(index));
    return match?.[0].length ?? 0;
}
/** Read one logical shell line and retain its physical end for edits. */
export function readShellLogicalLine(text, start, joins) {
    let end = start;
    let value = "";
    let lines = 0;
    do {
        const newline = text.indexOf("\n", end);
        const line = text.slice(end, newline < 0 ? text.length : newline).replace(/\r$/, "");
        end = newline < 0 ? text.length : newline + 1;
        lines++;
        if (!joins(line) || newline < 0)
            return { value: value + line, end, lines };
        value += line.slice(0, -1);
    } while (end < text.length);
    return { value, end, lines };
}
/** An odd final backslash escapes the newline after the literal pairs. */
export function hasShellContinuation(line) {
    return /(?<!\\)(?:\\\\)*\\$/.test(line);
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
/** Unsupported modes change parsing, builtin lookup, or pipeline isolation. */
export function unsupportedReleaseShellMode([program, ...args]) {
    if (program.value === "set")
        return unsupportedSetSwitch(args);
    return /^(?:shopt|enable|alias|source|\.)$/.test(program.value) ? program.value : undefined;
}
//# sourceMappingURL=release-shell-constructs.js.map