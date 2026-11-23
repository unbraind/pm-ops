/** Shared shell classifications for release hooks and executable workflow bodies. */
/** Identify a construct outside the grammar in its current execution context. */
export function unsupportedReleaseConstruct(construct, scope, shell = "bash") {
    if (construct === "pipefail")
        return scope === "workflow" && shell === "sh";
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
    return utility ? /^[^=]+=/.test(word.value) : !word.startsQuoted && /^[A-Za-z_]\w*\+?=/.test(word.value);
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
/** Find an unsupported reserved word in unquoted command position. */
export function unsupportedReleaseCommand(words, scope) {
    let negation;
    for (const word of words) {
        const raw = word.replaceAll("\\\n", "");
        if (/^\(*time$/.test(raw) && unsupportedReleaseConstruct("time prefix", scope))
            return "time prefix";
        if (/^\(*!$/.test(raw)) {
            if (unsupportedReleaseConstruct("shell negation", scope))
                negation = "shell negation";
            continue;
        }
        if (/^(?:\(+|\{|if|then|elif|else|do|while|until)$/.test(raw))
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
//# sourceMappingURL=release-shell-constructs.js.map