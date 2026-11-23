/** Shared shell classifications for release hooks and executable workflow bodies. */
/** Identify a construct outside the grammar in its current execution context. */
export function unsupportedReleaseConstruct(construct, scope, shell = "bash") {
    if (construct === "pipefail")
        return scope === "workflow" && shell === "sh";
    return scope === "hook";
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
/** Count the characters occupied by a shell case arm terminator. */
export function shellCaseTerminator(text, index) {
    if (text.startsWith(";;&", index))
        return 3;
    return text.startsWith(";;", index) || text.startsWith(";&", index) ? 2 : 0;
}
//# sourceMappingURL=release-shell-constructs.js.map