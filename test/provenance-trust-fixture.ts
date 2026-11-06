/** Isolate TUF distribution while keeping the real Sigstore verifier and public trust material. */
import { mock } from "node:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { TrustedRoot } from "@sigstore/protobuf-specs";

const require = createRequire(import.meta.url);
for (const client of [require.resolve("sigstore"), new URL("../.github/release-runtime/node_modules/sigstore/dist/index.js", import.meta.url).pathname]) {
  if (!existsSync(client)) continue;
  const tuf = createRequire(client)("@sigstore/tuf") as { getTrustedRoot: () => Promise<ReturnType<typeof TrustedRoot.fromJSON>> };
  mock.method(tuf, "getTrustedRoot", async () => TrustedRoot.fromJSON(JSON.parse(readFileSync(new URL("fixtures/provenance/trusted-root.json", import.meta.url), "utf8"))));
}
