/** Intercept both PATH-based npm and the CLI adjacent to the selected Node executable. */
import { chmodSync, cpSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Install one synthetic npm for every platform route; restore process state after the scenario. */
export function interceptRuntimeNpm(root: string, script: string): () => void {
  const savedPath = process.env.PATH;
  const executable = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const bin = join(root, "bin");
  mkdirSync(join(bin, "node_modules/npm/bin"), { recursive: true });
  const source = `#!${process.execPath}\n${script}`;
  writeFileSync(join(bin, "npm"), source);
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(bin, "node_modules/npm/bin/npm-cli.js"), source);
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
