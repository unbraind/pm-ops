/**
 * Tokenises shell text into the commands it would actually run.
 *
 * A guard that decides "does any publish here omit `--provenance`" is only as
 * good as its idea of what a command is. The previous scan answered that
 * question with a regular expression: it blanked every quoted span so an
 * advisory `echo "npm publish"` could not read as an invocation, then split the
 * remainder on `&&`, `||`, `;` and a space-surrounded `|`.
 *
 * Both halves of that shortcut are wrong in the same direction -- they make the
 * gate report a pass it has not earned:
 *
 * - Blanking quoted spans deletes the argument being audited. `npm publish
 *   "--provenance"` runs with an attestation but scans as one without, and the
 *   reverse case is worse: `eval "npm publish"` and `bash -c 'npm publish'` are
 *   real unattested publishes that vanish entirely, leaving a conventional
 *   attested sibling elsewhere in the file to carry the audit to green.
 * - Splitting on three operators misses a backgrounding `&`, a pipe written
 *   without surrounding spaces (`true|npm publish`), and command substitution.
 *
 * So the text is tokenised the way a shell does it -- quotes resolved rather
 * than erased, operators recognised as operators, `$(...)`, backticks, `eval`
 * and `sh -c` payloads recursed into -- and each command records whether its
 * words were quoted. Nothing downstream has to guess.
 *
 * This is deliberately not a shell. It resolves only provably literal scalar
 * and array bindings, preserves unknown expansions, and removes redirections
 * when locating command words; it does not expand globs or arithmetic. It
 * exists to enumerate candidate command invocations for auditing, where
 * missing one is a security failure and inventing one is merely noise.
 *
 * @packageDocumentation
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One word of a command, after quote resolution. */
export interface ShellToken {
  /** The word's text with its quoting removed. */
  value: string;
  /** True when any part of the word came from inside quotes. */
  quoted: boolean;
  /**
   * True when the word's FIRST character came from inside quotes.
   *
   * `quoted` alone cannot tell an assignment apart from a literal that merely
   * looks like one. `NPM_CONFIG_REGISTRY="https://example"` is a real
   * assignment whose value happens to be quoted, while `"FOO=bar"` is a single
   * quoted word that the shell does not treat as an assignment at all. Both set
   * `quoted`; only the second starts inside quotes.
   */
  startsQuoted: boolean;
}

/** One simple command: the words it would run, in order. */
export type ShellCommand = ShellToken[];

/**
 * Words that precede a command without being the command.
 *
 * `env FOO=bar npm publish` runs npm, not env, so a scan that reads the first
 * word as the command name would classify it as an `env` invocation and let the
 * publish through unaudited.
 *
 * The package runners (`npx`, `bunx`, `pnpx`) belong here for the same reason,
 * and they bring their own options: `npx --yes npm publish` runs npm behind two
 * words, not one. Option words following a prefix are therefore skipped too --
 * see `skipCommandPrefix`, which is where that rule is applied and bounded.
 *
 * Runners spelled as two words live in `TWO_WORD_PREFIXES` instead, because
 * their head word is only a wrapper in combination with the word after it.
 */
const COMMAND_PREFIXES = new Set([
  "env",
  "exec",
  "nohup",
  "command",
  "builtin",
  "sudo",
  "doas",
  "nice",
  "ionice",
  "time",
  "stdbuf",
  "timeout",
  "setsid",
  "xargs",
  "npx",
  "bunx",
  "pnpx",
  // Shell keywords introduce a command rather than being one. `if npm publish`
  // runs npm; a scan that reads `if` as the program audits nothing.
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
  "(",
]);

/**
 * Wrappers spelled as two words, mapped to the second word that completes them.
 *
 * `pnpm dlx npm publish` runs npm, but `pnpm publish` runs pnpm's own publish
 * and `pnpm install` runs no wrapper at all. Consuming the head word
 * unconditionally would therefore re-point an unrelated `pnpm` command at its
 * first argument, so the pair is only consumed when the second word matches.
 */
const TWO_WORD_PREFIXES = new Map([
  ["npm", new Set(["exec", "x"])],
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx", "exec"])],
  ["bun", new Set(["x", "run"])],
]);

/**
 * Reduce a program word to the name it runs.
 *
 * `/usr/local/bin/npm publish` runs npm, so a check against the whole word
 * would miss it. `String.prototype.split` always yields at least one element,
 * including for the empty string, so no fallback is needed or reachable here.
 *
 * @param word - The program word as written.
 * @returns The final path segment.
 */
function basename(word: string): string {
  const segments = word.split("/");
  return segments[segments.length - 1]!;
}

/** Commands whose string argument is itself shell text to be scanned. */
const SHELL_EVALUATORS = new Set(["eval", "bash", "sh", "dash", "zsh", "ksh"]);

/** True when the character ends a word outside of quotes. */
function isOperatorStart(character: string): boolean {
  return character === ";"
    || character === "&"
    || character === "|"
    || character === "\n"
    || character === "("
    || character === ")"
    || character === "{"
    || character === "}";
}

/**
 * Read a `$(...)` or backtick substitution and return its inner text.
 *
 * Nesting is counted so `$(echo $(npm publish))` yields the whole inner body
 * rather than stopping at the first `)`; a truncated body would drop the
 * invocation it contains.
 *
 * @param text - The full text being scanned.
 * @param start - Index of the character that opens the substitution.
 * @returns The inner text and the index just past the closing delimiter.
 */
function readSubstitution(text: string, start: number): { inner: string; end: number } {
  if (text[start] === "`") {
    const close = text.indexOf("`", start + 1);
    if (close === -1) return { inner: text.slice(start + 1), end: text.length };
    return { inner: text.slice(start + 1, close), end: close + 1 };
  }
  // A parenthesis inside quotes is a literal, not a delimiter. Counting it
  // closes the substitution early and truncates the body, so
  // `$(echo ")" && npm publish)` loses the publish entirely.
  let depth = 1;
  let index = start + 2;
  let single = false;
  let double = false;
  while (index < text.length && depth > 0) {
    const character = text[index]!;
    if (character === "\\") index += 2;
    else {
      // Quote state is bounded to one line. A workflow's prose carries
      // apostrophes -- "GitHub's", "workflow's" -- inside double-quoted
      // messages, and letting an unbalanced one persist across lines makes
      // every later parenthesis look quoted, so the substitution runs on and
      // swallows unrelated commands.
      if (character === "\n") { single = false; double = false; }
      else if (character === "'" && !double) single = !single;
      else if (character === '"' && !single) double = !double;
      else if (!single && !double && character === "(") depth += 1;
      else if (!single && !double && character === ")") depth -= 1;
      if (depth === 0) break;
      index += 1;
    }
  }
  return { inner: text.slice(start + 2, index), end: index + 1 };
}

