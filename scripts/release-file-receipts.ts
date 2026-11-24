/** Keep release step output receipts aligned with filesystem changes. */
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Replace a staged release file before sending receipts, and restore it if receipt delivery fails. */
export function writeFileWithReceipts(destination: string, contents: string | Buffer, writeReceipts: () => void): void {
  const target = releaseFileIdentity(resolve(destination));
  const present = existsSync(target);
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
    if (!keepBackup) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
      } catch (error) {
        console.error("Could not remove release receipt staging directory: " + (error as Error).message);
      }
    }
  }
}

/** Resolve a prospective path, including dangling links that a release write could activate. */
function releaseFileIdentity(path: string, seen = new Set<string>()): string {
  if (existsSync(path)) return realpathSync(path);
  if (seen.has(path)) throw new Error("Cannot resolve a symlink cycle in a release receipt path.");
  seen.add(path);
  const parent = dirname(path);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return releaseFileIdentity(resolve(parent, readlinkSync(path)), seen);
  }
  return existsSync(parent) ? join(realpathSync(parent), basename(path)) : path;
}

/** Refuse aliases before a receipt can overwrite the release file. */
export function assertDistinctReleaseReceipt(destination: string, receipt: string): void {
  const target = releaseFileIdentity(resolve(destination));
  const path = releaseFileIdentity(resolve(receipt));
  const targetStat = statSync(target, { throwIfNoEntry: false });
  const receiptStat = statSync(path, { throwIfNoEntry: false });
  if (path === target || (targetStat && receiptStat && targetStat.ino === receiptStat.ino && targetStat.dev === receiptStat.dev)) {
    throw new Error("The release file and GitHub receipt resolve to the same file.");
  }
}

/** Stage runner receipts in append order and restore earlier files if a later receipt fails. */
export function appendReleaseReceipts(receipts: readonly { path: string; text: string; records?: boolean }[]): void {
  const [receipt, ...remaining] = receipts;
  if (!receipt) return;
  const { path, text, records } = receipt;
  const previous = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const separator = records && previous.length > 0 && previous.at(-1) !== 10 ? "\n" : "";
  const appended = Buffer.concat([previous, Buffer.from(separator + text)]);
  writeFileWithReceipts(path, appended, () => {
    for (const next of remaining) assertDistinctReleaseReceipt(path, next.path);
    appendReleaseReceipts(remaining);
  });
}
