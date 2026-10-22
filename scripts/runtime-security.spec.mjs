import { describe, expect, it } from 'bun:test';
import { checkServerIdentity } from 'node:tls';

describe('TLS hostname verification (CVE-2026-48618)', () => {
  const certificate = { subject: { CN: '*.example.com' }, subjectaltname: 'DNS:*.example.com' };

  it('accepts the matching single-label wildcard hostname', () => {
    expect(checkServerIdentity('first.example.com', certificate)).toBeUndefined();
  });

  it('rejects additional labels, including Unicode dot variants', () => {
    for (const separator of ['.', '\u3002', '\uff0e', '\uff61']) {
      const error = checkServerIdentity(`first${separator}second.example.com`, certificate);
      expect(error?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    }
  });
});
