/** Deterministic executable API boundaries; callers still exercise the real policy and auditor. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** Install canonical tag responses and an offline curl boundary for one test process. */
export function canonicalTagsFixture(tags: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), "canonical-tags-"));
  const previous = { PATH: process.env.PATH, CANONICAL_TAG_FIXTURE: process.env.CANONICAL_TAG_FIXTURE };
  const refs = join(root, "refs");
  const gh = join(root, "gh"), curl = join(root, "curl");
  writeFileSync(gh, '#!/bin/sh\ncat "$CANONICAL_TAG_FIXTURE"\n');
  writeFileSync(curl, "#!/bin/sh\nexit 7\n");
  chmodSync(gh, 0o755);
  chmodSync(curl, 0o755);
  process.env.PATH = `${root}:${previous.PATH}`;
  process.env.CANONICAL_TAG_FIXTURE = refs;
  /** Replace the canonical server snapshot, or make both transports unavailable. */
  function setTags(value: Readonly<Record<string, string>> | null): void {
    if (value === null) rmSync(refs, { force: true });
    else writeFileSync(refs, Object.entries(value).map(([tag, sha]) => `refs/tags/${tag}\tcommit\t${sha}`).join("\n"));
  }
  setTags(tags);
  return {
    root, refs, gh, curl, setTags,
    /** Restore the process environment and remove only this fixture's files. */
    restore(): void {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}


/** Render the canonical caller and install deterministic transports until this file's tests finish. */
export function releaseCallerFixture() {
  const releasedSha = "c3af218f2f052cc4fddb3e84ef87974c58283be7";
  const canonical = { "v2026.10.19": releasedSha };
  const caller = readFileSync(new URL("../templates/release-caller.yml", import.meta.url), "utf8").replaceAll("0".repeat(40), releasedSha);
  const api = canonicalTagsFixture(canonical);
  after(() => api.restore());
  return { releasedSha, canonical, caller, api };
}
