#!/usr/bin/env bun
/**
 * Diff-coverage gate: enforces minimum coverage on lines changed in a PR.
 *
 * Reads the merged LCOV report and cross-references it with `git diff` to
 * compute coverage on only the lines that were added or modified. This is
 * the industry-standard approach (similar to Codecov's "patch coverage" or
 * SonarCloud's "new code" period).
 *
 * Environment:
 *   DIFF_COVERAGE_THRESHOLD — minimum % coverage on changed lines (default: 80)
 *
 * Exit codes:
 *   0 — coverage meets threshold (or no changed source lines found)
 *   1 — coverage below threshold
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const THRESHOLD = Number(process.env.DIFF_COVERAGE_THRESHOLD ?? 80);
const LCOV_PATH = resolve('coverage/merged/lcov.info');

// ---------------------------------------------------------------------------
// 1. Parse merged LCOV into a map of file → Set<coveredLineNumbers>
//    and file → Set<instrumentedLineNumbers>
// ---------------------------------------------------------------------------

/**
 * @param {string} lcovContent
 * @returns {Map<string, { instrumented: Set<number>, covered: Set<number> }>}
 */
function parseLcov(lcovContent) {
  /** @type {Map<string, { instrumented: Set<number>, covered: Set<number> }>} */
  const files = new Map();
  let currentFile = null;

  for (const line of lcovContent.split('\n')) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3).trim();
      if (!files.has(currentFile)) {
        files.set(currentFile, { instrumented: new Set(), covered: new Set() });
      }
    } else if (line.startsWith('DA:') && currentFile) {
      const parts = line.slice(3).split(',');
      const lineNum = Number(parts[0]);
      const hitCount = Number(parts[1]);
      const entry = files.get(currentFile);
      entry.instrumented.add(lineNum);
      if (hitCount > 0) {
        entry.covered.add(lineNum);
      }
    } else if (line === 'end_of_record') {
      currentFile = null;
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// 2. Get changed lines from git diff
// ---------------------------------------------------------------------------

/**
 * Returns a map of file path → Set<line numbers> that were added/modified.
 * @returns {Map<string, Set<number>>}
 */
function getChangedLines() {
  /** @type {Map<string, Set<number>>} */
  const changedLines = new Map();

  // Get the unified diff against the merge base
  let diff;
  try {
    diff = execSync(
      'git diff origin/main...HEAD --unified=0 -- "packages/*/src/**/*.ts" ":!*.spec.ts" ":!*.test.ts" ":!*.d.ts"',
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
  } catch {
    // If origin/main doesn't exist (e.g. shallow clone), try HEAD~1
    try {
      diff = execSync(
        'git diff HEAD~1...HEAD --unified=0 -- "packages/*/src/**/*.ts" ":!*.spec.ts" ":!*.test.ts" ":!*.d.ts"',
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
      );
    } catch {
      console.log('Could not compute git diff — skipping diff-coverage check');
      return changedLines;
    }
  }

  let currentFile = null;

  for (const line of diff.split('\n')) {
    // +++ b/packages/common/src/foo.ts
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      if (!changedLines.has(currentFile)) {
        changedLines.set(currentFile, new Set());
      }
    }
    // @@ -old,count +new,count @@
    else if (line.startsWith('@@') && currentFile) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      if (match) {
        const start = Number(match[1]);
        const count = match[2] !== undefined ? Number(match[2]) : 1;
        const lines = changedLines.get(currentFile);
        for (let i = start; i < start + count; i++) {
          lines.add(i);
        }
      }
    }
  }

  return changedLines;
}

// ---------------------------------------------------------------------------
// 3. Cross-reference and compute diff-coverage
// ---------------------------------------------------------------------------

