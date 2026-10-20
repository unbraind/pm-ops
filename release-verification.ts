/** Fixed-argv adapter for invoking a caller's verification gate with Bun. */
import { execFileSync } from "node:child_process";

/** Run one npm-script name with Bun and propagate every execution failure. */
export function verifyBunScript(script: string): void {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(script) || /[\r\n]/.test(script)) {
    throw new Error("Bun verification requires one npm script name");
  }
  execFileSync("bun", ["run", script], { stdio: "inherit" });
}
