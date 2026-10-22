#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
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

/** Exceptions apply only to the full tooling audit; production findings always fail. */
export function assessAudit(report, productionReport, lock, exceptions, now = new Date()) {
  if (!Array.isArray(exceptions) || !lock.packages) {
    throw new Error('audit: invalid exception policy or lockfile');
  }
  const accepted = new Map();
  for (const exception of exceptions) {
    const { package: name, advisory, versions, severity, expires, reason } = exception;
    const key = `${name}:${advisory}`;
    const expiry = Date.parse(`${expires}T00:00:00Z`);
    if (!name || !/^GHSA-[\da-z-]+$/.test(advisory) || !severities.has(severity)
      || !Array.isArray(versions) || versions.length === 0 || versions.some(version => typeof version !== 'string')
      || typeof reason !== 'string' || !reason.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(expires)
      || !Number.isFinite(expiry) || expiry <= now.getTime() || accepted.has(key)) {
      throw new Error(`audit: invalid, duplicate, or expired exception ${key}`);
    }
    const lockedVersions = Object.values(lock.packages)
      .map(entry => entry[0]).filter(identity => identity.startsWith(`${name}@`))
      .map(identity => identity.slice(name.length + 1));
    if (lockedVersions.length === 0 || lockedVersions.some(version => !versions.includes(version))) {
      throw new Error(`audit: exception ${key} does not cover the locked versions`);
    }
    accepted.set(key, exception);
  }

  const failures = [];
  const used = new Set();
  for (const [name, advisories] of Object.entries(report)) {
    for (const advisory of advisories) {
      const id = advisory.url.split('/').pop();
      const key = `${name}:${id}`;
      const exception = accepted.get(key);
      if (exception && exception.severity === advisory.severity) {
        used.add(key);
        console.log(`Accepted until ${exception.expires}: ${key} — ${exception.reason}`);
      } else {
        failures.push(`${name}: ${advisory.severity} ${advisory.url}`);
      }
    }
  }
  for (const [name, advisories] of Object.entries(productionReport)) {
    for (const advisory of advisories) {
      failures.push(`Production dependency ${name}: ${advisory.severity} ${advisory.url}`);
    }
  }
  for (const key of accepted.keys()) {
    if (!used.has(key)) {
      failures.push(`Remove unused exception ${key}`);
    }
  }
  return failures;
}

async function queryAudit(production) {
  const child = Bun.spawn([process.execPath, 'audit', '--json', ...(production ? ['--prod'] : [])], {
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
  const lock = Bun.JSONC.parse(await readFile(new URL('../bun.lock', import.meta.url), 'utf8'));
  const exceptions = JSON.parse(await readFile(new URL('../.github/security-audit-exceptions.json', import.meta.url), 'utf8'));
  const report = await queryAudit(false);
  const productionReport = await queryAudit(true);
  const failures = assessAudit(report, productionReport, lock, exceptions);
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Security audit passed; no production advisories or unaccepted tooling advisories.');
  }
}
