/** Keep release step output receipts aligned with filesystem changes. */
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Replace a staged release file before sending receipts, and restore it if receipt delivery fails. */
export function writeFileWithReceipts(destination: string, contents: string, writeReceipts: () => void): void {
  const present = existsSync(destination);
  const target = present ? realpathSync(destination) : destination;
  if (present) accessSync(target, constants.W_OK);
  const directory = mkdtempSync(join(dirname(target), ".release-output-"));
  const staged = join(directory, "next");
  const previous = join(directory, "previous");
  let keepBackup = false;
  try {
    writeFileSync(staged, contents);
    if (present) {
      copyFileSync(target, previous);
      chmodSync(staged, statSync(target).mode & 0o777);
    }
    renameSync(staged, target);
    try {
      writeReceipts();
    } catch (error) {
      if (present) {
        // Preserve the recovery copy if the filesystem refuses to restore it.
        keepBackup = true;
        renameSync(previous, target);
        keepBackup = false;
      } else rmSync(target);
      throw error;
    }
  } finally {
    if (!keepBackup) rmSync(directory, { recursive: true, force: true });
  }
}
