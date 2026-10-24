/** Seeded hostile real-archive corpus, plus strict framing and PAX regression checks. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { canonicalTarManifest, TarballRefusal } from "../canonical-tar.ts";
import { defaultExec } from "../release-completeness.ts";
import { checksum, paxRecord, tarball, tarMember, type TarMember } from "./tar-fixtures.ts";

test("seeded mutation fuzz refuses every changed real tarball (32 seeds)", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-corpus-"));
  try {
    const archive = join(root, "archive.tar");
    const compressed = join(root, "archive.tgz");
    for (let seed = 1; seed <= 32; seed++) {
      let state = seed;
      /** Deterministic PRNG keeps every corpus case reproducible. */
      const random = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
      const body = Buffer.from(Array.from({ length: 1 + random() % 4096 }, () => random() & 255));
      const members: TarMember[] = [
        { path: "package/", type: "5", mode: 0o755 },
        { path: `package/file-${seed}.bin`, body, mode: 0o644 },
        { path: "package/empty", mode: 0o644 },
      ];
      /** Materialize and decode genuine gzip/USTAR bytes, with no tar adapter. */
      const manifest = (entries: TarMember[]): string => {
        const bytes = tarball(entries); writeFileSync(compressed, bytes);
        writeFileSync(archive, gunzipSync(bytes)); return canonicalTarManifest(archive);
      };
      const baseline = manifest(members);
      assert.equal(manifest([...members].reverse()), baseline, `seed ${seed}: unmutated pair`);
      assert.match(defaultExec("tar", ["-tzf", compressed]), /package\/empty/, "real tar accepts corpus baseline");
      const changedBody = Buffer.from(body); changedBody[random() % body.length] ^= 0xff;
      const mutations: [string, TarMember[]][] = [
        ["mode change", members.map((entry, i) => i === 1 ? { ...entry, mode: 0o755 } : entry)],
        ["extra entry", [...members, { path: "package/extra", body }]],
        ["missing entry", members.filter((_, i) => i !== 1)],
        ["duplicate path", [...members, members[1]!]],
        ["normalized duplicate", [...members, { path: `package/./file-${seed}.bin`, body }]],
        ["normalization collision", [...members, { path: `package/FILE-${seed}.bin`, body }]],
        ["Unicode collision", [...members, { path: "package/café" }, { path: "package/cafe\u0301" }]],
        ["prefix case collision", [...members, { path: "package/Dir/a" }, { path: "package/dir/b" }]],
        ["content change at equal size", members.map((entry, i) => i === 1 ? { ...entry, body: changedBody } : entry)],
        ["empty vs missing", members.filter((_, i) => i !== 2)],
        ["directory mode change", members.map((entry, i) => i === 0 ? { ...entry, mode: 0o700 } : entry)],
        ["directory vs missing", members.slice(1)],
        ["implicit directory type swap", members.map((entry, i) => i === 2 ? { ...entry, path: "package/empty/" } : entry)],
        ["terminal dot directory alias", members.map((entry, i) => i === 2 ? { ...entry, path: "package/empty/." } : entry)],
        ["file parent first", [...members, { path: "package/empty/child" }]],
        ["file parent last", [...members, { path: "package/parent/child" }, { path: "package/parent" }]],
      ];
      for (const type of ["1", "2", "3", "4", "6", "7", "D", "Z", "L", "g"]) {
        mutations.push([`type swap ${type}`, members.map((entry, i) => i === 2 ? { ...entry, type, link: "target-a" } : entry)]);
      }
      mutations.push(["link target change", members.map((entry, i) => i === 2 ? { ...entry, type: "2", link: `target-${random()}` } : entry)]);
      for (const path of ["../escape", "package/../escape", "/package/empty", "package\\empty", "elsewhere/empty", "package"])
        mutations.push([`path traversal ${path}`, members.map((entry, i) => i === 2 ? { ...entry, path } : entry)]);
      mutations.push(["NUL in PAX path", [...members, { path: "PaxHeader", type: "x", body: paxRecord("path", "package/evil\0suffix") }, { path: "package/placeholder" }]]);
      for (const [name, mutated] of mutations) {
        assert.throws(() => assert.equal(manifest(mutated), baseline), (error: unknown) => error instanceof TarballRefusal || error instanceof assert.AssertionError, `seed ${seed}: ${name}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict archive framing, exact fields and bounded PAX metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-tar-format-"));
  const archive = join(root, "archive.tar");
  /** Read an actual uncompressed tar archive and enforce typed sanitized refusals. */
  const manifest = (bytes: Buffer): string => { writeFileSync(archive, bytes); return canonicalTarManifest(archive); };
  const entry = tarMember({ path: "package/a", body: Buffer.from("A") });
  const end = Buffer.alloc(1024);
  /** Edit one header and preserve a valid checksum to reach the intended validation. */
  const edit = (offset: number, value: string): Buffer => {
    const bytes = Buffer.from(entry); bytes.write(value, offset, "utf8"); checksum(bytes.subarray(0, 512)); return bytes;
  };
  /** Append a valid terminator to the supplied records. */
  const records = (...bytes: Buffer[]): Buffer => Buffer.concat([...bytes, end]);
  try {
    const expected = manifest(records(entry));
    assert.equal(manifest(records(edit(156, "\0"))), expected, "legacy regular flag canonicalizes to file");
    assert.equal(manifest(records(edit(136, "00000000002\0"))), expected, "npm rewrites timestamps");
    assert.equal(manifest(records(tarMember({ path: "a", prefix: "package", body: Buffer.from("A") }))), expected, "USTAR prefixes decode");
    const metadata = Buffer.concat([paxRecord("path", "package/a"), paxRecord("size", "1"), paxRecord("linkpath", ""), paxRecord("mtime", "123.5"), paxRecord("uid", "99")]);
    const pax = tarMember({ path: "PaxHeader", type: "x", body: metadata });
    assert.equal(manifest(records(pax, tarMember({ path: "placeholder", body: Buffer.from("A") }))), expected);
    assert.equal(manifest(Buffer.concat([records(entry), Buffer.alloc(512)])), expected, "trailing zero padding");
    const fullName = `package/${"a".repeat(92)}`;
    assert.ok(manifest(records(tarMember({ path: fullName }))).includes(fullName), "non-NUL full-width header string");
    const malformed: Buffer[] = [
      Buffer.alloc(0), end, entry, Buffer.concat([entry, Buffer.alloc(512), entry]),
      Buffer.concat([records(entry), Buffer.from("hidden trailer")]), records(pax), records(pax, pax, entry),
      records(edit(100, "not-oct\0")), records(edit(124, "77777777777\0"), Buffer.alloc(0)),
      records(edit(257, "other\0")), records(edit(0, "package/a\0hidden")),
      records(edit(263, "01")), records(edit(329, "0000001\0")), records(edit(337, "0000001\0")),
      records(edit(100, "0177777\0")), records(edit(157, "target")), records(edit(156, "5")),
      records(tarMember({ path: "PaxHeader", type: "x", body: Buffer.alloc(1024 * 1024 + 1) })),
    ];
    const badChecksum = Buffer.from(entry); badChecksum[0] ^= 1; malformed.push(records(badChecksum));
    const invalidUtf8 = Buffer.from(entry); invalidUtf8[0] = 255; checksum(invalidUtf8.subarray(0, 512)); malformed.push(records(invalidUtf8));
    for (const body of [Buffer.from("bad"), Buffer.from("0 a=b\n"), Buffer.from("9 a=b\n"), Buffer.from("6 a=b!"), Buffer.from("4 =\n"),
      Buffer.concat([paxRecord("path", "a"), paxRecord("path", "b")]), paxRecord("unknown", "value"),
      paxRecord("size", "-1"), paxRecord("size", "9007199254740992"), paxRecord("size", "01")]) {
      malformed.push(records(tarMember({ path: "PaxHeader", type: "x", body }), entry));
    }
    // Numeric fields cannot be represented exactly outside JS's safe range.
    const oversized = Buffer.from(entry); oversized.fill(55, 124, 136); checksum(oversized.subarray(0, 512)); malformed.push(records(oversized));
    for (const bytes of malformed) assert.throws(() => manifest(bytes), (error: unknown) => error instanceof TarballRefusal && error.code === "invalid_tarball" && error.exitCode === 2 && !error.message.includes(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