/**
 * Split shell text into the simple commands it contains.
 *
 * Command substitutions are scanned as well as the command containing them,
 * because `VERSION=$(npm publish)` runs a publish however unusual that is, and a
 * gate that only looked at the outer assignment would miss it.
 *
 * `eval`, `bash -c` and their siblings receive the same treatment one level
 * deeper: their string argument is re-tokenised, so a publish smuggled through
 * an interpreter is enumerated alongside a plain one. Recursion is bounded --
 * shell text that nests evaluators more than a handful of levels deep is not
 * something this repository writes, and an unbounded walk over hostile input is
 * a denial of service rather than a stronger audit.
 *
 * @param text - Shell text, typically one file or one manifest script body.
 * @param depth - Current evaluator recursion depth; callers pass nothing.
 * @returns Every simple command found, outermost first.
 */
export function tokenizeCommands(text: string, depth = 0): ShellCommand[] {
  if (depth > 8) return [];
  const commands: ShellCommand[] = [];
  const nested: string[] = [];
  let command: ShellCommand = [];
  let value = "";
  let quoted = false;
  let startsQuoted = false;
  let started = false;

  const endWord = (): void => {
    if (!started) return;
    command.push({ value, quoted, startsQuoted });
    value = "";
    quoted = false;
    startsQuoted = false;
    started = false;
  };
  const endCommand = (): void => {
    endWord();
    if (command.length > 0) commands.push(command);
    command = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "#" && !started) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      endCommand();
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      index += 1;
      if (next === undefined) break;
      if (next === "\n") continue;
      value += next;
      if (!started) startsQuoted = false;
      started = true;
      continue;
    }
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      value += text.slice(index + 1, end);
      quoted = true;
      if (!started) startsQuoted = true;
      started = true;
      index = end;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        const inner = text[index]!;
        if (inner === "\\") {
          const next = text[index + 1];
          if (next !== undefined) {
            if (next !== "\n") value += next;
            index += 2;
            continue;
          }
          index += 1;
          continue;
        }
        if (inner === "`" || (inner === "$" && text[index + 1] === "(")) {
          const { inner: body, end } = readSubstitution(text, index);
          nested.push(body);
          index = end;
          continue;
        }
        value += inner;
        index += 1;
      }
      quoted = true;
      if (!started) startsQuoted = true;
      started = true;
      continue;
    }
    if (character === "`" || (character === "$" && text[index + 1] === "(")) {
      const { inner, end } = readSubstitution(text, index);
      nested.push(inner);
      index = end - 1;
      if (!started) startsQuoted = false;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      endWord();
      continue;
    }
    if (isOperatorStart(character)) {
      // `2>&1` is one redirection, not a command ended by a backgrounding `&`.
      // The `&` belongs to the word only while that word is still an operator
      // awaiting its target.
      if (character === "&" && /^[0-9]*[<>]>?$/.test(value)) {
        value += character;
        started = true;
        continue;
      }
      endCommand();
      continue;
    }
    value += character;
    if (!started) startsQuoted = false;
    started = true;
  }
  endCommand();

  for (const body of nested) commands.push(...tokenizeCommands(body, depth + 1));
  for (const found of [...commands]) {
    // A YAML key's value is shell text, and it may arrive as ONE quoted word:
    // `run: "npm publish"` leaves a single token holding the whole command, so
    // the value has to be re-scanned rather than read as a program name.
    // A leading `- ` list marker may sit before the key.
    const keyAt = found[0]?.value === "-" ? 1 : 0;
    const key = found[keyAt];
    const bodyToken = found[keyAt + 1];
    const quotedBody = bodyToken?.quoted === true && /[\s;&|]/.test(bodyToken.value);
    if (key !== undefined && !key.startsQuoted && quotedBody && /^[A-Za-z_][A-Za-z0-9_-]*:$/.test(key.value)) {
      const body = found.slice(keyAt + 1).map((token) => token.value).join(" ");
      if (body.length > 0) commands.push(...tokenizeCommands(body, depth + 1));
    }
    // Every reading, not just the first: `sudo -u root bash -c '…'` resolves to
    // `root` on the primary reading, so recursing only there never reaches the
    // evaluator at all.
    for (const candidate of commandCandidates(found)) {
      const name = commandName(candidate);
      if (name === undefined || !SHELL_EVALUATORS.has(name)) continue;
      const words = candidate.slice(1).map((argument) => argument.value);
      // The shell joins an evaluator's words with a space and evaluates the
      // result, so `eval "npm pub" "lish"` runs a publish that scanning each
      // argument alone never sees. The join keeps the OPTION words too: drop
      // them and `eval "npm" "publish" "--provenance"` reconstructs as an
      // unattested publish and fails a workflow that is in fact attested.
      const bodies = new Set([...words.filter((word) => !word.startsWith("-")), words.join(" ")]);
      for (const body of bodies) commands.push(...tokenizeCommands(body, depth + 1));
    }
  }
  return commands;
}

/**
 * True when an unquoted word is a redirection operator rather than a command word.
 *
 * A redirection and its target are not part of the command the shell runs, so
 * `> /dev/null npm publish` runs npm. A scan that reads words in order sees `>`
 * as the program and audits nothing. The forms accepted here are the ones a
 * workflow actually writes: the plain operators, a file-descriptor prefix
 * (`2>`, `2>>`), the duplicating forms (`>&`, `2>&1`, `&>`), and the read-write
 * form `<>`. `<>` has to be named explicitly: it is not `<` followed by `>`, so
 * without it the operator was read as a joined redirection that consumes no
 * target, its target `/dev/null` became the command word, and the real
 * `npm publish` after it was never audited.
 *
 * @param token - One command word.
 * @returns True when the word is a redirection operator.
 */
function isRedirection(token: ShellToken): boolean {
  if (token.startsQuoted) return false;
  return /^(?:[0-9]*(?:>>?|<>|<<?<?)&?[0-9-]*|&>>?)$/.test(token.value);
}

/**
 * Drop a command's redirections, so only the words it runs remain.
 *
 * An operator written apart from its target (`> file`) consumes the word after
 * it; one written joined to it (`>file`, `2>&1`) consumes nothing further.
 *
 * @param command - One simple command's tokens.
 * @returns The command without its redirections.
 */
function withoutRedirections(command: ShellCommand): ShellCommand {
  const kept: ShellCommand = [];
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (!isRedirection(token)) {
      // A joined form such as `>file` or `2>&1` is one word and takes no target.
      if (!token.startsQuoted && /^(?:[0-9]*>>?|[0-9]*<<?<?|&>>?)[^\s]/.test(token.value)) continue;
      kept.push(token);
      continue;
    }
    // A bare operator takes the next word as its target.
    if (!/&[0-9-]$/.test(token.value)) index += 1;
  }
  return kept;
}

