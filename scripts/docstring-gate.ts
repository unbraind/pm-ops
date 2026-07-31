#!/usr/bin/env node
/**
 * Docstring coverage gate for this package.
 *
 * Thin wrapper around the `pm-ops` docstring analyzer: it runs the analyzer
 * over this package's own source tree and exits non-zero when any declaration
 * lacks a real docstring, so the gate drops into `release:check` and CI
 * unchanged. Every rule lives in the analyzer module; this script only wires
 * its report to the process exit code and prints the violations.
 *
 * @example
 * ```bash
 * node scripts/docstring-gate.ts
 * ```
 */

import { join } from "node:path";
import { analyzeDocstringCoverage } from "../docstrings.ts";

const root = join(import.meta.dirname, "..");
const report = analyzeDocstringCoverage({ root });

if (report.violations.length > 0) {
  let message = `\ndocstring-gate: ${report.violations.length} violation(s) across ${report.files_scanned} file(s):\n\n`;
  for (const violation of report.violations) {
    message += `  ${violation.file}:${violation.line}  ${violation.symbol} — ${violation.reason}\n`;
  }
  message += "\nEvery exported declaration, every public member of an exported class,\n";
  message += "and every non-exported function with a body over the threshold needs a real\n";
  message += "JSDoc block comment that adds information the identifier does not.\n";
  console.error(message);
  process.exit(1);
}

console.log(`docstring-gate: ${report.files_scanned} file(s), ${report.declarations_checked} declaration(s) documented.`);
