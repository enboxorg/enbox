/**
 * Strip browser-only modules from the lcov coverage report.
 *
 * These modules (DWeb Connect client, wallet selector, connect/dweb
 * orchestration) require real browser APIs (window.open, postMessage,
 * Shadow DOM) and cannot be meaningfully tested in a Node/bun
 * environment. Coverage for them is enforced via browser integration
 * tests instead.
 *
 * Usage: node scripts/strip-browser-coverage.js
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const LCOV_PATH = 'coverage/lcov.info';

/** Source file prefixes to exclude from coverage. */
const BROWSER_ONLY = [
  'src/dweb-connect-client.ts',
  'src/ui/',
  'src/connect/dweb.ts',
];

if (!existsSync(LCOV_PATH)) {
  process.exit(0);
}

const raw = readFileSync(LCOV_PATH, 'utf8');
let out = '';
let include = true;

for (const line of raw.split('\n')) {
  if (line.startsWith('SF:')) {
    include = !BROWSER_ONLY.some((prefix) => line.includes(prefix));
  }

  if (include) {
    out += line + '\n';
  }

  if (line === 'end_of_record') {
    include = true;
  }
}

writeFileSync(LCOV_PATH, out);
