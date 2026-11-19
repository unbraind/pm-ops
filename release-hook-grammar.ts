/**
 * Lex the release-hook language without evaluating shell. Every input character
 * belongs to a literal word, a quoted value, a separator, or an unsupported
 * construct retained on its command. Source spans always refer to the input.
 */
import { basename } from "node:path";
import { heredocBodyLines, heredocExpansionLines, recordShellRedirection, releaseHookCommand, type ShellCommand, type ShellToken, type ShellTokenSpan } from "./shell-scan.ts";

const problems = new WeakMap<ShellToken, string>();
const indirectTargets = new WeakSet<ShellToken>();
const optionNames = new WeakMap<ShellToken, string>();
const isolatedCommands = new WeakSet<ShellCommand>();

/** Whether shell edits in this command are local to a pipeline stage or subshell. */
export function isIsolatedReleaseCommand(words: ShellCommand): boolean {
  return isolatedCommands.has(words);
}

/** Return the first unsupported construct in the command. */
export function hookSyntaxProblem(words: ShellCommand): string | undefined {
  return words.map(word => problems.get(word)).find(problem => problem !== undefined);
}

/** Literal generator references and shell words referencing a local generator binding. */
export function mentionsGenerator(word: ShellToken): boolean {
  return word.value.includes("pm-changelog") || word.value.includes("dist/cli.js") || indirectTargets.has(word);
}

/** A fixed option name with a quoted, single-word dynamic value. */
export function literalOptionName(word: ShellToken): string | undefined {
  return optionNames.get(word);
}

/** One actionable diagnostic across verification, preparation and continuation. */
export function refuseHook(construct: string): never {
  throw new Error(construct + ". Use a direct pm-changelog invocation with literal option names and one date policy, or npm run <script> -- <args>.");
}

/** Describe a context the release manifest cannot represent. */
export function describeReleaseContextChange(construct: string): string {
  return "Unsupported release hook context change " + construct + ". Run the generator from the root package directory";
}

