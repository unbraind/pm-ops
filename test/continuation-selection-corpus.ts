/** Independent stable-version oracle over a bounded, exhaustive comparator domain. */
import { satisfies } from "semver";

/** A setup-node selector and whether it can select a continuation-compatible runtime. */
export interface SelectionCase { selection: string; supported: boolean }

/** Include adversarial syntax, aliases and seeded ranges with exact finite-domain witnesses. */
export function continuationSelectionCases(): SelectionCase[] {
  const cases = [
    ...[">=20 <21", "<22.18", ">=23 <23.6", "<=22.17.999", "^20 || ~23.5", ">23.5.0 <23.6.0", ">=24.0.0-alpha <24.0.0", ">=24.0.0 <24.0.0", "~22.17.0", "lts/iron", ">=23.0.0-alpha <23.0.1", ">9007199254740991.9007199254740991.9007199254740991"].map(selection => ({ selection, supported: false })),
    ...[">=20 <24", "20 || 24", "20 - 24", "<23", "23.5 - 23.6", "22.17 - 22.18", "^22.17.0", "^23.5.0", "v22.18.0", "23.x", ">=24.0.0-alpha <24.0.1", ">=20", "node", "latest", "lts/*", "lts/jod", "lts/future", "*", ">22.18.9007199254740991 <23", ">24.9007199254740991.9007199254740991 <26"].map(selection => ({ selection, supported: true })),
  ];
  const versions: string[] = [], endpoints: string[] = [];
  // Comparator endpoints end at patch 2, so every strict lower bound has its
  // stable successor at patch 3. The grid includes both runtime floor minors.
  for (let major = 20; major <= 25; major++) for (let minor = 0; minor <= 20; minor++) for (let patch = 0; patch <= 3; patch++) {
    const version = `${major}.${minor}.${patch}`;
    if (patch < 3) endpoints.push(version);
    if ((major === 22 && minor >= 18) || (major === 23 && minor >= 6) || major >= 24) versions.push(version);
  }
  let seed = 250;
  /** Deterministic corpus selection, independent of the implementation's parser or bands. */
  const next = (size: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % size; };
  const operators = [">=", ">", "<", "<=", ""];
  for (let index = 0; index < 160; index++) {
    const arms: string[] = [];
    for (let arm = 0; arm < 1 + index % 3; arm++) {
      const clauses: string[] = [];
      for (let clause = 0; clause < 2 + index % 2; clause++) clauses.push(operators[next(operators.length)] + endpoints[next(endpoints.length)]);
      arms.push(clauses.join(" "));
    }
    const selection = arms.join(" || ");
    cases.push({ selection, supported: versions.some(version => satisfies(version, selection)) });
  }
  return cases;
}
