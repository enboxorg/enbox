import type { ProtocolDefinition, RecordsWriteMessage, ValidationStateReader } from '../../src/index.js';

import { describe, expect, it } from 'bun:test';

import { findMissingRoleAudienceEncryptionContext } from '../../src/core/protocol-authorization-validation.js';
import { ProtocolAction } from '../../src/types/protocols-types.js';
import { ROLE_AUDIENCE_DERIVATION_SCHEME } from '../../src/index.js';

const tenant = 'did:example:tenant';
const protocol = 'https://example.com/chat';
const messageTimestamp = '2026-01-01T00:00:00.000000Z';

describe('findMissingRoleAudienceEncryptionContext', () => {
  it('returns undefined when the message has no keyEncryption entries', async () => {
    const reader = makeValidationStateReader({
      fetchProtocolDefinition: async (): Promise<ProtocolDefinition> => {
        throw new Error('fetchProtocolDefinition should not be called');
      },
    });

    const result = await findMissingRoleAudienceEncryptionContext(tenant, makeMessage(), reader);

    expect(result).toBeUndefined();
  });

  it('returns the source role path whose carried audience entry has no accepted audience record', async () => {
    const queries: unknown[] = [];
    const reader = makeValidationStateReader({
      queryAudienceRecords: async (input): Promise<RecordsWriteMessage[]> => {
        queries.push(input);
        return [];
      },
    });

    const result = await findMissingRoleAudienceEncryptionContext(tenant, makeMessage({
      keyEncryption: [
        {
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          protocol,
          rolePath         : 'thread/member',
          keyId            : 'member-key',
        },
      ],
    }), reader);

    expect(result).toEqual({ rolePath: 'thread/member' });
    expect(queries).toEqual([{
      tenant,
      protocol,
      rolePath  : 'thread/member',
      contextId : 'thread-record',
      keyId     : 'member-key',
    }]);
  });

  it('returns the legacy role path whose carried epoch entry has no accepted epoch record', async () => {
    const queries: unknown[] = [];
    const reader = makeValidationStateReader({
      queryAudienceEpochs: async (input): Promise<RecordsWriteMessage[]> => {
        queries.push(input);
        return [];
      },
    });

    const result = await findMissingRoleAudienceEncryptionContext(tenant, makeMessage({
      keyEncryption: [
        {
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          protocol,
          role             : 'thread/member',
          epoch            : 1,
          keyId            : 'member-key',
        },
      ],
    }), reader);

    expect(result).toEqual({ rolePath: 'thread/member' });
    expect(queries).toEqual([{
      tenant,
      protocol,
      contextId : 'thread-record',
      role      : 'thread/member',
      epoch     : 1,
      keyId     : 'member-key',
    }]);
  });

  it('skips accepted audiences and returns the next missing role audience', async () => {
    const reader = makeValidationStateReader({
      queryAudienceRecords: async (input): Promise<RecordsWriteMessage[]> => {
        return input.keyId === 'member-key'
          ? [{} as RecordsWriteMessage]
          : [];
      },
    });

    const result = await findMissingRoleAudienceEncryptionContext(tenant, makeMessage({
      keyEncryption: [
        {
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          protocol,
          rolePath         : 'thread/member',
          keyId            : 'member-key',
        },
        {
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          protocol,
          rolePath         : 'thread/admin',
          keyId            : 'admin-key',
        },
      ],
    }), reader);

    expect(result).toEqual({ rolePath: 'thread/admin' });
  });
});

type ReaderOverrides = {
  fetchProtocolDefinition?: ValidationStateReader['fetchProtocolDefinition'];
  queryAudienceEpochs?: ValidationStateReader['queryAudienceEpochs'];
  queryAudienceRecords?: ValidationStateReader['queryAudienceRecords'];
};

function makeValidationStateReader(overrides: ReaderOverrides = {}): ValidationStateReader {
  return {
    fetchProtocolDefinition : overrides.fetchProtocolDefinition ?? (async (): Promise<ProtocolDefinition> => protocolDefinition),
    queryAudienceEpochs     : overrides.queryAudienceEpochs ?? (async (): Promise<RecordsWriteMessage[]> => []),
    queryAudienceRecords    : overrides.queryAudienceRecords ?? (async (): Promise<RecordsWriteMessage[]> => []),
  } as ValidationStateReader;
}

function makeMessage(options: { keyEncryption?: Record<string, unknown>[] } = {}): RecordsWriteMessage {
  return {
    contextId  : 'thread-record/message-record',
    descriptor : {
      protocol         : protocol,
      protocolPath     : 'thread/message',
      messageTimestamp : messageTimestamp,
    },
    encryption: options.keyEncryption === undefined
      ? undefined
      : { keyEncryption: options.keyEncryption },
  } as RecordsWriteMessage;
}

const protocolDefinition: ProtocolDefinition = {
  published : true,
  protocol,
  types     : {
    thread  : { schema: 'https://example.com/thread', dataFormats: ['application/json'] },
    message : { schema: 'https://example.com/message', dataFormats: ['application/json'] },
    member  : { schema: 'https://example.com/member', dataFormats: ['application/json'] },
    admin   : { schema: 'https://example.com/admin', dataFormats: ['application/json'] },
  },
  structure: {
    thread: {
      member  : { $role: true },
      admin   : { $role: true },
      message : {
        $actions: [
          { role: 'thread/member', can: [ProtocolAction.Read] },
          { role: 'thread/admin', can: [ProtocolAction.Read] },
        ],
      },
    },
  },
};