/**
 * Walk past the words that precede the program a command runs.
 *
 * Three kinds of word are not the program: a leading `NAME=value` assignment, a
 * wrapper listed in `COMMAND_PREFIXES`, and -- only once a wrapper has been
 * seen -- that wrapper's own options. The last rule is what reaches the publish
 * in `npx --yes npm publish`; it stays behind the wrapper condition so that a
 * command whose own first word is an option is still reported as written rather
 * than silently re-pointed at one of its arguments.
 *
 * An option's separate value (`sudo -u root npm publish`) is not skipped,
 * because which options take a value differs per wrapper, and guessing wrong
 * would move the reported program rather than merely widen the search.
 *
 * @param command - One simple command's tokens.
 * @returns The index of the program word, or the command's length when there is none.
 */
function skipCommandPrefix(command: ShellCommand): number {
  let index = 0;
  let sawPrefix = false;
  while (index < command.length) {
    const token = command[index]!;
    if (!token.startsQuoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      index += 1;
      continue;
    }
    const base = basename(token.value);
    if (COMMAND_PREFIXES.has(base)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    const second = command[index + 1];
    if (second !== undefined && TWO_WORD_PREFIXES.get(base)?.has(second.value) === true) {
      sawPrefix = true;
      index += 2;
      continue;
    }
    if (sawPrefix && !token.startsQuoted && token.value.startsWith("-")) {
      index += 1;
      continue;
    }
    // A YAML key carries the command as its value: `run: npm publish` runs npm,
    // and reading `run:` as the program audits nothing. Workflow files are
    // scanned as raw text, so the key is a word like any other. Only a leading
    // key is consumed, and only one, so an argument that merely ends in a colon
    // is untouched.
    // A YAML list marker precedes the key on the same line: `- run: npm publish`.
    if (index === 0 && !token.startsQuoted && token.value === "-") {
      sawPrefix = true;
      index += 1;
      continue;
    }
    if (index <= 1 && !token.startsQuoted && /^[A-Za-z_][A-Za-z0-9_-]*:$/.test(token.value)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/**
 * Name the program a command runs, or nothing when it runs none.
 *
 * Leading `NAME=value` assignments and wrapper words are skipped, and a path is
 * reduced to its basename so `/usr/local/bin/npm publish` is recognised. The
 * distinction this exists to draw is command *position*: `echo npm publish`
 * prints three words and publishes nothing, while the previous scan searched
 * the whole line for the word `npm` and counted it as an invocation.
 *
 * @param command - One simple command's tokens.
 * @returns The program's basename, or undefined for an empty or assignment-only command.
 */
export function commandName(input: ShellCommand): string | undefined {
  const command = withoutRedirections(input);
  const token = command[skipCommandPrefix(command)];
  return token === undefined ? undefined : basename(token.value);
}

/**
 * Enumerate every reading of a command that could name a program.
 *
 * `commandName` answers "what does this command run" and answers it once. That
 * is right for reporting and wrong for auditing, because a wrapper's options
 * are not all known: `sudo -u root npm publish` stops at `root`, since `-u`
 * takes a value and nothing here knows that. Enumerating the value-taking
 * options of every wrapper would be a list that silently goes stale, and each
 * omission is a publish that disappears from the audit.
 *
 * So once a wrapper has been consumed, every later word is also offered as a
 * possible program, with the words after it as its arguments. An auditor asking
 * "does any publish here lack an attestation" then cannot miss one behind a
 * wrapper option it has never heard of.
 *
 * The cost is noise, never a miss: `sudo -u npm publish` -- a user actually
 * named `npm` -- is offered as a publish that no shell would run. For a gate
 * whose failure mode is an unattested release, a spurious finding an operator
 * dismisses is the cheaper error.
 *
 * A command with no wrapper yields exactly one reading, so ordinary commands
 * are unaffected.
 *
 * @param command - One simple command's tokens.
 * @returns Each candidate reading, the command's own first.
 */
export function commandCandidates(input: ShellCommand): ShellCommand[] {
  const command = withoutRedirections(input);
  const start = skipCommandPrefix(command);
  const candidates: ShellCommand[] = [];
  if (start < command.length) candidates.push(command.slice(start));
  if (start === 0) return candidates;
  for (let index = start + 1; index < command.length; index += 1) {
    const token = command[index]!;
    if (token.value.startsWith("-")) continue;
    candidates.push(command.slice(index));
  }
  return candidates;
}

/**
 * List a command's arguments -- everything after its program name.
 *
 * @param command - One simple command's tokens.
 * @returns The argument tokens, in order.
 */
export function commandArguments(input: ShellCommand): ShellToken[] {
  const command = withoutRedirections(input);
  return command.slice(skipCommandPrefix(command) + 1);
}

/** A tracked file's path and contents. */
export interface SourceFile {
  /** Repository-relative path. */
  file: string;
  /** File contents. */
  text: string;
}

/**
 * Collapse shell and YAML line continuations so one logical command is one string.
 *
 * A backslash at end of line joins the next line; without this every multi-line
 * invocation looks like a set of fragments, none of which carries both the
 * version input and the date flag.
 *
 * @param text - Raw file contents.
 * @returns The same text with continuations joined.
 */
export function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

/**
 * A `run:` block-scalar header: the key, an indicator, and nothing else.
 *
 * YAML allows a block scalar to carry an explicit indentation indicator (a
 * digit `1`–`9`) alongside the chomping indicator (`+` or `-`), in either
 * order — `|2`, `|-2`, `|2-` are all valid. When present, the digit tells the
 * parser exactly how many spaces of indentation the content carries relative
 * to the parent key, so the scanner can strip that exact width instead of
 * inferring it from the first non-blank line. The capture group for the digit
 * is used by {@link dedentRunBlocks} to dedent precisely; without it the
 * content's YAML indentation would remain and a heredoc terminator would never
 * match at line start.
 */
const BLOCK_SCALAR_HEADER =
  /^([ \t]*)((?:-[ \t]+)*)("[^"]*"|'[^']*'|[A-Za-z_][\w.-]*):[ \t]*([|>])(?:[+-]?([1-9])?[+-]?)?(?:[ \t]+#.*)?\r?$/;

/**
 * Strip the quotes YAML allows around a mapping key.
 *
 * Executability is decided by comparing this to `run`, rather than by a second
 * matcher that only recognises the unquoted spelling. Two matchers that must
 * agree is exactly how `"run": |` came to be read as data by one and as a block
 * by the other - which hides a real publish in one direction and admits a
 * phantom one in the other.
 *
 * @param key - The key exactly as written, possibly quoted.
 * @returns The key without surrounding quotes.
 */
function unquoteKey(key: string): string {
  const quoted = /^(["'])(.*)\1$/u.exec(key);
  if (quoted === null) return key;
  const [, quote, body] = quoted as unknown as [string, string, string];
  // A single-quoted YAML scalar has exactly one escape: a doubled quote.
  if (quote === "'") return body.replaceAll("''", "'");
  // A double-quoted scalar supports the full escape set, so comparing the raw
  // text to `run` reads `"r\u0075n"` as data - and its body then never reaches
  // the shell scan, hiding a publish that GitHub Actions really does execute.
  return body.replace(
    /\\(?:u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|(.))/gu,
    (_match, unicode?: string, hex?: string, single?: string) => {
      if (unicode !== undefined) return String.fromCodePoint(Number.parseInt(unicode, 16));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "/": "/" };
      return simple[single!] ?? single!;
    },
  );
}

/** Leading whitespace, which YAML never mixes between a block and its parent. */
const LEADING_WHITESPACE = /^[ \t]*/;

/** A line that is blank, including the carriage return a CRLF file leaves. */
const BLANK_LINE = /^[ \t\r]*$/;

/**
 * Apply YAML folding to the already-dedented body of a `>` block scalar.
 *
 * A folded block joins consecutive lines with a single space before the value
 * ever reaches the shell, so a publish whose `--provenance` sits on the next
 * line is one command by the time bash sees it. Scanning the lines separately
 * reads that flag as absent and refuses a release that is in fact attested.
 *
 * Folding stops at the two boundaries YAML honours: a blank line, which
 * becomes a line break, and a more-indented line, which is kept literally.
 *
 * @param lines - The block's body, already stripped of its block indentation.
 * @returns The body with foldable runs joined by single spaces.
 */
function foldScalarLines(lines: readonly string[]): string[] {
  const folded: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) folded.push(run.join(" "));
    run = [];
  };
  for (const line of lines) {
    const literal = BLANK_LINE.test(line) || LEADING_WHITESPACE.exec(line)![0].length > 0;
    if (literal) {
      flush();
      folded.push(line);
      continue;
    }
    run.push(line.replace(/\r$/u, ""));
  }
  flush();
  return folded;
}

/**
 * Strip the YAML block indentation from `run:` block scalars.
 *
 * GitHub Actions takes a `run:` block's text, removes the indentation YAML
 * gave it, and hands the result to bash — so the shell never sees the leading
 * whitespace the raw workflow file carries. The scanner reads the raw file,
 * and exactly one of its rules is whitespace-sensitive: a heredoc terminator
 * is recognised only at the start of the line the shell sees. A terminator
 * compared against a YAML-indented line therefore never matches, the heredoc
 * swallows the rest of the file, every later assignment is payload, and a
 * `$NPM publish` after the heredoc is omitted from the audit while an
 * attested sibling elsewhere satisfies the non-vacuity guard — the scan
 * reports clean over an unattested publish.
 *
 * Dedenting the block content restores the text bash actually receives. Every
 * other rule in the scanner already tolerates leading whitespace
 * (`STANDALONE_ASSIGNMENT` opens with `^[ \t]*`, control closers and function
 * openers are matched against trimmed syntax, a comment starts after any
 * separator or whitespace, and `bashArrays` anchors on a word boundary), so
 * this function changes nothing else about what the scanner sees.
 *
 * Only `run:` blocks are dedented, because `run` is the key GitHub Actions
 * executes; a block scalar under any other key is data no shell runs, and
 * stripping its indentation would be rewriting prose. The block's indentation
 * is learned from its first non-blank line, as YAML itself learns it, a line
 * keeps any indentation beyond the block's own, and the block ends at the
 * first non-blank line indented less — which is where YAML ends it too. A
 * `run:`-shaped line inside another block's content is content, not a header,
 * because the scanner walks the file once, forward, consuming each block
 * before looking for the next.
 *
 * @param text - A workflow file's raw contents.
 * @returns The same text with each `run:` block's content dedented.
 */
export function dedentRunBlocks(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = BLOCK_SCALAR_HEADER.exec(lines[index]!);
    if (header === null) {
      output.push(lines[index]!);
      index += 1;
      continue;
    }
    // The sequence-item marker is part of the parent node's indentation: in
    // `      - run: |4` the key sits at column 8, not 6, so the content the
    // indicator counts from starts at 12. Omitting the marker's width strips
    // two columns too few and leaves residual indentation, which is enough to
    // stop a heredoc terminator matching at the shell line start.
    const parentIndent = header[1]!.length + header[2]!.length;
    const executable = unquoteKey(header[3]!) === "run";
    const folded = header[4] === ">";
    // The block's indentation comes from its first non-blank line, so blank
    // lines between the header and the content decide nothing here.
    let content = index + 1;
    while (content < lines.length && BLANK_LINE.test(lines[content]!)) content += 1;
    // An explicit indentation indicator (e.g. `|2`) tells the YAML parser the
    // content is indented exactly that many spaces beyond the parent key, so
    // the scanner strips that exact width rather than guessing from the first
    // non-blank line — which matters when the content itself starts with extra
    // leading spaces that are data, not structural indentation.
    const explicitIndent = header[5] !== undefined ? parentIndent + Number(header[5]) : undefined;
    // Without an explicit indicator the block's indentation is learned from
    // its first non-blank line, as YAML itself learns it.
    const detected = content < lines.length ? LEADING_WHITESPACE.exec(lines[content]!)![0] : "";
    const indent = explicitIndent !== undefined ? " ".repeat(explicitIndent) : detected;
    // A header with no more-indented line after it holds an empty block: YAML
    // ends it immediately, and so does this scan.
    if (explicitIndent === undefined && indent.length <= parentIndent) {
      output.push(lines[index]!);
      index += 1;
      continue;
    }
    output.push(lines[index]!);
    index += 1;
    // Collect the body first. A non-executable block is emitted exactly as
    // written — it is data, and dedenting it would only make its contents
    // easier to mistake for shell — but it is still CONSUMED here so nothing
    // inside it is scanned as a header on the next pass.
    const body: string[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      // A blank line is block content YAML keeps as an empty line; anything
      // else must carry the block's own indentation to belong to it.
      if (!BLANK_LINE.test(line) && !line.startsWith(indent)) break;
      body.push(line);
      index += 1;
    }
    if (!executable) {
      // Replaced by blank lines rather than kept: the body of a non-`run`
      // block scalar is data GitHub Actions never executes, so a publish
      // written inside one is a phantom. Left in the text it is discovered as
      // a real invocation, and an attested phantom is enough to satisfy the
      // audit's non-vacuity guard — the exact shape that makes this gate read
      // as covered while something else publishes unattested. Blank lines keep
      // the line count, and with it every line-indexed scan downstream.
      output.push(...body.map(() => ""));
      continue;
    }
    const dedented = body.map((line) => (BLANK_LINE.test(line) ? line : line.slice(indent.length)));
    output.push(...(folded ? foldScalarLines(dedented) : dedented));
  }
  return output.join("\n");
}

/**
 * A supported Bash array declaration, with quoted and escaped parentheses kept
 * inside the declaration rather than mistaken for its closing delimiter.
 *
 * Unsupported constructs such as command substitutions are deliberately left
 * unmatched. Their references then remain unresolved and the attestation audit
 * fails closed instead of guessing at an array's contents.
 */
const BASH_ARRAY_DECLARATION = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(((?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\\'"()])*)\)/g;

/**
 * Index bash array assignments so a shared options array can be expanded.
 *
 * The release workflows declare `common=( ... )` once and pass `"${common[@]}"`
 * to each invocation, precisely so the invocations cannot drift. A scan that
 * reads only the invocation line therefore sees none of the shared flags.
 * Quoted or escaped closing parentheses are members, not array boundaries; an
 * unsupported array shape is left unknown so verification fails closed.
 *
 * @param text - File contents with continuations already joined.
 * @returns Array name mapped to the flag text it holds.
 */
export function bashArrays(text: string): Map<string, string> {
  const arrays = new Map<string, string>();
  for (const match of text.matchAll(BASH_ARRAY_DECLARATION)) {
    arrays.set(match[1]!, match[2]!.replace(/\s+/g, " ").trim());
  }
  return arrays;
}

/** Parse text opening with one assignment of a fully literal shell word. */
function literalAssignment(line: string): [string, string] | undefined {
  const head = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
  if (head === null) return undefined;
  let index = head[0].length;
  const start = index;
  let single = false;
  let double = false;
  for (; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\" && !single) {
      index += 1;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
      continue;
    }
    if (!single && !double && (/\s/.test(char) || char === ";")) break;
    if (!single && /[$`()]/.test(char)) return undefined;
  }
  if (single || double) return undefined;
  const raw = line.slice(start, index);
  const rest = line.slice(index).replace(/^[ \t]*/, "");
  if (!/^(?:[;#]|\r?$)/.test(rest)) return undefined;
  return [head[1]!, literalShellWord(raw)];
}

/**
 * Read persistent literal assignments from one control-operator-delimited segment.
 *
 * The line segmenter has already separated `;`, `&&`, and `||`. Shell keywords
 * and grouping operators can still precede an assignment in the remaining text:
 * `then NPM=npm`, `do FLAG=--provenance`, and `( NPM=npm` are all assignment-only
 * commands. Tokenising finds command position without an anchored text pattern.
 *
 * The ordinary line-opening parser remains the more permissive path for quoted
 * and escaped literal values. A compound-position assignment is accepted only
 * when its token was wholly unquoted and substitution-free; uncertainty is left
 * unresolved so the auditor can refuse rather than invent a binding.
 *
 * @param segment - One segment returned by {@link segmentShellLine}.
 * @returns Literal scalar bindings made by assignment-only commands.
 */
export function literalScalarAssignments(segment: string): Map<string, string> {
  const assignments = new Map<string, string>();
  const opening = literalAssignment(segment);
  if (opening !== undefined) assignments.set(opening[0], opening[1]);
  if (segment.includes("$(") || segment.includes("`")) return assignments;
  const commands = tokenizeCommands(segment);
  for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
    const command = commands[commandIndex]!;
    let index = 0;
    const leadingControl = ["then", "do", "else"].includes(command[0]!.value);
    while (["then", "do", "else"].includes(command[index]?.value ?? "")) index += 1;
    if (command[index]?.value === "export") index += 1;
    const grouped = segment.trimStart().startsWith("(") || segment.trimStart().startsWith("{");
    if (!leadingControl && !grouped && commandIndex === 0) continue;
    const token = command[index];
    if (token === undefined || token.quoted || index !== command.length - 1) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(token.value);
    if (match === null || /[$`"'(){};&|<>#]/u.test(match[2]!)) continue;
    assignments.set(match[1]!, match[2]!);
  }
  return assignments;
}

/** Resolve the quote and escape rules of one substitution-free shell word. */
function literalShellWord(raw: string): string {
  let value = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "'") {
      const close = raw.indexOf("'", index + 1);
      value += raw.slice(index + 1, close);
      index = close;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < raw.length && raw[index] !== '"') {
        if (raw[index] === "\\" && /[$`"\\]/.test(raw[index + 1]!)) index += 1;
        value += raw[index]!;
        index += 1;
      }
      continue;
    }
    if (char === "\\") {
      value += raw[index + 1]!;
      index += 1;
      continue;
    }
    value += char;
  }
  return value;
}

/**
 * Find the heredocs one line opens, reading only positions the shell would
 * treat as source.
 *
 * A `<<EOF` written inside a comment or a quoted argument opens nothing. Matching
 * it anyway marked the following lines as heredoc body, and because a body is
 * skipped for binding, a real `unset` inside that phantom body was skipped too.
 * The discarded binding then survived and attested a publish the shell runs
 * unattested -- a bypass, reachable from nothing more than a comment mentioning
 * a heredoc. Quote state and the start of a comment are therefore tracked
 * before the operator is looked for.
 *
 * The delimiter itself may be any shell word, including numeric, punctuation,
 * concatenated quoted fragments, or backslash quoting. It is parsed through the
 * end of that word and quote removal produces the terminator Bash compares.
 *
 * `<<<` is a herestring and opens no body. It is rejected by refusing a match
 * whose operator is followed by a third `<`; the scan then steps past all three,
 * so the second and third cannot be read as an operator of their own.
 *
 * @param line - One source line, with continuations already joined.
 * @returns The heredocs opened, in the order bash will read their bodies.
 */
function heredocOpenersIn(line: string): Array<{ delimiter: string; stripTabs: boolean; expand: boolean }> {
  const openers: Array<{ delimiter: string; stripTabs: boolean; expand: boolean }> = [];
  let single = false;
  let double = false;
  let arithmeticDepth = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (arithmeticDepth > 0) {
      if (character === "(") arithmeticDepth += 1;
      if (character === ")") arithmeticDepth -= 1;
      continue;
    }
    if (character === "\\" && !single) {
      index += 1;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      continue;
    }
    if (!single && character === "$" && line[index + 1] === "(" && line[index + 2] === "(") {
      arithmeticDepth = 2;
      index += 2;
      continue;
    }
    if (!single && !double && character === "(" && line[index + 1] === "(") {
      arithmeticDepth = 2;
      index += 1;
      continue;
    }
    if (single || double) continue;
    // A `#` opens a comment only at the start of a word, which is how bash
    // reads it: `foo#bar` is one word, not a command and a comment.
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) break;
    if (character !== "<" || line[index + 1] !== "<") continue;
    if (line[index + 2] === "<") {
      // A herestring. Step past all three so the pair inside it is not read as
      // an operator on the next iteration.
      index += 2;
      continue;
    }
    let cursor = index + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    let delimiter = "";
    let delimiterQuote: "'" | '"' | undefined;
    let consumed = false;
    let quoted = false;
    for (; cursor < line.length; cursor += 1) {
      const part = line[cursor]!;
      if (part === "\\" && delimiterQuote !== "'") {
        const escaped = line[cursor + 1];
        if (escaped === undefined) break;
        delimiter += escaped;
        consumed = true;
        quoted = true;
        cursor += 1;
        continue;
      }
      if (part === "'" || part === '"') {
        delimiterQuote = delimiterQuote === undefined ? part : delimiterQuote === part ? undefined : delimiterQuote;
        consumed = true;
        quoted = true;
        continue;
      }
      if (delimiterQuote === undefined && (/\s/.test(part) || /[;&|<>]/.test(part))) break;
      delimiter += part;
      consumed = true;
    }
    if (!consumed || delimiterQuote !== undefined) continue;
    openers.push({ delimiter, stripTabs, expand: !quoted });
    index = cursor - 1;
  }
  return openers;
}

/** Per-line heredoc body classification state. */
interface HeredocLineState {
  /** The line is body data or a terminator, not parent-shell source. */
  body: boolean;
  /** The shell expands substitutions on this body-data line. */
  expand: boolean;
}

/** Classify heredoc body lines while retaining delimiter quote behavior. */
function heredocLineStates(lines: string[]): HeredocLineState[] {
  const states = lines.map(() => ({ body: false, expand: false }));
  /** Delimiters still awaiting their terminator, in the order bash closes them. */
  let pending: Array<{ delimiter: string; stripTabs: boolean; expand: boolean }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (pending.length > 0) {
      const candidate = (pending[0]!.stripTabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "");
      const terminator = candidate === pending[0]!.delimiter;
      states[index] = { body: true, expand: pending[0]!.expand && !terminator };
      if (terminator) pending = pending.slice(1);
      continue;
    }
    pending.push(...heredocOpenersIn(line));
  }
  return states;
}

/**
 * Report which lines of a file are heredoc *body* rather than shell source.
 *
 * A heredoc body is data on a command's stdin. It cannot bind a variable in the
 * shell that reads it, so indexing `FLAG=--provenance` out of one invents a
 * binding the shell never makes, and an unattested `npm publish $FLAG` then
 * borrowed that flag and passed the attestation gate. Every heredoc spelling
 * hid a binding the same way: the plain `<<EOF`, the space- and tab-separated
 * `<<  EOF`, the quoted `<<'EOF'` and `<<"EOF"`, the tab-stripping `<<-EOF`,
 * and one written after another redirection (`cat > f <<EOF`).
 *
 * Only *binding* is suppressed here, never publish detection. A heredoc can
 * carry a script that is written to a file and executed later, so an
 * `npm publish` inside one remains a publish path this scan must report. Both
 * halves of that split fail closed: an unindexed name leaves `$FLAG`
 * unresolved, so the publish reads as unattested and the gate fails, and a
 * publish written into a heredoc still has to carry the flag itself.
 *
 * Several heredocs may open on one line (`cat <<A <<B`); bash reads their
 * bodies in the order the redirections appear, which is the order kept here. A
 * body whose delimiter never arrives runs to the end of the file, exactly as
 * the shell would read it.
 *
 * @param lines - The file's lines, with continuations already joined.
 * @returns One flag per line, true where that line is heredoc body.
 */
export function heredocBodyLines(lines: string[]): boolean[] {
  return heredocLineStates(lines).map((state) => state.body);
}

/**
 * Report body-data lines on which Bash performs parameter expansion.
 *
 * Quote removal still applies to every delimiter, but quoting any part of that
 * delimiter suppresses expansion in its body. Terminator lines never expand.
 *
 * @param lines - The file's lines, with continuations already joined.
 * @returns One flag per line, true only for expandable heredoc body data.
 */
export function heredocExpansionLines(lines: string[]): boolean[] {
  return heredocLineStates(lines).map((state) => state.expand);
}

/**
 * Parse the scalar names one command unsets, or nothing.
 *
 * `unset FLAG` after `FLAG=--provenance` leaves the shell passing no flag at
 * all, so retaining the binding let an unattested publish borrow `--provenance`
 * and pass the gate. Commands are read through the tokeniser rather than an
 * anchored whole-line pattern, because `echo ready; unset FLAG` unsets exactly
 * as effectively as a line holding nothing else.
 *
 * An unset the parent shell would not actually perform -- inside `$(...)`, or
 * one the tokeniser surfaces from a nested body -- is honoured too, because the
 * two directions of error are not symmetric. Dropping a binding can only make a
 * later `$FLAG` unresolve, which reads as an unattested publish and *fails* the
 * gate; keeping one the shell discarded is what lets an unattested publish
 * pass. Erring toward the false alarm is the only direction that cannot ship an
 * unattested artifact.
 *
 * Leading environment assignments and the `command unset` / `builtin unset`
 * wrapper forms all reach the same builtin and therefore remove the same
 * bindings.
 *
 * `-v` selects the variable namespace, which is what this map models. `-f`
 * unsets a shell function and touches no variable, so such a command is left to
 * bind nothing.
 *
 * @param command - One tokenised command.
 * @returns The scalar names unset, empty when the command unsets none.
 */
export function unsetNames(command: ShellCommand): string[] {
  const words = withoutRedirections(command);
  let commandIndex = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[commandIndex]?.value ?? "")) commandIndex += 1;
  if (words[commandIndex]?.value === "command") {
    commandIndex += 1;
    while (words[commandIndex]?.value.startsWith("-")) commandIndex += 1;
  } else if (words[commandIndex]?.value === "builtin") {
    commandIndex += 1;
  }
  if (words[commandIndex]?.value !== "unset") return [];
  const names: string[] = [];
  for (const token of words.slice(commandIndex + 1)) {
    if (token.value === "-f") return [];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value)) continue;
    names.push(token.value);
  }
  return names;
}

