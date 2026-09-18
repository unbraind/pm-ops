#!/usr/bin/env node
/**
 * Thin pm-ops self-lint launcher over the canonical fleet ESLint export.
 */

import { ESLint } from "eslint";
import { fleetEslintConfig } from "../eslint.ts";

const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: fleetEslintConfig() });
const results = await eslint.lintFiles(["."]);
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output) console.error(output);
const findings = results.reduce(
  (total, result) => total + result.errorCount + result.warningCount,
  0,
);
if (findings > 0) process.exitCode = 1;
