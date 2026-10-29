/** Shared production example and independent bounded exact oracle. */
import { readFileSync } from "node:fs";
import type { ReverificationInput } from "../reverification-plans.ts";

/** Load the documented example without copying its producer contract. */
export function repairFixture(): ReverificationInput {
  return JSON.parse(readFileSync(new URL("../docs/examples/reverification.json", import.meta.url), "utf8")) as ReverificationInput;
}

/** Independent powerset and topological-set reference; integer decisions use BigInt. */
export function minimumCost(input: ReverificationInput): bigint {
  const executable = (selected: typeof input.checks): boolean => {
    const done = new Set<string>();
    for (let pass = 0; pass < selected.length; pass++) {
      for (const check of selected) if (check.approved && check.requires.every((id) => done.has(id))) done.add(check.id);
    }
    return done.size === selected.length;
  };
  let subsets: typeof input.checks[] = [[]];
  for (const check of input.checks) subsets = subsets.flatMap((set) => [set, [...set, check]]);
  const feasible = subsets.filter(executable);
  const repairable = input.targets.filter((id) => input.claims.find((claim) => claim.id === id)!.status !== "fresh"
    && feasible.some((set) => set.some((check) => check.supports.includes(id))));
  let best: bigint | undefined;
  for (const set of feasible) {
    if (!repairable.every((id) => set.some((check) => check.supports.includes(id)))) continue;
    const cost = set.reduce((sum, check) => sum + BigInt(check.cost), 0n);
    if (best === undefined || cost < best) best = cost;
  }
  return best!;
}