/**
 * Split one shell line into segments separated by control operators.
 *
 * Quoting and backslash escaping are respected so that operators inside quotes
 * or after a backslash do not split. Comments (`#` at a word boundary) absorb
 * the rest of the line into the preceding segment. The returned array
 * interleaves text segments with operator segments (`;`, `&`, `&&`, `|`, `||`).
 *
 * @param line - One line of shell source (continuations already joined).
 * @returns Segments where control operators are separate entries.
 */
export function segmentShellLine(line: string): string[] {
  const segments: string[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\" && quote !== "'") {
      value += character + (line[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === undefined ? character : quote === character ? undefined : quote;
      value += character;
      continue;
    }
    if (quote === undefined && character === "#"
      && (index === 0 || /[\s;&|()]/.test(line[index - 1]!))) {
      value += line.slice(index);
      break;
    }
    if (quote === undefined && (character === ";" || character === "&" || character === "|")) {
      if (value !== "") segments.push(value);
      const doubled = line[index + 1] === character && character !== ";";
      segments.push(doubled ? character + character : character);
      if (doubled) index += 1;
      value = "";
      continue;
    }
    value += character;
  }
  if (value !== "") segments.push(value);
  return segments;
}

/**
 * Strip quoted spans and a trailing comment, leaving the line's shell syntax.
 *
 * @param line - One already-continuation-joined source line.
 * @returns The line's unquoted characters, comment removed.
 */
function unquotedText(line: string): string {
  let bare = "";
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\" && !single) { index += 1; continue; }
    if (char === "'" && !double) { single = !single; continue; }
    if (char === '"' && !single) { double = !double; continue; }
    if (single || double) continue;
    if (char === "#" && (index === 0 || /\s/u.test(line[index - 1]!))) break;
    bare += char;
  }
  return bare;
}

