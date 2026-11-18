/**
 * Lex the release-hook language without evaluating shell. Every input character
 * belongs to a literal word, a quoted value, a separator, or an unsupported
 * construct retained on its command. Source spans always refer to the input.
 */
import type { ShellCommand, ShellToken, ShellTokenSpan } from "./shell-scan.ts";

const problems = new WeakMap<ShellToken, string>();
const indirectTargets = new WeakSet<ShellToken>();
const optionNames = new WeakMap<ShellToken, string>();

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

/** Split only on unquoted shell list operators. Never execute or recursively guess a payload. */
export function parseReleaseHook(text: string): { commands: ShellCommand[]; spans: WeakMap<ShellToken, ShellTokenSpan> } {
  const commands: ShellCommand[] = [];
  const spans = new WeakMap<ShellToken, ShellTokenSpan>();
  const bindings = new Set<string>();
  let words: ShellCommand = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/^[;&|\n]$/.test(ch)) {
      if (words.length) {
        if (ch === "&" && text[i + 1] !== "&") problems.set(words[0], "Shell background or descriptor operator &");
        commands.push(words);
      }
      words = [];
      i += text.startsWith("&&", i) || text.startsWith("||", i) ? 2 : 1;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (text.startsWith("\\\n", i)) { i += 2; continue; }
    if (ch === "#") {
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
      if (!quote && /[\s;&|]/.test(char)) break;
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
      if (!quote && /[<>]/.test(char) && !/^\d*$/.test(value) && !/^\d*[<>]/.test(value)) problem = "Attached shell redirection";
      if (!quote && /[*?]/.test(char)) { unresolved = true; splits = true; }
      if (!quote && /[()]/.test(char)) problem ??= "Shell grouping or substitution";
      value += char;
    }
    if (quote) problem = "malformed shell arguments (unterminated quote)";
    const token: ShellToken = { value, startsQuoted, quoted, unresolved };
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
  if (words.length) commands.push(words);
  return { commands, spans };
}
