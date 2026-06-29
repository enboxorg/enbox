import { describe, expect, it } from 'bun:test';

import { DwnRpcError } from '../src/index.js';
import { parseReplicationApplyResult } from '../src/replication-apply-result.js';

describe('parseReplicationApplyResult', () => {
  it('should accept encryption protocol dependency paths', () => {
    for (const protocolPath of ['audienceEpoch', 'audienceKey', 'grantKey']) {
      const result = parseReplicationApplyResult({
        kind    : 'Incomplete',
        missing : [{
          type : 'EncryptionProtocol',
          protocolPath,
          tags : { protocol: 'https://example.com/protocol' },
        }],
      });

      expect(result).toEqual({
        kind    : 'Incomplete',
        missing : [{
          type : 'EncryptionProtocol',
          protocolPath,
          tags : { protocol: 'https://example.com/protocol' },
        }],
      });
    }
  });

  it('should reject unknown encryption protocol dependency paths', () => {
    expect(() => parseReplicationApplyResult({
      kind    : 'Incomplete',
      missing : [{
        type         : 'EncryptionProtocol',
        protocolPath : 'unknownPath',
      }],
    })).toThrow(DwnRpcError);
  });
});