/** Block openers and closers, matched as words outside quotes. */
const BLOCK_OPENERS = /(?:^|[\s;&|(])(?:if|for|while|until|case|select)(?=[\s;&|]|$)/gu;
const BLOCK_CLOSERS = /(?:^|[\s;&|])(?:fi|done|esac)(?=[\s;&|)]|$)/gu;

/**
 * Net change in `case` nesting contributed by one line.
 *
 * Tracked separately from block depth because a `case` arm label ends in a bare
 * `)` that is not a parenthesis close. Without knowing a `case` is open, that
 * `)` decrements the depth counter and tags an assignment inside an untaken arm
 * as file-scoped, which then attests a publish after `esac`.
 *
 * @param line - One already-continuation-joined source line.
 * @returns +1 for each `case` opened, -1 for each `esac` closed.
 */
export function caseDepthChange(line: string): number {
  const bare = unquotedText(line);
  return (bare.match(/(?:^|[\s;&|(])case(?=[\s;&|]|$)/gu) ?? []).length
    - (bare.match(/(?:^|[\s;&|])esac(?=[\s;&|)]|$)/gu) ?? []).length;
}

/**
 * Report whether a segment's `case` arm label belongs to an ENCLOSING `case`.
 *
 * A segment can both close one arm and open a nested block, and the two cases
 * need opposite treatment. In `b) case "$Y" in` the label precedes the opener,
 * so it starts a sibling of the previous arm and that arm's bindings must be
 * cleared. In `case "$Y" in c) npm publish` the opener precedes the label, so
 * the label is the FIRST arm of the block this very segment opens - it has no
 * earlier sibling, and clearing there would discard a binding the enclosing arm
 * legitimately made, refusing a publish the shell does attest.
 *
 * Position is what separates them, which is why this compares indices rather
 * than asking the two questions independently.
 *
 * @param line - One shell segment.
 * @returns True when the segment opens an arm of a `case` it did not itself open.
 */
