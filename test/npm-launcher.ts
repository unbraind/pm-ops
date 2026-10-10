/** Resolve npm's installed Windows CLI without passing arguments through a shell. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Follow the selected npm shim's package metadata and npm-prefix.js precedence. */
export function npmLauncher(program: "npm" | "npx", args: string[], env: NodeJS.ProcessEnv): { executable: string; args: string[] } {
  if (process.platform !== "win32") return { executable: program, args };
  const shim = execFileSync("where.exe", [program], { env, encoding: "utf8" }).trim().split(/\r?\n/)[0];
  assert.ok(shim, `Cannot locate ${program} on PATH`);
  let metadata = createRequire(join(dirname(shim), "package.json")).resolve("npm/package.json");
  // npm's own cmd launchers prefer the configured global installation when
  // present. Read that prefix using the installed script, not a guessed path.
  const prefix = execFileSync(process.execPath, [join(dirname(metadata), "bin/npm-prefix.js")], {
    env, encoding: "utf8",
  }).trim();
  const globalMetadata = join(prefix, "node_modules/npm/package.json");
  if (existsSync(globalMetadata)) metadata = globalMetadata;
  const pkg: unknown = JSON.parse(readFileSync(metadata, "utf8"));
  assert.ok(pkg !== null && typeof pkg === "object" && "name" in pkg && pkg.name === "npm"
    && "bin" in pkg && pkg.bin !== null && typeof pkg.bin === "object"
    && "npm" in pkg.bin && "npx" in pkg.bin);
  const entry = pkg.bin[program];
  assert.ok(typeof entry === "string", `Installed npm has no ${program} CLI entry`);
  return { executable: process.execPath, args: [realpathSync(join(dirname(metadata), entry)), ...args] };
}
