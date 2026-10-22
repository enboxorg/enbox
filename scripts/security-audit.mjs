#!/usr/bin/env bun

import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const severities = new Set(['low', 'moderate', 'high', 'critical']);

/** Reject incomplete registry responses and distinguish audit findings from CLI failures. */
export function parseAudit(stdout, stderr, exitCode) {
  const report = JSON.parse(stdout);
  if (report === null || Array.isArray(report) || typeof report !== 'object') {
    throw new Error('audit: expected a package advisory map');
  }
  for (const [name, advisories] of Object.entries(report)) {
    if (!name || !Array.isArray(advisories) || advisories.length === 0) {
      throw new Error('audit: invalid package advisory list');
    }
    for (const advisory of advisories) {
      if (!advisory || !/^https:\/\/github\.com\/advisories\/GHSA-[\da-z-]+$/.test(advisory.url)
        || !severities.has(advisory.severity) || typeof advisory.title !== 'string'
        || typeof advisory.vulnerable_versions !== 'string') {
        throw new Error(`audit: invalid advisory for ${name}`);
      }
    }
  }
  const expectedExit = Object.keys(report).length === 0 ? 0 : 1;
  if (exitCode !== expectedExit || /skipped|error:|failed/i.test(stderr)) {
    throw new Error(`audit: registry query failed or skipped packages (exit ${exitCode}): ${stderr}`);
  }
  return report;
}

/** Every advisory blocks CI, including development-only dependencies. */
export function assessAudit(report) {
  return Object.entries(report).flatMap(([name, advisories]) =>
    advisories.map(advisory => `${name}: ${advisory.severity} ${advisory.url}`));
}

async function queryAudit() {
  const child = Bun.spawn([process.execPath, 'audit', '--json'], {
    cwd    : root,
    stdout : 'pipe',
    stderr : 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return parseAudit(stdout, stderr, exitCode);
}

if (import.meta.main) {
  const report = await queryAudit();
  const failures = assessAudit(report);
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Security audit passed; no advisories in production or development dependencies.');
  }
}