export function startsEnclosingCaseArm(line: string): boolean {
  const bare = unquotedText(line);
  // A `case` arm pattern may be written with an optional leading `(`, so in a
  // case context `(case)` is the pattern `case` and its `)` is the arm label,
  // NOT a group close. Consuming it as a group finds the wrong `)` and reads a
  // sibling arm as a nested one. This function is only consulted while a `case`
  // is already open, which is what makes that reading the correct one here.
  const armText = /^[ \t]*\(/u.test(bare) ? bare.replace(/^([ \t]*)\(/u, "$1 ") : bare;
  let groups = 0;
  let label = -1;
  for (let index = 0; index < armText.length; index += 1) {
    const character = armText[index]!;
    if (character === "(") groups += 1;
    else if (character === ")" && groups === 0) { label = index; break; }
    else if (character === ")") groups -= 1;
  }
  if (label < 0) return false;
  // Matched as the bare `case` token, deliberately. Requiring the full
  // `case <word> in` shape reads better and was suggested by two reviewers, but
  // no construction was ever found where it changes the audit's verdict - and
  // the three adjacent quantifiers it needs (`[ \t]+`, a lazy body, `[ \t]+`)
  // can all match a tab, which is a polynomial-ReDoS overlap. CodeQL flagged it
  // as high severity in exactly this file. A refinement with no demonstrated
  // effect is not worth a real defect in the gate it is refining.
  const opener = /(?:^|[\s;&|(])case(?=[\s;&|]|$)/u.exec(armText);
  return opener === null || label < opener.index;
}

/**
 * Decide whether text starts a new `case` arm.
 *
 * An arm label ends at an unquoted `)` that does not close a parenthesis group.
 * Treating an uncertain bare close as an arm boundary is deliberately
 * conservative: it discards bindings from the preceding arm, which can only
 * make later attestation fail closed.
 *
 * @param line - One already-continuation-joined source segment inside a case.
 * @returns True when the segment contains a case-arm label terminator.
 */
export function startsCaseArm(line: string): boolean {
  const bare = unquotedText(line);
  let groups = 0;
  for (const character of bare) {
    if (character === "(") groups += 1;
    else if (character === ")" && groups === 0) return true;
    else if (character === ")") groups -= 1;
  }
  return false;
}

/**
 * Net change in block nesting contributed by one line.
 *
 * Counts shell keywords and brace/parenthesis groups outside quotes. This is a
 * nesting count, not a parse: it exists to tell "this assignment is inside
 * something conditional" from "this assignment is the file's own scope", which
 * is the distinction attestation depends on.
 *
 * @param line - One already-continuation-joined source line.
 * @param insideCase - Whether a `case` is open, so a bare `)` is an arm label
 *   rather than a group close.
 * @returns Positive when the line opens more blocks than it closes.
 */
export function blockDepthChange(line: string, insideCase = false): number {
  const bare = unquotedText(line);
  let depth = 0;
  let open = 0;
  for (const char of bare) {
    if (char === "{" || char === "(") { depth += 1; open += 1; continue; }
    if (char !== "}" && char !== ")") continue;
    // Inside a `case`, a `)` with nothing open on this line is an arm label, not
    // a group close. Counting it would tag an assignment in an untaken arm as
    // file-scoped and let it attest a publish after `esac`.
    if (insideCase && open === 0) continue;
    depth -= 1;
    open -= 1;
  }
  depth += (bare.match(BLOCK_OPENERS) ?? []).length;
  depth -= (bare.match(BLOCK_CLOSERS) ?? []).length;
  return depth;
}


/**
 * Index scalar assignments per line, so a command held in a variable can be
 * audited against the bindings that stand where it actually runs.
 *
 * `CMD="npm publish"` followed by `$CMD` runs a publish that no scan of the
 * invocation line can see, because the invocation line contains no publish. The
 * assignment is where the command actually is. `NPM=npm` followed by
 * `$NPM publish` hides one the same way, so unquoted values are indexed too.
 *
 * A name is taken only where a line OPENS with one assignment carrying a fully
 * literal value and holds nothing else before its end or a `;`. `NPM=npm; cmd`
 * therefore binds, because the semicolon ends the assignment and the shell keeps
 * it afterwards, while `NPM=npm cmd` does not, because that binding lasts only
 * for the command it precedes. Requiring the line to OPEN with the assignment is
 * what keeps a `;` inside a comment from exposing one. That single rule keeps
 * the scan from inventing
 * bindings the shell never makes, each of which let an unattested publish
 * borrow a flag and pass the gate:
 *
 * - `# FLAG=--provenance` is a comment, and a comment is not a line that is
 *   only an assignment.
 * - `echo "config NPM=npm"` is a command with an argument, not an assignment.
 * - `FLAG=--provenance some-command` binds only for that one command; the shell
 *   does not keep it afterwards, so neither does this map.
 * - `$(FLAG=--provenance)` binds inside a subshell that the outer shell never
 *   sees.
 * - `NPM=npm$SUFFIX` and `NPM=npm$(printf foo)` are not literal. The value must
 *   match to the end of the line, so a prefix is never mistaken for the whole
 *   value -- the mistake that let a scan analyse a different command from the
 *   one the shell runs.
 *
 * `export NPM=npm`, a trailing `# comment` and a CRLF line ending are all still
 * assignments: refusing them left `$NPM` unresolved, and an attested publish
 * elsewhere in the file then satisfied the non-vacuity guard, so being too
 * strict here passes an unattested publish just as being too loose does.
 *
 * Escapes are honoured outside single quotes, so `NPM=npm\\ publish` is one word
 * holding a command while `CMD='"'"'a\\b'"'"' keeps its backslash as the shell does.
 * A value that still carries a substitution, backtick, quote or parenthesis
 * after unescaping is refused: inlining `pkg_name="$(node -p …)"` injects an
 * unbalanced parenthesis into an unrelated command, and the scan then reports
 * invocations that are not there while losing the one that is -- a false
 * verdict in both directions, which is worse than not resolving the variable.
 * Shell metacharacters (`;`, `&`, `|`, `<`, `>`, `{`, `}`) are also refused
 * after unescaping: an escaped `\;` would become `;`, and the tokeniser would
 * split on it, so `FLAG=--provenance\;` would let an unattested publish borrow
 * a flag the shell passes as a literal `--provenance;` argument.
 *
 * Two things the shell does that a line-at-a-time reading missed both let an
 * unattested publish pass. A heredoc body is stdin data and binds nothing, yet
 * `FLAG=--provenance` inside one was indexed as an assignment; see
 * {@link heredocBodyLines}. And `unset FLAG` discards a binding, yet the map
 * kept it, so a later `npm publish $FLAG` borrowed a flag the shell no longer
 * passed; see the deletion below.
 *
 * Because `unset` makes a binding's lifetime positional, the result is one map
 * per line rather than one per file. Reading every invocation against the
 * file's end state would report an unattested publish for a flag that was
 * genuinely set where the publish runs and unset only afterwards.
 *
 * @param text - File contents with continuations already joined.
 * @returns One map per line: the bindings in effect once that line has run.
 */
export function shellScalarsByLine(text: string): Array<Map<string, string>> {
  const lines = text.split("\n");
  const bodies = heredocBodyLines(lines);
  const scalars = new Map<string, string>();
  return lines.map((line, index) => {
    if (!bodies[index]!) {
      for (const [name, value] of literalScalarAssignments(line)) {
        // Shell metacharacters that survive unescaping must not be inlined: an
        // escaped `\;` becomes `;` here, and tokenizeCommands would split on it,
        // so `FLAG=--provenance\;` would let an unattested publish borrow a flag
        // the shell passes as a literal argument. Reject the same characters
        // tokenizeCommands treats as operators or structural delimiters.
        if (!/[$`"'(){};&|<>#]/.test(value)) scalars.set(name, value);
      }
      for (const command of tokenizeCommands(line)) {
        for (const name of unsetNames(command)) scalars.delete(name);
      }
    }
    // A copy per line: the map keeps mutating, and an invocation must be read
    // against the bindings that stood where it runs, not the file's end state.
    return new Map(scalars);
  });
}

/**
 * The scalar bindings standing at the end of a file.
 *
 * @param text - File contents with continuations already joined.
 * @returns Variable name mapped to the literal text it holds.
 */
export function shellScalars(text: string): Map<string, string> {
  const perLine = shellScalarsByLine(text);
  // `String.prototype.split` never returns an empty array, so there is always a
  // final line to read the closing state from.
  return perLine[perLine.length - 1]!;
}

/** Decide whether shell quoting permits expansion at one source offset. */
function isExpandableReference(line: string, offset: number): boolean {
  let precedingBackslashes = 0;
  for (let index = offset - 1; index >= 0 && line[index] === "\\"; index -= 1) precedingBackslashes += 1;
  if (precedingBackslashes % 2 === 1) return false;

  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < offset; index += 1) {
    const character = line[index]!;
    if (character === "\\" && !singleQuoted) {
      index += 1;
      continue;
    }
    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    else if (character === '"' && !singleQuoted) doubleQuoted = !doubleQuoted;
  }
  return !singleQuoted;
}

/**
 * Expand unescaped, non-single-quoted scalar references against known bindings.
 *
 * An unknown name is left in place for the same reason an unknown array is:
 * erasing it would turn "not understood" into "carries no flags", which reads
 * as a pass.
 *
 * @param line - One logical command.
 * @param scalars - Scalar assignments from the same file.
 * @returns The command with expandable known scalar references inlined.
 */
export function expandScalars(line: string, scalars: Map<string, string>): string {
  // One of the two alternatives always captures the name, so there is no
  // nameless match to guard against.
  return line.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced: string | undefined, bare: string | undefined, offset: number) => {
      if (!isExpandableReference(line, offset)) return whole;
      const value = scalars.get(braced ?? bare!);
      // The decoded value is inserted back into shell source. Double literal
      // backslashes so tokenisation preserves them as argument characters rather
      // than consuming them as fresh source-level escapes.
      return value?.replace(/\\/g, "\\\\") ?? whole;
    });
}

/**
 * Expand `"${name[@]}"` references against the file's array declarations.
 *
 * An unknown name is left untouched rather than erased: silently dropping it
 * would turn "this scan does not understand the command" into "this command has
 * no flags", which reads as a pass.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with referenced array contents inlined.
 */
export function expandArrays(line: string, arrays: Map<string, string>): string {
  return line.replace(/"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?/g,
    (whole, name: string, offset: number) => isExpandableReference(line, offset)
      ? arrays.get(name) ?? whole
      : whole);
}

/** The outcome of one verifier run. */
export interface VerifierResult {
  /** Reasons the run failed; empty means it passed. */
  failures: string[];
  /** Lines describing what was checked, for the operator. */
  notes: string[];
}
