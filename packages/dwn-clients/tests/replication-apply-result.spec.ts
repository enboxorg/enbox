import { describe, expect, it } from 'bun:test';

import { DwnRpcError } from '../src/index.js';
import { parseReplicationApplyResult } from '../src/replication-apply-result.js';

describe('parseReplicationApplyResult', () => {
  it('preserves only a proven materialized duplicate', () => {
    expect(parseReplicationApplyResult({ kind: 'Duplicate' })).toEqual({ kind: 'Duplicate' });
    expect(parseReplicationApplyResult({ kind: 'Duplicate', materialized: true }))
      .toEqual({ kind: 'Duplicate', materialized: true });
  });

  it('rejects an invalid duplicate materialization proof', () => {
    for (const materialized of [false, 'true', 1]) {
      expect(() => parseReplicationApplyResult({ kind: 'Duplicate', materialized }))
        .toThrow('Duplicate result materialized must be true when present');
    }
  });

  it('should accept encryption control dependency refs for both reserved paths', () => {
    for (const protocolPath of ['$encryption/audience', '$encryption/delivery']) {
      const result = parseReplicationApplyResult({
        kind    : 'Incomplete',
        missing : [{
          type     : 'EncryptionControl',
          protocol : 'https://example.com/protocol',
          protocolPath,
          tags     : { role: 'thread/participant' },
        }],
      });

      expect(result).toEqual({
        kind    : 'Incomplete',
        missing : [{
          type     : 'EncryptionControl',
          protocol : 'https://example.com/protocol',
          protocolPath,
          tags     : { role: 'thread/participant' },
        }],
      });
    }
  });

  it('should accept encryption control dependency refs with an optional recipient', () => {
    const result = parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{
        type         : 'EncryptionControl',
        protocol     : 'https://example.com/protocol',
        protocolPath : '$encryption/delivery',
        recipient    : 'did:example:alice',
      }],
    });

    expect(result.kind).toBe('Incomplete');
  });

  it('should reject encryption control dependency refs missing a protocol', () => {
    expect(() => parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{
        type         : 'EncryptionControl',
        protocolPath : '$encryption/audience',
      }],
    })).toThrow(DwnRpcError);
  });

  it('should reject encryption control dependency refs with unknown paths', () => {
    for (const protocolPath of ['grantKey', '$encryption', '$encryption/unknown', 42]) {
      expect(() => parseReplicationApplyResult({
        kind    : 'Incomplete',
        missing : [{
          type     : 'EncryptionControl',
          protocol : 'https://example.com/protocol',
          protocolPath,
        }],
      })).toThrow(DwnRpcError);
    }
  });

  it('should reject removed encryption protocol dependency refs', () => {
    expect(() => parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{
        type         : 'EncryptionProtocol',
        protocolPath : 'grantKey',
      }],
    })).toThrow(DwnRpcError);
  });
});
