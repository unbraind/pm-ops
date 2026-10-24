/** Strict, non-extracting canonical manifests for npm's USTAR/PAX artifacts. */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** Unsafe or ambiguous archive contents cannot authorize release repair. */
export class TarballRefusal extends Error {
  /** Stable machine-readable refusal classification. */
  readonly code = "invalid_tarball";
  /** Archive refusal is an input error. */
  readonly exitCode = 2;
  /** Sanitized cause, independent of member names. */
  readonly reason: "entry_type" | "path" | "collision" | "format";
  /** Construct a sanitized diagnostic without registry-controlled names. */
  constructor(reason: "entry_type" | "path" | "collision" | "format") {
    super(`invalid_tarball: ${reason}; supply an unambiguous package archive containing only regular files and directories`);
    this.name = "TarballRefusal";
    this.reason = reason;
  }
}

/** A fixed-order record binds every supported filesystem property. */
type ManifestEntry = [path: string, type: "file" | "directory", mode: number, size: number, linkTarget: string, sha512: string];

/** Decode strict UTF-8 while preserving BOM characters in names and metadata. */
function utf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new TarballRefusal("format"); }
}

/** Decode a NUL-padded header field without accepting hidden suffix bytes. */
function field(block: Buffer, start: number, length: number): string {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  if (end === -1) return utf8(bytes);
  if (bytes.subarray(end).some((byte) => byte !== 0)) throw new TarballRefusal("format");
  return utf8(bytes.subarray(0, end));
}

/** Accept only exact, nonnegative safe octal header integers. */
function octal(block: Buffer, start: number, length: number): number {
  const text = utf8(block.subarray(start, start + length)).replace(/[\0 ]+$/, "").trimStart();
  if (!/^[0-7]+$/.test(text)) throw new TarballRefusal("format");
  return Number.parseInt(text, 8);
}

/** Decode bounded POSIX extended headers, refusing unknown semantic overrides. */
function pax(bytes: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const lengthText = utf8(bytes.subarray(offset, space));
    const length = Number(lengthText);
    if (space < offset || !/^[1-9][0-9]*$/.test(lengthText) || !Number.isSafeInteger(length)
      || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new TarballRefusal("format");
    const record = utf8(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    if (equals < 1 || result.has(key) || !/^(path|linkpath|size|mtime|atime|ctime|uid|gid|uname|gname)$/.test(key)) throw new TarballRefusal("format");
    result.set(key, record.slice(equals + 1));
    offset += length;
  }
  return result;
}

/** Normalize safe package-root paths; aliases remain visible to duplicate detection. */
function packagePath(raw: string, directory: boolean): string {
  if (/[\\\0]/.test(raw) || raw.startsWith("/") || raw.split("/").includes("..")) throw new TarballRefusal("path");
  if (!directory && (raw.endsWith("/") || raw.endsWith("/."))) throw new TarballRefusal("path");
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts[0] !== "package" || (parts.length === 1 && !directory)) throw new TarballRefusal("path");
  return parts.join("/");
}

/**
 * Read an uncompressed archive in fixed chunks, never extracting a member.
 * PAX is transport metadata for the following entry, not a filesystem entry.
 * All other extension kinds fail closed. See docs/tarball-manifests.md.
 */
export function canonicalTarManifest(path: string): string {
  const fd = openSync(path, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const entries = new Map<string, ManifestEntry>();
  const spellings = new Map<string, string>();
  const parents = new Set<string>();
  let extended: Map<string, string> | undefined;
  /** Read exactly the requested bytes or refuse a truncated archive. */
  function read(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new TarballRefusal("format");
      offset += count;
    }
  }
  try {
    for (;;) {
      const header = Buffer.alloc(512); read(header);
      if (header.every((byte) => byte === 0)) {
        read(header);
        if (header.some((byte) => byte !== 0) || extended || entries.size === 0) throw new TarballRefusal("format");
        let count: number;
        while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          if (chunk.subarray(0, count).some((byte) => byte !== 0)) throw new TarballRefusal("format");
        }
        break;
      }
      const checksum = octal(header, 148, 8);
      const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (sum !== checksum || field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00"
        || !/^0*$/.test(field(header, 329, 8).trim()) || !/^0*$/.test(field(header, 337, 8).trim())) throw new TarballRefusal("format");
      const kind = field(header, 156, 1);
      const rawSize = octal(header, 124, 12);
      if (kind === "x") {
        if (extended || rawSize > 1024 * 1024) throw new TarballRefusal("format");
        const metadata = Buffer.alloc(rawSize); read(metadata);
        extended = pax(metadata);
        read(Buffer.alloc((512 - rawSize % 512) % 512));
        continue;
      }
      if (kind !== "0" && kind !== "" && kind !== "5") throw new TarballRefusal("entry_type");
      const directory = kind === "5";
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      const entryPath = packagePath(extended?.get("path") ?? (prefix ? `${prefix}/${name}` : name), directory);
      const link = extended?.get("linkpath") ?? field(header, 157, 100);
      const sizeText = extended?.get("size");
      const size = sizeText === undefined ? rawSize : Number(sizeText);
      const mode = octal(header, 100, 8);
      if ((sizeText !== undefined && !/^(0|[1-9][0-9]*)$/.test(sizeText)) || !Number.isSafeInteger(size)
        || mode > 0o7777 || link !== "" || (directory && size !== 0)) throw new TarballRefusal("format");
      extended = undefined;
      if (entries.has(entryPath)) throw new TarballRefusal("collision");
      const parts = entryPath.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const spelling = parts.slice(0, i).join("/");
        const key = spelling.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
        const previous = spellings.get(key);
        if (previous !== undefined && previous !== spelling) throw new TarballRefusal("collision");
        spellings.set(key, spelling);
        if (i < parts.length) {
          parents.add(spelling);
          if (entries.get(spelling)?.[1] === "file") throw new TarballRefusal("collision");
        }
      }
      if (!directory && parents.has(entryPath)) throw new TarballRefusal("collision");
      const hash = createHash("sha512");
      let remaining = size;
      while (remaining > 0) {
        const bytes = chunk.subarray(0, Math.min(chunk.length, remaining)); read(bytes);
        hash.update(bytes); remaining -= bytes.length;
      }
      read(Buffer.alloc((512 - size % 512) % 512));
      entries.set(entryPath, [entryPath, directory ? "directory" : "file", mode, size, link, hash.digest("hex")]);
    }
    return JSON.stringify([...entries.values()].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  } finally { closeSync(fd); }
}
