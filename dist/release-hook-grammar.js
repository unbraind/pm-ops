/**
 * Lex the release-hook language without evaluating shell. Every input character
 * belongs to a literal word, a quoted value, a separator, or an unsupported
 * construct retained on its command. Source spans always refer to the input.
 */
import { basename } from "node:path";
import { heredocBodyLines, heredocExpansionLines, isRedirectionSuffix, recordShellRedirection, releaseHookCommand, shellRedirection, } from "./shell-scan.js";
const problems = new WeakMap();
const indirectTargets = new WeakSet();
const variableReferences = new WeakMap();
const optionNames = new WeakMap();
const isolatedCommands = new WeakSet();
const loopConditions = new WeakSet();
const continuedDescriptors = new WeakSet();
const braceExpansions = new WeakSet();
const BRACE_EXPANSION = /(?<!\$)\{(?:[^{}]*,[^{}]*|(?:-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.-?\d+)?)\}/;
const VARIABLE_REFERENCE = /^(?:\\\n)*(?:\{(?:\\\n)*[!#]?(?:\\\n)*)?([A-Za-z_](?:\w|\\\n)*)/;
/** Whether shell edits in this command are local to a pipeline stage or subshell. */
export function isIsolatedReleaseCommand(words) {
    return isolatedCommands.has(words[0]);
}
/** Whether the command belongs to the condition list of a while or until loop. */
export function isReleaseLoopCondition(words) {
    return loopConditions.has(words[0]);
}
/** Whether the shell joined source lines inside a descriptor redirection. */
export function isContinuedDescriptor(word) {
    return continuedDescriptors.has(word);
}
/** Whether this word includes unquoted shell brace expansion. */
export function hasBraceExpansion(word) {
    return braceExpansions.has(word);
}
/** Return the first unsupported construct in the command. */
export function hookSyntaxProblem(words) {
    return words.map(word => problems.get(word)).find(problem => problem !== undefined);
}
/** Literal generator references and shell words referencing a local generator binding. */
export function mentionsGenerator(word) {
    return word.value.includes("pm-changelog") || word.value.includes("dist/cli.js") || indirectTargets.has(word);
}
/** Return the variable expanded by this word that is inherited from a script runner. */
export function inheritedVariable(word, bindings) {
    return variableReferences.get(word)?.find(name => bindings.has(name));
}
/** A fixed option name with a quoted, single-word dynamic value. */
export function literalOptionName(word) {
    return optionNames.get(word);
}
/** One actionable diagnostic across verification, preparation and continuation. */
export function refuseHook(construct) {
    throw new Error(construct + ". Use a direct pm-changelog invocation with literal option names and one date policy, or npm run <script> -- <args>.");
}
/** Describe a context the release manifest cannot represent. */
export function describeReleaseContextChange(construct) {
    return "Unsupported release hook context change " + construct + ". Run the generator from the root package directory";
}
/** Split only on unquoted shell list operators. Never execute or recursively guess a payload. */
export function parseReleaseHook(text) {
    const commands = [];
    const spans = new WeakMap();
    const bindings = new Set();
    let words = [];
    const piped = new Set();
    const loops = [];
    let subshellDepth = 0;
    let inSubshell = false;
    let heredoc = -1;
    let heredocComment = -1;
    /** Retain unsupported subshell commands for inspection without propagating their edits. */
    function finishCommand() {
        if (words.length > 0) {
            for (const word of words) {
                if (word.quoted || !/^(?:while|until|for|select|do|done|if|then|elif|else|\{|!)$/.test(word.value))
                    break;
                const span = spans.get(word);
                if (text.slice(span.start, span.end).replaceAll("\\\n", "") !== word.value)
                    break;
                if (/^(?:while|until|for|select)$/.test(word.value))
                    loops.push(/^(?:while|until)$/.test(word.value));
                if (word.value === "do" && loops.length)
                    loops[loops.length - 1] = false;
                if (word.value === "done")
                    loops.pop();
            }
            if (loops.includes(true))
                loopConditions.add(words[0]);
            if (inSubshell) {
                isolatedCommands.add(words[0]);
                if (!hookSyntaxProblem(words))
                    problems.set(words[0], "Shell grouping or substitution");
            }
            commands.push(words);
        }
        words = [];
        inSubshell = subshellDepth > 0;
    }
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (/^[;&|\n]$/.test(ch) && !text.startsWith("&>", i)) {
            if (words.length) {
                if (ch === "&" && text[i + 1] !== "&")
                    problems.set(words[0], "Shell background or descriptor operator &");
                if (ch === "|" && text[i + 1] !== "|")
                    piped.add(words);
            }
            finishCommand();
            if (ch === "\n" && heredoc >= 0) {
                // Only an unquoted opener seen by this lexer can introduce data. A
                // line resembling an opener inside a multiline title stays literal.
                const lines = text.slice(heredoc).split("\n");
                if (heredocComment >= 0)
                    lines[0] = lines[0].slice(0, heredocComment - heredoc);
                const bodies = heredocBodyLines(lines);
                const expansions = heredocExpansionLines(lines);
                const start = i + 1;
                let end = start;
                let evaluates = false;
                for (let line = 1; line < lines.length && bodies[line]; line++) {
                    if (expansions[line] && /\$\(|`/.test(lines[line]))
                        evaluates = true;
                    end += lines[line].length + 1;
                }
                end = Math.min(text.length, end);
                const body = { value: text.slice(start, end), quoted: true, startsQuoted: true };
                if ((mentionsGenerator(body) || /\b(?:npm|pnpm|bun)\s+run\b/.test(body.value)) && (evaluates || !/^\s*cat\s+<<-?\s*['"]?\w+['"]?\s*$/.test(lines[0]))) {
                    problems.set(body, "Here-document with a possible generator command");
                    spans.set(body, { start, end });
                    commands.push([body]);
                }
                i = end;
                heredoc = -1;
                heredocComment = -1;
                continue;
            }
            i += /^(?:&&|\|[|&])/.test(text.slice(i, i + 2)) ? 2 : 1;
            continue;
        }
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (text.startsWith("\\\n", i)) {
            i += 2;
            continue;
        }
        if (ch === "#") {
            if (heredoc >= 0)
                heredocComment = i;
            const newline = text.indexOf("\n", i);
            i = newline < 0 ? text.length : newline;
            continue;
        }
        const start = i;
        const previous = words.at(-1);
        const destination = previous && shellRedirection(previous)?.joined === false;
        const startsQuoted = ch === "'" || ch === '"';
        let value = "";
        // Keep the position of quoted or escaped data without interpreting its braces.
        let unquoted = "";
        let quote = "";
        let problem;
        let quoted = false;
        let unresolved = false;
        let splits = false;
        let fixedName;
        const references = [];
        while (i < text.length) {
            const char = text[i];
            // Redirection operators can contain characters that otherwise end a command.
            if (!quote && /[\s;&|]/.test(char)
                && !(i === start && text.startsWith("&>", i))
                && !isRedirectionSuffix(text, start, i))
                break;
            // A new operator ends an attached or separate destination. Keep the
            // characters of >>, <>, << and <<< together until the operand starts.
            if (!quote && i > start && (char === ">" || char === "<")
                && (destination || /^(?:\d*[<>]|&>)/.test(unquoted))
                && !(char === ">" ? /^(?:\d*[<>]|&>)$/.test(unquoted) : /^\d*<{1,2}$/.test(unquoted)))
                break;
            i++;
            if (char === quote) {
                quote = "";
                continue;
            }
            if (!quote && (char === "'" || char === '"')) {
                quoted = true;
                quote = char;
                unquoted += "\0";
                continue;
            }
            if (char === "\\" && quote !== "'" && (!quote || /["$`\\\n]/.test(text[i]))) {
                if (i === text.length) {
                    problem = "Incomplete shell escape";
                    break;
                }
                const escaped = text[i++];
                if (escaped !== "\n") {
                    value += escaped;
                    if (!quote)
                        unquoted += "\0";
                }
                continue;
            }
            if (quote !== "'" && (char === "$" || char === "`")) {
                const reference = char === "$" && VARIABLE_REFERENCE.exec(text.slice(i));
                if (reference)
                    references.push(reference[1].replaceAll("\\\n", ""));
                if (!unresolved)
                    fixedName = /^(-[\w-]+)=/.exec(value)?.[1];
                unresolved = true;
                if (!quote || text[i] === "@" || text.startsWith("{@", i))
                    splits = true;
                if (char === "`" || text[i] === "(")
                    problem = "Shell command substitution";
            }
            if (quote !== "'" && char === "$" && /^\{[^}]*\[@\]/.test(text.slice(i)))
                problem = "Shell array expansion";
            if (!quote && char === "<" && text[i] === "<")
                heredoc = text.lastIndexOf("\n", i - 1) + 1;
            if (!quote && /[<>]/.test(char) && !/^\d*$/.test(value) && !/^(?:\d*[<>]|&(?:>|$))/.test(value))
                problem = "Attached shell redirection";
            if (!quote && "*?[".includes(char)) {
                unresolved = true;
                splits = true;
            }
            if (!quote && /[()]/.test(char)) {
                problem ??= "Shell grouping or substitution";
                if (subshellDepth > 0 || (char === "(" && i === start + 1
                    && words.every(word => !word.quoted && /^(?:if|then|elif|else|do|\{|!|time|-p)$/.test(word.value)))) {
                    inSubshell = true;
                    subshellDepth += char === "(" ? 1 : -1;
                }
            }
            value += char;
            if (!quote)
                unquoted += char;
        }
        if (quote)
            problem = "malformed shell arguments (unterminated quote)";
        const token = { value, startsQuoted, quoted, unresolved };
        recordShellRedirection(token, text, start, i);
        if (shellRedirection(token)?.operator.endsWith("&") && text.slice(start, i).includes("\\\n"))
            continuedDescriptors.add(token);
        if (BRACE_EXPANSION.test(unquoted))
            braceExpansions.add(token);
        if (references.length)
            variableReferences.set(token, references);
        if (inheritedVariable(token, bindings))
            indirectTargets.add(token);
        if (!startsQuoted && mentionsGenerator(token)) {
            const binding = /^([A-Za-z_][A-Za-z_0-9]*)=/.exec(value);
            if (binding)
                bindings.add(binding[1]);
        }
        if (splits)
            token.multipleWords = true;
        if (fixedName && !splits)
            optionNames.set(token, fixedName);
        if (problem)
            problems.set(token, problem);
        spans.set(token, { start, end: i });
        words.push(token);
    }
    finishCommand();
    // A pipe to an interpreter can turn printed generator text into a command.
    // Keep the ordinary output-filter pipeline used by release workflows.
    let upstream = [];
    for (const command of commands) {
        if (upstream.length || piped.has(command))
            isolatedCommands.add(command[0]);
        if (upstream.length) {
            const sink = releaseHookCommand(command)?.[0];
            if (!sink || sink.unresolved || !/^(?:cat|awk|sed|grep|head|tail|cut|tr|sort|uniq|wc)$/.test(basename(sink.value))) {
                for (const source of upstream)
                    problems.set(source[0], "Pipeline to an opaque executable");
            }
        }
        if (piped.has(command))
            upstream.push(command);
        else
            upstream = [];
    }
    return { commands, spans };
}
//# sourceMappingURL=release-hook-grammar.js.map