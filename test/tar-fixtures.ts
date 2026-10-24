/** Real USTAR/PAX bytes for archive mutation tests; no tar commands are mocked. */
import { gzipSync } from "node:zlib";

/** Explicit archive member properties under test. */
export interface TarMember {
  /** Complete archive member name. */
  path: string;
  /** Raw USTAR type flag. */
  type?: string;
  /** Permission and special mode bits. */
  mode?: number;
  /** Member bytes, including metadata record bodies. */
  body?: Buffer;
  /** Link target, even for intentionally invalid fixtures. */
  link?: string;
  /** Optional USTAR path prefix. */
  prefix?: string;
}

/** Recompute the actual USTAR checksum after a header mutation. */
export function checksum(header: Buffer): void {
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}

/** Encode one filesystem or PAX member with real headers, bodies and padding. */
export function tarMember(member: TarMember): Buffer {
  const body = member.body ?? Buffer.alloc(0);
  const header = Buffer.alloc(512);
  header.write(member.path, 0, 100);
  for (const [start, length, value] of [[100, 8, member.mode ?? 0o644], [108, 8, 0], [116, 8, 0], [124, 12, body.length], [136, 12, 1]]) {
    header.write(value.toString(8).padStart(length - 1, "0") + "\0", start, length, "ascii");
  }
  header.write(member.type ?? "0", 156, 1);
  header.write(member.link ?? "", 157, 100);
  header.write("ustar\0" + "00", 257, 8);
  header.write(member.prefix ?? "", 345, 155);
  checksum(header);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

/** Create a real gzip-compressed archive with the POSIX two-block terminator. */
export function tarball(members: TarMember[]): Buffer {
  return gzipSync(Buffer.concat([...members.map(tarMember), Buffer.alloc(1024)]));
}

/** Encode a POSIX length-prefixed extended-header attribute. */
export function paxRecord(key: string, value: string): Buffer {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail) + 1;
  while (length !== Buffer.byteLength(tail) + String(length).length) length = Buffer.byteLength(tail) + String(length).length;
  return Buffer.from(`${length}${tail}`);
}
