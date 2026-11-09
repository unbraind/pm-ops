/** Intercept both PATH-based npm and the CLI adjacent to the selected Node executable. */
import { chmodSync, cpSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Install one synthetic npm for every platform route; restore process state after the scenario. */
export function interceptRuntimeNpm(root: string, script: string): () => void {
  const savedPath = process.env.PATH;
  const executable = Object.getOwnPropertyDescriptor(process, "execPath")!;
  // The directory name contains a space deliberately: fixture paths must stay
  // safe when Node executables and checkouts live under spaces (see the wrapper below).
  const bin = join(root, "bin with space");
  mkdirSync(join(bin, "node_modules/npm/bin"), { recursive: true });
  const source = `#!${process.execPath}\n${script}`;
  writeFileSync(join(bin, "node_modules/npm/bin/npm-cli.js"), source);
  // A shebang cannot carry a Node executable path containing spaces (the
  // kernel splits it there), so the PATH command is a quoted wrapper that
  // launches the adjacent CLI with the real Node executable; on Windows the
  // PATH command is never launched without a shell and stays the JS source.
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const command = process.platform === "win32" ? source
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bin, "node_modules/npm/bin/npm-cli.js"))} "$@"\n`;
  writeFileSync(join(bin, "npm"), command);
  chmodSync(join(bin, "npm"), 0o755);
  const node = join(bin, process.platform === "win32" ? "node.exe" : "node");
  // Windows file symlinks need Developer Mode or elevation, which runners and
  // ordinary users do not have; a hard link needs no privilege and a real copy
  // covers a temporary directory on another volume.
  if (process.platform === "win32") {
    try { linkSync(process.execPath, node); } catch { cpSync(process.execPath, node); chmodSync(node, 0o755); }
  } else {
    symlinkSync(process.execPath, node, "file");
  }
  process.env.PATH = bin + delimiter + (savedPath ?? "");
  Object.defineProperty(process, "execPath", { ...executable, value: node });
  return () => {
    Object.defineProperty(process, "execPath", executable);
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  };
}
