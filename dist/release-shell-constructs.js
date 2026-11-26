/** Shared shell classifications for release hooks and executable workflow bodies. */
/** Identify a construct outside the grammar in its current execution context. */
export function unsupportedReleaseConstruct(construct, scope, shell = "bash") {
    if (construct === "pipefail")
        return shell === "sh";
    return construct === "container job" ? scope === "workflow" : scope === "hook";
}
/** Stable diagnostic code for package hook grammar refusals. */
export const UNSUPPORTED_RELEASE_HOOK = "release_hook_unsupported_construct";
/** Report a grammar refusal with owning hook and migration advice. */
export function describeUnsupportedReleaseHook(construct, hook) {
    if (construct === "time prefix")
        construct += " is not supported in release hooks or publish steps; remove it or time the step from the workflow";
    return `${UNSUPPORTED_RELEASE_HOOK}: ${construct} in hook ${JSON.stringify(hook)}. Simplify the hook to the supported forms, or move the logic into a script file.`;
}
/** A shell prefix requires an unquoted identifier. The env utility accepts any nonempty name. */
export function isShellAssignment(word, utility = false) {
    if (utility)
        return /^[^=]+=/.test(word.value);
    const raw = literalWords.get(word);
    return /^[A-Za-z_]\w*\+?=/.test(raw === undefined ? word.startsQuoted ? "" : word.value : raw);
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
/** Shell control prefixes that can be followed by a reserved word. */
const CONTROL_PREFIX = /^(?:\(+|\{|!|if|then|elif|else|do|while|until)$/;
/** Recognize a standalone brace reserved word at a command boundary. */
export function isReleaseGroupBrace(brace, words) {
    if (brace === "}")
        return words.length === 0;
    const source = words.map(word => literalWords.get(word));
    // Bash accepts a function header with no parentheses before the group.
    const prefix = source.at(-2) === "function" ? source.slice(0, -2) : source;
    return prefix.every(raw => raw !== undefined && CONTROL_PREFIX.test(raw));
}
/** Preserve lexical spelling before quote removal, including words inside an evaluator. */
export function recordReleaseShellWord(word, raw) {
    literalWords.set(word, raw);
}
/** Classify lexical command prefixes without tracking their execution scopes. */
export function releaseCommandConstructs(commands, scope) {
    const problems = new Map();
    for (const command of commands) {
        const source = command.filter(word => !word.releaseKeyword);
        const words = source.map(word => literalWords.get(word));
        const construct = unsupportedReleaseCommand(words, scope);
        if (construct)
            problems.set(command, construct);
    }
    return problems;
}
/** Find an unsupported reserved word in unquoted command position. */
function unsupportedReleaseCommand(words, scope) {
    let negation;
    for (const raw of words) {
        if (raw === undefined)
            break;
        if (/^\(*time$/.test(raw))
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
    } while (true);
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