/** Inspect every command in bootstrap steps rather than exempting the whole script. */
import assert from "node:assert/strict";
import { commandArguments, commandName, tokenizeCommands } from "../shell-scan.ts";

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
  for (const command of tokenizeCommands(script)) {
    // Preserve exec/x as npm subcommands instead of consuming them as shell
    // wrappers. Keep command positions, so printed arguments remain inert.
    const protectedCommand = command.map((token, index) =>
      /^(?:exec|x)$/.test(token.value) && /(?:^|[\\/])npm(?:\.cmd)?$/.test(command[index - 1]?.value ?? "")
        ? { ...token, value: `npm-subcommand-${token.value}` } : token);
    if (!/^(?:npm|npm\.cmd)$/.test(commandName(protectedCommand) ?? "")) continue;
    const words = ["npm", ...commandArguments(protectedCommand).map(token => token.value.replace(/^npm-subcommand-(exec|x)$/, "$1"))];
    if (acquiringExec(words) || INSTALL_SUBCOMMANDS.includes((npmSubcommand(words) ?? "").replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()))) {
      installs.push(words);
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
