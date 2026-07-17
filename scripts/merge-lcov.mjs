#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const outputPath = path.join(rootDir, 'coverage/merged/lcov.info');
const patterns = [
  'packages/*/coverage/lcov.info',
  // Suites sharded across CI jobs stage each leg under coverage-shard-N/
  // (e.g. the two-way agent split); each shard covers a subset of the same
  // package, merged here into one report.
  'packages/*/coverage-shard-*/lcov.info',
  'packages/*/coverage-browser/lcov.info',
  'packages/*/coverage-browser-*/lcov.info',
];

const coverageFiles = await collectCoverageFiles();

if (coverageFiles.length === 0) {
  throw new Error('merge-lcov: no LCOV files found under packages/*/coverage*/lcov.info');
}

const mergedCoverage = new Map();

for (const coverageFile of coverageFiles) {
  const contents = await readFile(coverageFile, 'utf8');
  mergeLcovContents(coverageFile, contents, mergedCoverage);
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderLcov(mergedCoverage), 'utf8');

console.log(`Merged ${coverageFiles.length} LCOV files into ${toPosix(path.relative(rootDir, outputPath))}`);

async function collectCoverageFiles() {
  const files = new Set();

  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);

    for await (const match of glob.scan({ cwd: rootDir, absolute: true })) {
      files.add(match);
    }
  }

  return Array.from(files).sort();
}

function mergeLcovContents(coverageFile, contents, mergedCoverage) {
  const coverageDir = path.dirname(coverageFile);
  const packageDir = path.dirname(coverageDir);
  const lines = contents.split(/\r?\n/);
  let currentFile;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith('TN:')) {
      continue;
    }

    if (line.startsWith('SF:')) {
      const sourceFile = line.slice(3);
      const normalizedSourceFile = normalizeSourceFile(packageDir, sourceFile);

      currentFile = mergedCoverage.get(normalizedSourceFile);

      if (currentFile === undefined) {
        currentFile = {
          functions : new Map(),
          branches  : new Map(),
          lines     : new Map(),
        };

        mergedCoverage.set(normalizedSourceFile, currentFile);
      }

      continue;
    }

    if (line === 'end_of_record') {
      currentFile = undefined;
      continue;
    }

    if (currentFile === undefined) {
      continue;
    }

    if (line.startsWith('FN:')) {
      const separatorIndex = line.indexOf(',', 3);
      const lineNumber = Number(line.slice(3, separatorIndex));
      const functionName = line.slice(separatorIndex + 1);
      const functionKey = `${lineNumber}:${functionName}`;
      const existingFunction = currentFile.functions.get(functionKey);

      if (existingFunction === undefined) {
        currentFile.functions.set(functionKey, {
          hits : 0,
          line : lineNumber,
          name : functionName,
        });
      }

      continue;
    }

    if (line.startsWith('FNDA:')) {
      const separatorIndex = line.indexOf(',', 5);
      const hits = Number(line.slice(5, separatorIndex));
      const functionName = line.slice(separatorIndex + 1);

      for (const functionRecord of currentFile.functions.values()) {
        if (functionRecord.name === functionName) {
          functionRecord.hits = Math.max(functionRecord.hits, hits);
        }
      }

      continue;
    }

    if (line.startsWith('DA:')) {
      const [lineNumberValue, hitsValue, checksum] = line.slice(3).split(',');
      const lineNumber = Number(lineNumberValue);
      const hits = Number(hitsValue);
      const existingLine = currentFile.lines.get(lineNumber);

      if (existingLine === undefined) {
        currentFile.lines.set(lineNumber, {
          checksum,
          hits,
        });
      } else {
        existingLine.hits = Math.max(existingLine.hits, hits);

        if (existingLine.checksum === undefined) {
          existingLine.checksum = checksum;
        }
      }

      continue;
    }

    if (line.startsWith('BRDA:')) {
      const [lineNumber, blockNumber, branchNumber, taken] = line.slice(5).split(',');
      const branchKey = `${lineNumber}:${blockNumber}:${branchNumber}`;
      const existingBranch = currentFile.branches.get(branchKey);

      if (existingBranch === undefined) {
        currentFile.branches.set(branchKey, {
          blockNumber,
          branchNumber,
          lineNumber,
          taken,
        });
      } else {
        existingBranch.taken = mergeBranchTaken(existingBranch.taken, taken);
      }
    }
  }
}

function normalizeSourceFile(packageDir, sourceFile) {
  if (path.isAbsolute(sourceFile)) {
    return toPosix(path.relative(rootDir, sourceFile));
  }

  if (
    sourceFile.startsWith('apps/') ||
    sourceFile.startsWith('packages/') ||
    sourceFile.startsWith('testing/')
  ) {
    return toPosix(sourceFile);
  }

  return toPosix(path.relative(rootDir, path.resolve(packageDir, sourceFile)));
}

function mergeBranchTaken(existingTaken, nextTaken) {
  const existingValue = existingTaken === '-' ? undefined : Number(existingTaken);
  const nextValue = nextTaken === '-' ? undefined : Number(nextTaken);

  if (existingValue === undefined && nextValue === undefined) {
    return '-';
  }

  if (existingValue === undefined) {
    return String(nextValue);
  }

  if (nextValue === undefined) {
    return String(existingValue);
  }

  return String(Math.max(existingValue, nextValue));
}

function renderLcov(mergedCoverage) {
  const records = [];
  const sourceFiles = Array.from(mergedCoverage.keys()).sort();

  for (const sourceFile of sourceFiles) {
    const fileCoverage = mergedCoverage.get(sourceFile);
    const functionRecords = Array.from(fileCoverage.functions.values())
      .sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
    const branchRecords = Array.from(fileCoverage.branches.values())
      .sort(compareBranchRecords);
    const lineRecords = Array.from(fileCoverage.lines.entries())
      .sort((left, right) => left[0] - right[0]);

    records.push(`SF:${sourceFile}`);

    for (const functionRecord of functionRecords) {
      records.push(`FN:${functionRecord.line},${functionRecord.name}`);
    }

    for (const functionRecord of functionRecords) {
      records.push(`FNDA:${functionRecord.hits},${functionRecord.name}`);
    }

    records.push(`FNF:${functionRecords.length}`);
    records.push(`FNH:${functionRecords.filter((functionRecord) => functionRecord.hits > 0).length}`);

    for (const branchRecord of branchRecords) {
      records.push(`BRDA:${branchRecord.lineNumber},${branchRecord.blockNumber},${branchRecord.branchNumber},${branchRecord.taken}`);
    }

    records.push(`BRF:${branchRecords.length}`);
    records.push(`BRH:${branchRecords.filter((branchRecord) => branchRecord.taken !== '-' && Number(branchRecord.taken) > 0).length}`);

    for (const [lineNumber, lineRecord] of lineRecords) {
      if (lineRecord.checksum !== undefined && lineRecord.checksum.length > 0) {
        records.push(`DA:${lineNumber},${lineRecord.hits},${lineRecord.checksum}`);
      } else {
        records.push(`DA:${lineNumber},${lineRecord.hits}`);
      }
    }

    records.push(`LF:${lineRecords.length}`);
    records.push(`LH:${lineRecords.filter(([, lineRecord]) => lineRecord.hits > 0).length}`);
    records.push('end_of_record');
  }

  return `${records.join('\n')}\n`;
}

function compareBranchRecords(left, right) {
  return compareNumericStrings(left.lineNumber, right.lineNumber)
    || compareNumericStrings(left.blockNumber, right.blockNumber)
    || compareNumericStrings(left.branchNumber, right.branchNumber);
}

function compareNumericStrings(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);

  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right);
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}