/** Split only on unquoted shell list operators. Never execute or recursively guess a payload. */
export function parseReleaseHook(text: string): { commands: ShellCommand[]; spans: WeakMap<ShellToken, ShellTokenSpan> } {
  const commands: ShellCommand[] = [];
  const spans = new WeakMap<ShellToken, ShellTokenSpan>();
  const bindings = new Set<string>();
  let words: ShellCommand = [];
  const piped = new Set<ShellCommand>();
  let subshellDepth = 0;
  let inSubshell = false;
  let heredoc = -1;
  let heredocComment = -1;

  /** Retain unsupported subshell commands for inspection without propagating their edits. */
  function finishCommand(): void {
    if (words.length > 0) {
      if (inSubshell) {
        isolatedCommands.add(words);
        if (!hookSyntaxProblem(words)) problems.set(words[0], "Shell grouping or substitution");
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
        if (ch === "&" && text[i + 1] !== "&") problems.set(words[0], "Shell background or descriptor operator &");
        if (ch === "|" && text[i + 1] !== "|") piped.add(words);
      }
      finishCommand();
      if (ch === "\n" && heredoc >= 0) {
        // Only an unquoted opener seen by this lexer can introduce data. A
        // line resembling an opener inside a multiline title stays literal.
        const lines = text.slice(heredoc).split("\n");
        if (heredocComment >= 0) lines[0] = lines[0].slice(0, heredocComment - heredoc);
        const bodies = heredocBodyLines(lines);
        const expansions = heredocExpansionLines(lines);
        const start = i + 1;
        let end = start;
        let evaluates = false;
        for (let line = 1; line < lines.length && bodies[line]; line++) {
          if (expansions[line] && /\$\(|`/.test(lines[line])) evaluates = true;
          end += lines[line].length + 1;
        }
        end = Math.min(text.length, end);
        const body: ShellToken = { value: text.slice(start, end), quoted: true, startsQuoted: true };
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
    if (/\s/.test(ch)) { i++; continue; }
    if (text.startsWith("\\\n", i)) { i += 2; continue; }
    if (ch === "#") {
      if (heredoc >= 0) heredocComment = i;
      const newline = text.indexOf("\n", i);
      i = newline < 0 ? text.length : newline;
      continue;
    }
    const start = i;
    const startsQuoted = ch === "'" || ch === '"';
    let value = "";
    let quote = "";
    let problem: string | undefined;
    let quoted = false;
    let unresolved = false;
    let splits = false;
    let fixedName: string | undefined;
    while (i < text.length) {
      const char = text[i];
      // Redirection operators can contain characters that otherwise end a command.
      if (!quote && /[\s;&|]/.test(char)
        && !(char === "&" && (i === start ? text[i + 1] === ">" : /^[0-9]*[<>]>?$/.test(text.slice(start, i))))
        && !(char === "|" && /^[0-9]*>$/.test(text.slice(start, i)))) break;
      i++;
      if (char === quote) { quote = ""; continue; }
      if (!quote && (char === "'" || char === '"')) { quoted = true; quote = char; continue; }
      if (char === "\\" && quote !== "'" && (!quote || /["$`\\\n]/.test(text[i]))) {
        if (i === text.length) { problem = "Incomplete shell escape"; break; }
        const escaped = text[i++];
        if (escaped !== "\n") value += escaped;
        continue;
      }
      if (quote !== "'" && (char === "$" || char === "`")) {
        if (!unresolved) fixedName = /^(-[\w-]+)=/.exec(value)?.[1];
        unresolved = true;
        if (!quote || text[i] === "@" || text.startsWith("{@", i)) splits = true;
        if (char === "`" || text[i] === "(") problem = "Shell command substitution";
      }
      if (quote !== "'" && char === "$" && /^\{[^}]*\[@\]/.test(text.slice(i))) problem = "Shell array expansion";
      if (!quote && char === "<" && text[i] === "<") heredoc = text.lastIndexOf("\n", i - 1) + 1;
      if (!quote && /[<>]/.test(char) && !/^\d*$/.test(value) && !/^(?:\d*[<>]|&(?:>|$))/.test(value)) problem = "Attached shell redirection";
      if (!quote && "*?[".includes(char)) { unresolved = true; splits = true; }
      if (!quote && /[()]/.test(char)) {
        problem ??= "Shell grouping or substitution";
        if (subshellDepth > 0 || (char === "(" && i === start + 1
          && words.every(word => !word.quoted && /^(?:if|then|elif|else|do|\{|!|time|-p)$/.test(word.value)))) {
          inSubshell = true;
          subshellDepth += char === "(" ? 1 : -1;
        }
      }
      value += char;
    }
    if (quote) problem = "malformed shell arguments (unterminated quote)";
    const token: ShellToken = { value, startsQuoted, quoted, unresolved };
    recordShellRedirection(token, text, start, i);
    if (unresolved && [...value.matchAll(/\$\{?([A-Za-z_][A-Za-z_0-9]*)/g)].some(match => bindings.has(match[1]))) indirectTargets.add(token);
    if (!startsQuoted && mentionsGenerator(token)) {
      const binding = /^([A-Za-z_][A-Za-z_0-9]*)=/.exec(value);
      if (binding) bindings.add(binding[1]);
    }
    if (splits) token.multipleWords = true;
    if (fixedName && !splits) optionNames.set(token, fixedName);
    if (problem) problems.set(token, problem);
    spans.set(token, { start, end: i });
    words.push(token);
  }
  finishCommand();
  // A pipe to an interpreter can turn printed generator text into a command.
  // Keep the ordinary output-filter pipeline used by release workflows.
  let upstream: ShellCommand[] = [];
  for (const command of commands) {
    if (upstream.length || piped.has(command)) isolatedCommands.add(command);
    if (upstream.length) {
      const sink = releaseHookCommand(command)?.[0];
      if (!sink || sink.unresolved || !/^(?:cat|awk|sed|grep|head|tail|cut|tr|sort|uniq|wc)$/.test(basename(sink.value))) {
        for (const source of upstream) problems.set(source[0], "Pipeline to an opaque executable");
      }
    }
    if (piped.has(command)) upstream.push(command);
    else upstream = [];
  }
  return { commands, spans };
}
