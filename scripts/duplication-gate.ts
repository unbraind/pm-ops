#!/usr/bin/env node
/**
 * Thin pm-ops self-duplication launcher over the canonical gate export.
 */

import { runDuplicationGate } from "../duplication.ts";

await runDuplicationGate();
