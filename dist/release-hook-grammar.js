/**
 * Lex the release-hook language without evaluating shell. Every input character
 * belongs to a literal word, a quoted value, a separator, or an unsupported
 * construct retained on its command. Source spans always refer to the input.
 */
import { basename } from "node:path";
import { commandName, isCombinedOutputRedirect, isRedirectionSuffix, isShellEvaluator, recordShellRedirection, releaseHookCommand, shellRedirection, } from "./shell-scan.js";
import { hasShellContinuation, inShellCasePattern, readShellCaseWord, readShellLogicalLine, recordReleasePipeline, shellCaseTerminator, unsupportedReleaseConstruct, UNSUPPORTED_RELEASE_HOOK, } from "./release-shell-constructs.js";
const problems = new WeakMap();
const possibleGeneratorTargets = new WeakSet();
const variableReferences = new WeakMap();
const optionNames = new WeakMap();
const isolatedCommands = new WeakSet();
const pipelineProducers = new WeakMap();
const followingOperators = new WeakMap();
const loopConditions = new WeakSet();
const iterationHeaders = new WeakSet();
const enclosingLoops = new WeakMap();
const continuedDescriptors = new WeakSet();
const braceExpansions = new WeakSet();
const BACKGROUND_OPERATOR = "Shell background or descriptor operator &";
const OPAQUE_PIPELINE = "Pipeline to an opaque executable";
const BRACE_EXPANSION = /(?<!\$)\{(?:[^{}]*,[^{}]*|(?:-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.-?\d+)?)\}/;
const VARIABLE_REFERENCE = /^(?:\\\n)*(?:\{(?:\\\n)*[!#]?(?:\\\n)*)?([A-Za-z_](?:\w|\\\n)*)/;
/** Return the producing command upstream of a supported output filter. */
export function releaseOutputProducer(command) {
    const producer = pipelineProducers.get(command);
    const problem = producer && problems.get(producer[0]);
    if (problem === OPAQUE_PIPELINE || problem === BACKGROUND_OPERATOR)
        refuseHook(problem);
    return producer ?? command;
}
/** Return the separator for an AND-list, fallback, or pipeline stage. */
export function followingReleaseOperator(command) {
    return followingOperators.get(command);
}
/** Whether shell edits in this command are local to a pipeline stage or subshell. */
export function isIsolatedReleaseCommand(words) {
    return isolatedCommands.has(words[0]);
}
/** Whether the command belongs to the condition list of a while or until loop. */
export function isReleaseLoopCondition(words) {
    return loopConditions.has(words[0]);
}
/** Whether these words supply loop values without invoking a command. */
export function isReleaseIterationHeader(words) {
    return iterationHeaders.has(words[0]);
}
/** Find the outermost loop that can execute this command again. */
export function releaseLoopScope(words) {
    return enclosingLoops.get(words[0]);
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
/** Literal or indirect generator references, including opaque shell input. */
export function mentionsGenerator(word) {
    return word.value.includes("pm-changelog") || word.value.includes("dist/cli.js") || possibleGeneratorTargets.has(word);
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
    if (construct.startsWith(UNSUPPORTED_RELEASE_HOOK + ":"))
        throw new Error(construct);
    throw new Error(construct + ". Use a direct pm-changelog invocation with literal option names and one date policy, or npm run <script> -- <args>.");
}
/** Describe a context the release manifest cannot represent. */
export function describeReleaseContextChange(construct) {
    return "Unsupported release hook context change " + construct + ". Run the generator from the root package directory";
}
/** Check that cat reads one here-document and redirects output only to literal files. */
function isCatHeredoc(words) {
    if (words[0]?.value !== "cat")
        return false;
    let inputs = 0;
    for (let index = 1; index < words.length; index++) {
        const redirect = shellRedirection(words[index]);
        if (!redirect)
            return false;
        const target = redirect.joined ? words[index] : words[++index];
        if (!target || (!redirect.joined && shellRedirection(target)))
            return false;
        if (redirect.operator === "<<" || redirect.operator === "<<-") {
            inputs++;
        }
        else if (!/^(?:\d*>[>|]?|&>>?)$/.test(redirect.operator)
            || target.unresolved || hasBraceExpansion(target) || problems.has(target))
            return false;
    }
    return inputs === 1;
}
/** Split only on unquoted shell list operators. Never execute or recursively guess a payload. */
export function parseReleaseHook(text, scope = "hook") {
    const heredocBodies = new Map();
    const commands = [];
    const spans = new WeakMap();
    const bindings = new Set();
    let words = [];
    const piped = new Set();
    const readCases = !unsupportedReleaseConstruct("case arms", scope);
    const cases = [];
    const loops = [];
    let subshellDepth = 0;
    let inSubshell = false;
    let heredoc = -1;
    const delimiters = [];
    const heredocCommands = new Set();
    /** Retain unsupported subshell commands for inspection without propagating their edits. */
    function finishCommand() {
        if (words.length > 0) {
            for (const word of words) {
                if (word.quoted || !/^(?:while|until|for|select|do|done|if|then|elif|else|fi|\}|\{|!)$/.test(word.value))
                    break;
                const span = spans.get(word);
                if (text.slice(span.start, span.end).replaceAll("\\\n", "") !== word.value)
                    break;
                if (/^(?:if|then|elif|else|fi|do|done|while|until|\})$/.test(word.value)
                    || (word.value === "!" && !unsupportedReleaseConstruct("shell negation", scope)))
                    word.releaseKeyword = true;
                if (/^(?:while|until|for|select)$/.test(word.value)) {
                    const condition = word.value === "while" || word.value === "until";
                    if (!condition)
                        iterationHeaders.add(words[0]);
                    loops.push({ head: word, condition });
                }
                if (word.value === "do" && loops.length)
                    loops.at(-1).condition = false;
                if (word.value === "done")
                    loops.pop();
            }
            if (loops.some(loop => loop.condition))
                loopConditions.add(words[0]);
            if (loops.length)
                enclosingLoops.set(words[0], loops[0].head);
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
        const inPattern = inShellCasePattern(cases.at(-1));
        if (inPattern && (ch === "(" || ch === "|" || ch === ")")) {
            if (ch === ")")
                cases[cases.length - 1] = "body";
            if (ch === "(")
                cases[cases.length - 1] = "pattern-data";
            i++;
            continue;
        }
        const armEnd = cases.at(-1) === "body" && ch === ";" ? shellCaseTerminator(text, i) : 0;
        if (armEnd) {
            finishCommand();
            cases[cases.length - 1] = "pattern";
            i += armEnd;
            continue;
        }
        if (/^[;&|\n]$/.test(ch) && !isCombinedOutputRedirect(text, i)) {
            let next = i + 1;
            while (text.startsWith("\\\n", next))
                next += 2;
            const operator = ch + (text[next] ?? "");
            const opener = words;
            if (words.length) {
                if (ch === "&" && operator !== "&&")
                    problems.set(words[0], BACKGROUND_OPERATOR);
                if (operator === "&&")
                    followingOperators.set(words, "and");
                if (ch === "|") {
                    followingOperators.set(words, operator === "||" ? "or" : "pipe");
                    if (operator !== "||") {
                        piped.add(words);
                        recordReleasePipeline(words);
                    }
                }
            }
            finishCommand();
            if (ch === "\n" && heredoc >= 0) {
                // Only an unquoted opener seen by this lexer can introduce data. A
                // line resembling an opener inside a multiline title stays literal.
                const start = i + 1;
                let end = start;
                const expandable = [];
                for (const delimiter of delimiters) {
                    while (end < text.length) {
                        const line = readShellLogicalLine(text, end, value => delimiter.expand && hasShellContinuation(value));
                        end = line.end;
                        if ((delimiter.stripTabs ? line.value.replace(/^\t+/, "") : line.value) === delimiter.value)
                            break;
                        if (delimiter.expand)
                            expandable.push(line.value);
                    }
                }
                delimiters.length = 0;
                const body = { value: text.slice(start, end), quoted: true, startsQuoted: true };
                const standalone = !text.slice(heredoc, spans.get(opener[0])?.start ?? i).trim();
                for (const first of heredocCommands) {
                    for (let index = first; index < commands.length; index++) {
                        const stage = commands[index];
                        if (isShellEvaluator(commandName(stage) ?? ""))
                            possibleGeneratorTargets.add(body);
                        if (!piped.has(stage))
                            break;
                    }
                }
                // Logical lines already omit continued newlines. Escaped expansion markers are data.
                const expanded = expandable.join("\n").replace(/\\[\\$`]/g, "\0");
                const evaluates = /\$\(|`/.test(expanded);
                if (evaluates)
                    possibleGeneratorTargets.add(body);
                heredocCommands.clear();
                if ((mentionsGenerator(body) || /\b(?:npm|pnpm|bun)\s+run\b/.test(body.value)) && (evaluates || !standalone || !isCatHeredoc(opener))) {
                    problems.set(body, "Here-document with a possible generator command");
                    spans.set(body, { start, end });
                    commands.push([body]);
                }
                else
                    heredocBodies.set(opener, body);
                i = end;
                heredoc = -1;
                continue;
            }
            i = /^(?:&&|\|[|&])$/.test(operator) ? next + 1 : i + 1;
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
        let escapedDelimiter = false;
        let fixedName;
        const references = [];
        while (i < text.length) {
            const char = text[i];
            if (!quote && inPattern && char === ")")
                break;
            // Redirection operators can contain characters that otherwise end a command.
            if (!quote && /[\s;&|]/.test(char)
                && !(i === start && isCombinedOutputRedirect(text, i))
                && !isRedirectionSuffix(text, start, i))
                break;
            if (!quote && text.startsWith("<<", i) && !/^[0-9<]*$/.test(value))
                break;
            // A new operator ends an attached or separate destination. Keep the
            // characters of >>, <>, << and <<< together until the operand starts.
            if (!quote && i > start && (char === ">" || char === "<")
                && (destination || /^(?:\d*[<>]|&>)/.test(unquoted))
                && !(char === ">" ? /^(?:\d*[<>]|&>)$/.test(unquoted) : /^\d*<{1,2}$/.test(unquoted)))
                break;
            if (!quote && /[<>]/.test(char) && !/^\d*$/.test(unquoted) && !/^(?:\d*[<>]|&(?:>|$))/.test(unquoted)) {
                break;
            }
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
                    escapedDelimiter = true;
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
        const caseWord = readCases && readShellCaseWord(cases, value, !quoted && !unresolved && !escapedDelimiter, (value === "case" || value === "esac")
            && words.every(word => !word.quoted && /^(?:if|then|elif|else|do|\{|!)$/.test(word.value)));
        if (caseWord === "open" || caseWord === "close")
            finishCommand();
        if (caseWord && problem !== "Shell command substitution")
            continue;
        const token = { value, startsQuoted, quoted, unresolved };
        recordShellRedirection(token, text, start, i);
        const redirect = shellRedirection(token);
        if (redirect && /^\d*<<-?$/.test(redirect.operator)) {
            if (heredoc < 0)
                heredoc = text.lastIndexOf("\n", start - 1) + 1;
            heredocCommands.add(commands.length);
        }
        const input = redirect?.joined ? redirect : previous && shellRedirection(previous);
        if (input && /^\d*<<-?$/.test(input.operator) && (redirect?.joined || !input.joined && !redirect)) {
            delimiters.push({ value: redirect ? value.slice(input.operator.length) : value,
                stripTabs: input.operator.endsWith("-"), expand: !quoted && !escapedDelimiter });
        }
        if (shellRedirection(token)?.operator.endsWith("&") && text.slice(start, i).includes("\\\n"))
            continuedDescriptors.add(token);
        if (BRACE_EXPANSION.test(unquoted))
            braceExpansions.add(token);
        if (references.length)
            variableReferences.set(token, references);
        if (inheritedVariable(token, bindings))
            possibleGeneratorTargets.add(token);
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
        // Patterns and subjects are data, but substitutions inside them still run.
        if (caseWord)
            commands.push([token]);
        else
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
            const name = sink ? basename(sink.value) : "";
            pipelineProducers.set(command, upstream[0]);
            if (problems.get(command[0]) === BACKGROUND_OPERATOR) {
                problems.set(upstream[0][0], BACKGROUND_OPERATOR);
            }
            else if (sink?.unresolved || !/^(?:cat|awk|sed|grep|head|tail|cut|tr|sort|tee|uniq|wc)$/.test(name)
                || (name === "tee" && hookSyntaxProblem(command))) {
                for (const source of upstream)
                    problems.set(source[0], OPAQUE_PIPELINE);
            }
        }
        if (piped.has(command))
            upstream.push(command);
        else
            upstream = [];
    }
    return { commands, spans, heredocBodies };
}
//# sourceMappingURL=release-hook-grammar.js.map