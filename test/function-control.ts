/** Replace one behavioral function while retaining every surrounding assertion and fixture. */
import assert from "node:assert/strict";
import { parse } from "@babel/parser";

/** Transplant a named top-level function, refusing missing or ambiguous targets. */
export function replaceFunction(source: string, name: string, previous: string): string {
  const parsed = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const functions = parsed.program.body.filter((statement) =>
    statement.type === "FunctionDeclaration" && statement.id?.name === name);
  assert.equal(functions.length, 1, `expected exactly one function ${name}`);
  const target = functions[0]!;
  assert.ok(typeof target.start === "number" && typeof target.end === "number");
  return source.slice(0, target.start) + previous + source.slice(target.end);
}
