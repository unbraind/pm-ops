/** Independent stable-version oracle over a bounded, exhaustive comparator domain. */
import { satisfies } from "semver";
import { requiredFixtureCases } from "./fixture-contracts.ts";

/** A setup-node selector and whether it can select a continuation-compatible runtime. */
export interface SelectionCase { selection: string; supported: boolean }

/** Explicit finite oracle domain; witnesses include one patch beyond comparator endpoints. */
export interface SelectionGridBounds { minMajor: number; maxMajor: number; maxMinor: number; maxEndpointPatch: number }

/** Defaults intentionally cover majors 20-25, minors 0-20, endpoint patches 0-2 and witness patches 0-3. */
export const selectionGridBounds: SelectionGridBounds = { minMajor: 20, maxMajor: 25, maxMinor: 20, maxEndpointPatch: 2 };

/** Build both grids from the same bounds so widening endpoints also widens their stable witnesses. */
export function continuationSelectionGrid(bounds: SelectionGridBounds = selectionGridBounds): { versions: string[]; endpoints: string[] } {
  const versions: string[] = [], endpoints: string[] = [];
  for (let major = bounds.minMajor; major <= bounds.maxMajor; major++) for (let minor = 0; minor <= bounds.maxMinor; minor++) for (let patch = 0; patch <= bounds.maxEndpointPatch + 1; patch++) {
    const version = `${major}.${minor}.${patch}`;
    if (patch <= bounds.maxEndpointPatch) endpoints.push(version);
    if ((major === 22 && minor >= 18) || (major === 23 && minor >= 6) || major >= 24) versions.push(version);
  }
  return { versions, endpoints };
}

/** Required CLI contracts are independent of corpus order and fail on renamed or missing cases. */
export function continuationCliCases<T extends SelectionCase>(rows: readonly T[]): T[] {
  return requiredFixtureCases(rows, [">=20 <21", ">=23 <23.6", ">=24.0.0-alpha <24.0.0", "20 || 24", "^22.17.0", "lts/*"], row => row.selection);
}

/** Include adversarial syntax, aliases and seeded ranges with exact finite-domain witnesses. */
export function continuationSelectionCases(bounds: SelectionGridBounds = selectionGridBounds): SelectionCase[] {
  const cases = [
    ...[">=20 <21", "<22.18", ">=23 <23.6", "<=22.17.999", "^20 || ~23.5", ">23.5.0 <23.6.0", ">=24.0.0-alpha <24.0.0", ">=24.0.0 <24.0.0", "~22.17.0", "lts/iron", ">=23.0.0-alpha <23.0.1", ">9007199254740991.9007199254740991.9007199254740991"].map(selection => ({ selection, supported: false })),
    ...[">=20 <24", "20 || 24", "20 - 24", "<23", "23.5 - 23.6", "22.17 - 22.18", "^22.17.0", "^23.5.0", "v22.18.0", "23.x", ">=24.0.0-alpha <24.0.1", ">=20", "node", "latest", "lts/*", "lts/jod", "lts/future", "*", ">22.18.9007199254740991 <23", ">24.9007199254740991.9007199254740991 <26"].map(selection => ({ selection, supported: true })),
  ];
  // Exact only on this comparator domain: every strict lower endpoint has its
  // stable successor in the witness grid. Larger versions use fixed adversarial cases.
  const { versions, endpoints } = continuationSelectionGrid(bounds);
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
