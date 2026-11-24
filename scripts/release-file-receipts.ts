/** Keep release step output receipts aligned with filesystem changes. */
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Replace a staged release file before sending receipts, and restore it if receipt delivery fails. */
export function writeFileWithReceipts(target: string, contents: string | Buffer, writeReceipts: () => void): void {
  const present = plainReleasePath(target);
  if (present) accessSync(target, constants.W_OK);
  const directory = mkdtempSync(join(dirname(target), ".release-output-"));
  const staged = join(directory, "next");
  const previous = join(directory, "previous");
  let keepBackup = false;
  try {
    writeFileSync(staged, contents);
    if (present) {
      copyFileSync(target, previous);
      chmodSync(staged, present.mode & 0o777);
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

/** Check ancestors in source order, including directories traversed before a literal "..". */
function plainReleasePath(path: string, directory = false): Stats | undefined {
  const parent = dirname(path);
  if (parent !== path) plainReleasePath(parent, true);
  // After checking the parent, discard trailing separators so lstat sees the component itself.
  const stat = lstatSync(resolve(path), { throwIfNoEntry: false });
  const reason = stat?.isSymbolicLink() ? "symlink" : directory ? !stat?.isDirectory() && "expected real directory"
    : stat && (!stat.isFile() ? "expected regular file" : stat.nlink !== 1 && "multiple hard links");
  if (reason) throw new Error("Unsupported release path " + path + ": " + reason);
  return stat;
}

/** Check both paths before staging, including prospective aliases on case-insensitive filesystems. */
export function assertDistinctReleaseReceipt(destination: string, receipt: string): void {
  plainReleasePath(destination);
  plainReleasePath(receipt);
  if (resolve(destination).toLowerCase() === resolve(receipt).toLowerCase()) {
    throw new Error("Release receipt " + receipt + " would use the same file as " + destination);
  }
}

/** Stage runner receipts in append order and restore earlier files if a later receipt fails. */
export function appendReleaseReceipts(receipts: readonly { path: string; text: string; records?: boolean }[]): void {
  const [receipt, ...remaining] = receipts;
  if (!receipt) return;
  const { path, text, records } = receipt;
  const previous = plainReleasePath(path) ? readFileSync(path) : Buffer.alloc(0);
  const separator = records && previous.length > 0 && previous.at(-1) !== 10 ? "\n" : "";
  const appended = Buffer.concat([previous, Buffer.from(separator + text)]);
  for (const next of remaining) assertDistinctReleaseReceipt(path, next.path);
  writeFileWithReceipts(path, appended, () => appendReleaseReceipts(remaining));
}
