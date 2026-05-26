#!/usr/bin/env node
// DIAGNOSTIC ONLY — not wired into production paths.
// Reads result.json by path, parses against the phase registry, prints the
// parse result. Operator use only.
// NOTE: Originally specified at apps/cli/src/diagnose-result.ts per the issue,
// but apps/cli/ does not exist in this repo. Placed in apps/api/src/ instead.
import { readFileSync } from 'node:fs';
import { PHASE_RESULT_REGISTRY } from '@ai-sdlc/application';

const [, , phase, filePath] = process.argv;
if (!phase || !filePath) {
  console.error('usage: diagnose-result <phase> <path-to-result.json>');
  process.exit(2);
}
if (!Object.hasOwn(PHASE_RESULT_REGISTRY, phase)) {
  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}
const meta = PHASE_RESULT_REGISTRY[phase]!;
const raw = readFileSync(filePath, 'utf-8');
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error('FAIL JSON parse error:', (e as SyntaxError).message);
  process.exit(1);
}
const result = meta.schema.safeParse(parsed);
if (result.success) {
  process.stdout.write('OK ' + JSON.stringify(result.data, null, 2) + '\n');
} else {
  console.error('FAIL', result.error.message);
  process.exit(1);
}
