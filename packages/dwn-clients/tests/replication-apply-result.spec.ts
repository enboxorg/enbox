import { describe, expect, it } from 'bun:test';

import { DwnRpcError } from '../src/index.js';
import { parseReplicationApplyResult } from '../src/replication-apply-result.js';

describe('parseReplicationApplyResult', () => {
  it.each(['record-data-unavailable', 'resolver-unavailable', 'storage', 'tenant-inactive'])(
    'preserves the Deferred reason %s',
    (reason) => {
      expect(parseReplicationApplyResult({ kind: 'Deferred', reason }))
        .toEqual({ kind: 'Deferred', reason });
    },
  );

  it('preserves only a confirmed materialized duplicate', () => {
    expect(parseReplicationApplyResult({ kind: 'Duplicate' })).toEqual({ kind: 'Duplicate' });
    expect(parseReplicationApplyResult({ kind: 'Duplicate', materialized: true }))
      .toEqual({ kind: 'Duplicate', materialized: true });
  });

  it('rejects an invalid duplicate materialization confirmation', () => {
    for (const materialized of [false, 'true', 1]) {
      expect(() => parseReplicationApplyResult({ kind: 'Duplicate', materialized }))
        .toThrow('Duplicate result materialized must be true when present');
    }
  });

  it('preserves only confirmed materialized supersession', () => {
    expect(parseReplicationApplyResult({ kind: 'Superseded' })).toEqual({ kind: 'Superseded' });
    expect(parseReplicationApplyResult({ kind: 'Superseded', currentWriteMaterialized: true }))
      .toEqual({ kind: 'Superseded', currentWriteMaterialized: true });
    for (const currentWriteMaterialized of [false, 'true', 1]) {
      expect(() => parseReplicationApplyResult({ kind: 'Superseded', currentWriteMaterialized }))
        .toThrow('Superseded result currentWriteMaterialized must be true when present');
    }
  });

  it('should accept encryption control dependency refs for both reserved paths', () => {
    for (const modulePath of ['$encryption/audience', '$encryption/delivery']) {
      const result = parseReplicationApplyResult({
        kind    : 'Incomplete',
        missing : [{
          type   : 'EncryptionControl',
          module : 'https://example.com/module',
          modulePath,
          tags   : { role: 'thread/participant' },
        }],
      });

      expect(result).toEqual({
        kind    : 'Incomplete',
        missing : [{
          type   : 'EncryptionControl',
          module : 'https://example.com/module',
          modulePath,
          tags   : { role: 'thread/participant' },
        }],
      });
    }
  });

  it('should accept encryption control dependency refs with an optional recipient', () => {
    const result = parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{
        type       : 'EncryptionControl',
        module     : 'https://example.com/module',
        modulePath : '$encryption/delivery',
        recipient  : 'did:example:alice',
      }],
    });

    expect(result.kind).toBe('Incomplete');
  });

  it('should reject encryption control dependency refs missing a module', () => {
    expect(() => parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{
        type       : 'EncryptionControl',
        modulePath : '$encryption/audience',
      }],
    })).toThrow(DwnRpcError);
  });

  it('should reject encryption control dependency refs with unknown paths', () => {
    for (const modulePath of ['grantKey', '$encryption', '$encryption/unknown', 42]) {
      expect(() => parseReplicationApplyResult({
        kind    : 'Incomplete',
        missing : [{
          type   : 'EncryptionControl',
          module : 'https://example.com/module',
          modulePath,
        }],
      })).toThrow(DwnRpcError);
    }
  });

  it('should reject removed encryption module dependency refs', () => {
    expect(() => parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{
        type       : 'EncryptionModule',
        modulePath : 'grantKey',
      }],
    })).toThrow(DwnRpcError);
  });

  it.each(['Parent', 'Ancestor'])('accepts a canonical foreign %s dependency', (type) => {
    const result = {
      kind    : 'Incomplete',
      missing : [{ type, module: 'https://example.com/provider', recordId: 'foreign-record' }],
    };
    expect(parseReplicationApplyResult(result)).toEqual(result);
  });

  it('rejects the retired cross-module dependency discriminator', () => {
    expect(() => parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{ type: 'CrossModuleRef', module: 'https://example.com/provider', recordId: 'foreign-record' }],
    })).toThrow(DwnRpcError);
  });
});