function main() {
  if (!existsSync(LCOV_PATH)) {
    console.log(`No LCOV file at ${LCOV_PATH} — skipping diff-coverage check`);
    process.exit(0);
  }

  const lcovContent = readFileSync(LCOV_PATH, 'utf8');
  const lcovData = parseLcov(lcovContent);
  const changedLines = getChangedLines();

  if (changedLines.size === 0) {
    console.log('No changed source files found — diff-coverage check passes');
    process.exit(0);
  }

  let totalChanged = 0;
  let totalCovered = 0;
  const fileResults = [];

  for (const [filePath, lines] of changedLines) {
    // LCOV paths may be relative to the package dir — try multiple resolutions
    let lcovEntry = lcovData.get(filePath);

    if (!lcovEntry) {
      // Try matching by suffix: LCOV may use paths like "src/foo.ts" while
      // git diff uses "packages/common/src/foo.ts"
      for (const [lcovPath, entry] of lcovData) {
        if (filePath.endsWith(lcovPath) || lcovPath.endsWith(filePath)) {
          lcovEntry = entry;
          break;
        }
        // Also try: packages/common/src/foo.ts matches src/foo.ts
        const relFromPackage = filePath.replace(/^packages\/[^/]+\//, '');
        if (lcovPath === relFromPackage || lcovPath.endsWith('/' + relFromPackage)) {
          lcovEntry = entry;
          break;
        }
      }
    }

    if (!lcovEntry) {
      // File not in coverage data — might be a new file with no tests
      const count = lines.size;
      totalChanged += count;
      fileResults.push({ file: filePath, changed: count, covered: 0, pct: 0 });
      continue;
    }

    // Only count lines that are both changed AND instrumented
    let fileChanged = 0;
    let fileCovered = 0;
    const uncoveredLines = [];

    for (const lineNum of lines) {
      if (lcovEntry.instrumented.has(lineNum)) {
        fileChanged++;
        if (lcovEntry.covered.has(lineNum)) {
          fileCovered++;
        } else {
          uncoveredLines.push(lineNum);
        }
      }
    }

    if (fileChanged > 0) {
      totalChanged += fileChanged;
      totalCovered += fileCovered;
      const pct = Math.round((fileCovered / fileChanged) * 1000) / 10;
      fileResults.push({
        file: filePath,
        changed: fileChanged,
        covered: fileCovered,
        pct,
        uncoveredLines: uncoveredLines.slice(0, 10), // Show first 10
      });
    }
  }

  // Print results
  console.log('\n=== Diff-Coverage Report ===\n');

  if (totalChanged === 0) {
    console.log('No instrumented changed lines found — diff-coverage check passes');
    process.exit(0);
  }

  const overallPct = Math.round((totalCovered / totalChanged) * 1000) / 10;

  // Sort by coverage ascending (worst first)
  fileResults.sort((a, b) => a.pct - b.pct);

  console.log(`${'File'.padEnd(60)} ${'Changed'.padStart(8)} ${'Covered'.padStart(8)} ${'%'.padStart(7)}`);
  console.log('-'.repeat(85));

  for (const r of fileResults) {
    const shortFile = r.file.length > 58 ? '...' + r.file.slice(-55) : r.file;
    const marker = r.pct < THRESHOLD ? ' <--' : '';
    console.log(`${shortFile.padEnd(60)} ${String(r.changed).padStart(8)} ${String(r.covered).padStart(8)} ${(r.pct + '%').padStart(7)}${marker}`);

    if (r.uncoveredLines && r.uncoveredLines.length > 0) {
      const lineStr = r.uncoveredLines.join(', ');
      const suffix = r.uncoveredLines.length < (r.changed - r.covered) ? ', ...' : '';
      console.log(`${''.padEnd(60)}   uncovered: L${lineStr}${suffix}`);
    }
  }

  console.log('-'.repeat(85));
  console.log(`${'TOTAL'.padEnd(60)} ${String(totalChanged).padStart(8)} ${String(totalCovered).padStart(8)} ${(overallPct + '%').padStart(7)}`);
  console.log(`\nThreshold: ${THRESHOLD}%`);

  if (overallPct < THRESHOLD) {
    console.log(`\n::error::Diff-coverage ${overallPct}% is below the ${THRESHOLD}% threshold. Add tests for uncovered changed lines.`);
    process.exit(1);
  } else {
    console.log(`\nDiff-coverage ${overallPct}% meets the ${THRESHOLD}% threshold.`);
    process.exit(0);
  }
}

main();
