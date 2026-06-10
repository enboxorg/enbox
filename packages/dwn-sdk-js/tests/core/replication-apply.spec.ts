import { describe, expect, it } from 'bun:test';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { DwnErrorCode, replicationApplyResultFromReply } from '../../src/index.js';

describe('replicationApplyResultFromReply', () => {
  it('classifies successful and idempotent replies', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite();

    expect(replicationApplyResultFromReply(message, { status: { code: 202 } }))
      .toEqual({ kind: 'Applied' });
    expect(replicationApplyResultFromReply(message, { status: { code: 204 } }))
      .toEqual({ kind: 'Applied' });
    expect(replicationApplyResultFromReply(message, { status: { code: 409 } }))
      .toEqual({ kind: 'Superseded' });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.RecordsWriteNotAllowedAfterDelete}: record is deleted`,
      },
    })).toEqual({ kind: 'Superseded' });
  });

  it('classifies missing initial writes as retryable dependencies', async () => {
    const protocol = 'https://example.com/protocol';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.RecordsWriteGetInitialWriteNotFound}: Initial write is not found.`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'InitialWrite', recordId: message.recordId, protocol }],
    });
  });

  it('classifies protocol and parent misses from status detail', async () => {
    const protocol = 'https://example.com/protocol';
    const composedProtocol = 'https://example.com/composed';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolAuthorizationProtocolNotFound}: protocol is not installed`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Protocol', protocol }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled}: composed protocol '${composedProtocol}' is not installed`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Protocol', protocol: composedProtocol }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentRecordNotFound}: parent record 'parent-record' in protocol '${protocol}' was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Parent', recordId: 'parent-record', protocol }],
    });
  });

  it('classifies parent-chain misses with the incoming protocol', async () => {
    const protocol = 'https://example.com/protocol';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain}: parent with ID parent-record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Ancestor', recordId: 'parent-record', protocol }],
    });
  });

  it('classifies grant, record data, and delete initial-write dependencies', async () => {
    const protocol = 'https://example.com/protocol';
    const permissionGrantId = 'grant-1';
    const dataCid = 'bafyreib3xmaq5x6o6lhn5jvcnv6hvgh7e64xw66z3c3rgyk7wwq7qv2b5a';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      dataCid,
      dataSize: 42,
      permissionGrantId,
      protocol,
    });
    const deleteMessage = await TestDataGenerator.generateRecordsDelete({ recordId: 'deleted-record' });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.GrantAuthorizationGrantMissing}: grant was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Grant', permissionGrantId }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.RecordsWriteMissingDataInPrevious}: data is missing`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'RecordData', recordId: message.recordId, dataCid, protocol }],
    });
    expect(replicationApplyResultFromReply(deleteMessage.message, {
      status: { code: 404 },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'InitialWrite', recordId: 'deleted-record' }],
    });
  });

  it('classifies missing role records from the signed authorization payload', async () => {
    const protocol = 'https://example.com/protocol';
    const protocolRole = 'member';
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath: 'chat/message',
      protocolRole,
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type         : 'Role',
        protocol,
        protocolPath : protocolRole,
        recipient    : author.did,
      }],
    });
  });

  it('includes context prefixes for nested role dependencies', async () => {
    const protocol = 'https://example.com/protocol';
    const protocolRole = 'thread/member';
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath: 'thread/message',
      protocolRole,
    });
    (message.descriptor as Record<string, unknown>).contextId = 'thread-context/member-context';

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'thread-context',
        protocol,
        protocolPath  : protocolRole,
        recipient     : author.did,
      }],
    });
  });

  it('classifies resolver and storage failures as deferred', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite();

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound}: unable to resolve DID`,
      },
    })).toEqual({ kind: 'Deferred', reason: 'resolver-unavailable' });
    expect(replicationApplyResultFromReply(message, {
      status: { code: 500, detail: 'storage unavailable' },
    })).toEqual({ kind: 'Deferred', reason: 'storage' });
  });

  it('classifies unmatched client errors as invalid', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite();

    expect(replicationApplyResultFromReply(message, {
      status: { code: 400 },
    })).toEqual({ kind: 'Invalid', reason: 'replicated message rejected with status 400' });
  });
});
