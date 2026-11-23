/** Shared shell classifications for release hooks and executable workflow bodies. */

/** The environments in which release shell source is inspected. */
export type ReleaseShellScope = "hook" | "workflow";

/** Shell features whose support depends on their execution context. */
type ReleaseConstruct = "case arms" | "shell negation" | "pipefail" | "time prefix" | "container job";

/** Identify a construct outside the grammar in its current execution context. */
export function unsupportedReleaseConstruct(
  construct: ReleaseConstruct, scope: ReleaseShellScope, shell = "bash",
): boolean {
  if (construct === "pipefail") return scope === "workflow" && shell === "sh";
  return construct === "time prefix" || (construct === "container job" ? scope === "workflow" : scope === "hook");
}

/** Stable diagnostic code for package hook grammar refusals. */
export const UNSUPPORTED_RELEASE_HOOK = "release_hook_unsupported_construct";

/** Report a grammar refusal with owning hook and migration advice. */
export function describeUnsupportedReleaseHook(construct: string, hook: string): string {
  return `${UNSUPPORTED_RELEASE_HOOK}: ${construct} in hook ${JSON.stringify(hook)}. Simplify the hook to the supported forms, or move the logic into a script file.`;
}

/** A shell prefix requires an unquoted identifier. The env utility accepts any nonempty name. */
export function isShellAssignment(word: { value: string; startsQuoted?: boolean }, utility = false): boolean {
  return utility ? /^[^=]+=/.test(word.value) : !word.startsQuoted && /^[A-Za-z_]\w*\+?=/.test(word.value);
}

/** The current position within each nested shell case. */
export type ShellCaseState = "subject" | "in" | "pattern" | "pattern-data" | "body";

/** A case can read its next pattern or the remaining words in a started pattern. */
export function inShellCasePattern(state: ShellCaseState | undefined): boolean {
  return state === "pattern" || state === "pattern-data";
}

/** Classify case words before a scanner treats them as executable argv. */
export function readShellCaseWord(
  stack: ShellCaseState[], value: string, literal: boolean, commandStart: boolean,
): "open" | "header" | "pattern" | "close" | undefined {
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
export function unsupportedReleaseCommand(words: Iterable<string>, scope: ReleaseShellScope): string | undefined {
  let negation: string | undefined;
  for (const word of words) {
    const raw = word.replaceAll("\\\n", "");
    if (/^\(*time$/.test(raw) && unsupportedReleaseConstruct("time prefix", scope)) return "time prefix";
    if (/^\(*!$/.test(raw)) {
      if (unsupportedReleaseConstruct("shell negation", scope)) negation = "shell negation";
      continue;
    }
    if (/^(?:\(+|\{|if|then|elif|else|do|while|until)$/.test(raw)) continue;
    if (/^\(*case$/.test(raw) && unsupportedReleaseConstruct("case arms", scope)) return "case arms";
    break;
  }
  return negation;
}

/** Count the physical source characters occupied by a case arm terminator. */
export function shellCaseTerminator(text: string, index: number): number {
  const match = /^;(?:\\\n)*(?:;(?:\\\n)*&|;|&)/.exec(text.slice(index));
  return match?.[0].length ?? 0;
}

/** Read one logical shell line and retain its physical end for edits. */
export function readShellLogicalLine(text: string, start: number, joins: (line: string) => boolean): { value: string; end: number; lines: number } {
  let end = start;
  let value = "";
  let lines = 0;
  do {
    const newline = text.indexOf("\n", end);
    const line = text.slice(end, newline < 0 ? text.length : newline).replace(/\r$/, "");
    end = newline < 0 ? text.length : newline + 1;
    lines++;
    if (!joins(line) || newline < 0) return { value: value + line, end, lines };
    value += line.slice(0, -1);
  } while (end < text.length);
  return { value, end, lines };
}

/** An odd final backslash escapes the newline after the literal pairs. */
export function hasShellContinuation(line: string): boolean {
  return /(?<!\\)(?:\\\\)*\\$/.test(line);
}
