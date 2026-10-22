import { describe, expect, it } from 'bun:test';

import { assessAudit, parseAudit } from './security-audit.mjs';

const advisory = {
  url                 : 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  title               : 'stack exhaustion',
  severity            : 'high',
  vulnerable_versions : '<=3.0.3',
};
const report = { braces: [advisory] };

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

  it('blocks every advisory regardless of severity or dependency scope', () => {
    const severities = ['low', 'moderate', 'high', 'critical'];
    const findings = assessAudit({
      braces       : severities.map(severity => ({ ...advisory, severity })),
      'sprintf-js' : [{ ...advisory, url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c' }],
    });
    expect(findings).toHaveLength(5);
    for (const severity of severities) {
      expect(findings.some(finding => finding.includes(`braces: ${severity} `))).toBe(true);
    }
    expect(findings.some(finding => finding.includes('sprintf-js: high '))).toBe(true);
  });

  it('passes only when the complete audit is empty', () => {
    expect(assessAudit({})).toEqual([]);
    expect(assessAudit(report)).toHaveLength(1);
  });
});
