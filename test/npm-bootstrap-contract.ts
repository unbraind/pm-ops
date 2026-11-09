/** Inspect every command in bootstrap steps rather than exempting the whole script. */
import assert from "node:assert/strict";
import { commandArguments, commandCandidates, commandName, tokenizeCommands } from "../shell-scan.ts";

/** npm configuration options with a separate value before the subcommand. */
const VALUE_FLAGS = new Set(["--prefix", "--cache", "--registry", "--userconfig", "--globalconfig", "--workspace", "-w", "--tag", "--access", "--otp", "--loglevel", "--omit", "--include", "--before", "--auth-type", "--provenance-file", "--location", "-L", "--package", "-p",
  "--install-strategy", "--audit-level", "--depth", "--cpu", "--os", "--libc", "--archive", "--save-prefix", "--scope", "--lockfile-version", "--fetch-retries", "--fetch-retry-factor", "--fetch-retry-mintimeout", "--fetch-retry-maxtimeout", "--fetch-timeout", "--max-sockets", "--proxy", "--https-proxy", "--noproxy", "--user-agent", "--local-address", "--ca", "--cert", "--key", "--git", "--editor", "--to", "--from", "--searchexclude", "--searchlimit", "--searchopts", "--node-options"]);

/** Read the first npm positional word, excluding configuration operands. */
function npmSubcommand(words: string[]): string | undefined {
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (word === "--") return words[index + 1];
    if (VALUE_FLAGS.has(word)) { index++; continue; }
    if (word.startsWith("-")) {
      if (["true", "false"].includes(words[index + 1])) index++;
      continue;
    }
    return word;
  }
  return undefined;
}

/** npm subcommands that install packages. */
const INSTALL_SUBCOMMANDS = ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "ic", "clean-install", "install-clean", "isntall-clean", "install-test", "installt", "it", "install-ci-test", "cit", "sit", "clean-install-test"];

/** exec and x acquire packages only with --package; without it they run local binaries. */
function acquiringExec(words: string[]): boolean {
  const subcommand = npmSubcommand(words) ?? "";
  return (subcommand === "exec" || subcommand === "x") && words.some(token => token === "--package" || token.startsWith("--package=") || token === "-p" || token.startsWith("-p="));
}

/** Enumerate npm installation commands across shell separators and install aliases. */
export function npmInstalls(script: string): string[][] {
  const installs: string[][] = [];
  const seen = new Set<string>();
  const record = (words: string[]): void => {
    const key = JSON.stringify(words);
    if (!seen.has(key)) { seen.add(key); installs.push(words); }
  };
  for (const command of tokenizeCommands(script)) {
    for (const candidate of commandCandidates(command)) {
      if (!/^(?:npm|npm\.cmd)$/.test(commandName(candidate) ?? "")) continue;
      const words = ["npm", ...commandArguments(candidate).map(token => token.value)];
      if (acquiringExec(words) || INSTALL_SUBCOMMANDS.includes((npmSubcommand(words) ?? "").replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()))) record(words);
    }
    // shell-scan consumes an `npm exec`/`npm x` pair as a wrapper prefix, so the
    // package-acquiring form is also read from the raw words candidates skip.
    const raw = command.map(token => token.value);
    for (let index = 0; index < raw.length - 1; index++) {
      if (raw[index] !== "npm" || (raw[index + 1] !== "exec" && raw[index + 1] !== "x")) continue;
      if (acquiringExec(["npm", ...raw.slice(index + 1)])) record(["npm", ...raw.slice(index + 1)]);
    }
  }
  return installs;
}

/** Keep every metadata-only reconciliation step free of dependency installation. */
export function assertNoNpmInstalls(script: string): void {
  assert.deepEqual(npmInstalls(script), [], "reconciliation must not install npm packages");
}

/** Permit exactly the pinned npm bootstrap, including the Windows Node prefix. */
export function assertPinnedNpmBootstrap(script: string): void {
  const installs = npmInstalls(script);
  assert.equal(installs.length, 1, "only the pinned npm install is allowed");
  const words = installs[0];
  const prefix = words[3] === "--prefix" ? ["--prefix", "$node_prefix"] : [];
  assert.deepEqual(words, ["npm", "install", words[2] === "--global" ? "--global" : "-g", ...prefix, "npm@11.21.0", "--ignore-scripts", "--no-audit", "--no-fund"], "only the pinned npm install is allowed");
}
