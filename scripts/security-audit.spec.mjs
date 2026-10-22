import { describe, expect, it } from 'bun:test';

import { assessAudit, parseAudit } from './security-audit.mjs';

const advisory = {
  url                 : 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  title               : 'stack exhaustion',
  severity            : 'high',
  vulnerable_versions : '<=3.0.3',
};
const report = { braces: [advisory] };
const lock = { packages: { braces: ['braces@3.0.3'] } };
const exception = {
  package  : 'braces',
  advisory : 'GHSA-vfj7-8cjw-p6xm',
  versions : ['3.0.3'],
  severity : 'high',
  expires  : '2026-11-21',
  reason   : 'Tooling only; no published fix.',
};
const now = new Date('2026-10-22T00:00:00Z');

describe('security audit gate', () => {
  it('accepts a clean registry response and valid advisory exit code', () => {
    expect(parseAudit('{}', '', 0)).toEqual({});
    expect(parseAudit(JSON.stringify(report), '', 1)).toEqual(report);
  });

  it('fails closed on command errors, malformed responses, and skipped registries', () => {
    for (const [stdout, stderr, code] of [
      ['{}', '', 1], ['{}', 'error: network unavailable', 0], ['{}', 'Skipped private packages', 0],
      ['<html>proxy error</html>', '', 1], ['[]', '', 0], ['null', '', 0],
      ['{"error":"registry unavailable"}', '', 1], ['{"braces":[]}', '', 1],
      [JSON.stringify(report), '', 0], [JSON.stringify({ braces: [{ ...advisory, severity: 'unknown' }] }), '', 1],
    ]) {
      expect(() => parseAudit(stdout, stderr, code)).toThrow();
    }
  });

  it('accepts only the reviewed tooling advisory and locked version', () => {
    expect(assessAudit(report, {}, lock, [exception], now)).toEqual([]);
    expect(assessAudit(report, {}, lock, [], now)).toHaveLength(1);
    expect(() => assessAudit(report, {}, { packages: { braces: ['braces@3.0.4'] } }, [exception], now)).toThrow();
  });

  it('blocks new advisories, severity escalation, and production exposure', () => {
    const additional = { ...advisory, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' };
    expect(assessAudit({ braces: [advisory, additional] }, {}, lock, [exception], now)).toHaveLength(1);
    expect(assessAudit({ braces: [{ ...advisory, severity: 'critical' }] }, {}, lock, [exception], now).length).toBeGreaterThan(0);
    expect(assessAudit(report, report, lock, [exception], now)).toHaveLength(1);
  });

  it('requires expired, duplicate, malformed, and unused exceptions to be resolved', () => {
    expect(() => assessAudit(report, {}, lock, [exception], new Date('2026-11-21T00:00:00Z'))).toThrow();
    expect(() => assessAudit(report, {}, lock, [exception, exception], now)).toThrow();
    expect(() => assessAudit(report, {}, lock, [{ ...exception, expires: 'invalid' }], now)).toThrow();
    expect(assessAudit({}, {}, lock, [exception], now)).toHaveLength(1);
  });
});
