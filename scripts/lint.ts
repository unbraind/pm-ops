#!/usr/bin/env node
/**
 * Thin pm-ops self-lint launcher over the canonical fleet ESLint export.
 */

import { runLintGate } from "../eslint.ts";

process.exitCode = await runLintGate();
