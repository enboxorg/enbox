import type { GenericMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';
import {
  DwnInterfaceName,
  DwnMethodName,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  EncryptionProtocol,
  PermissionsProtocol,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { orderMessagesForAdmission } from '../src/sync-admission-order.js';

type SortEntry = { message: GenericMessage };

function makeMessage(overrides: Record<string, unknown> = {}): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Write,
      messageTimestamp : '2024-01-01T00:00:00.000000Z',
      ...overrides,
    },
  } as unknown as GenericMessage;
}

function makeAuthorizedMessage(
  descriptorOverrides: Record<string, unknown>,
  signaturePayload: Record<string, unknown>,
  author = 'did:example:alice',
): GenericMessage {
  const payload = Buffer.from(JSON.stringify(signaturePayload)).toString('base64url');
  const protectedHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: `${author}#key-1` })).toString('base64url');
  return {
    ...makeMessage(descriptorOverrides),
    authorization: {
      signature: {
        payload,
        signatures: [{ protected: protectedHeader, signature: 'fake' }],
      },
    },
  } as unknown as GenericMessage;
}

describe('orderMessagesForAdmission', () => {
  it('should return empty array for empty input', () => {
    const result = orderMessagesForAdmission([]);
    expect(result).toEqual([]);
  });

  it('should return single-element array unchanged', () => {
    const msg: SortEntry = { message: makeMessage() };
    const result = orderMessagesForAdmission([msg]);
    expect(result).toEqual([msg]);
  });

  it('should place ProtocolsConfigure before RecordsWrite that references the protocol', () => {
    const configureMsg: SortEntry = {
      message: makeMessage({
        interface  : DwnInterfaceName.Protocols,
        method     : DwnMethodName.Configure,
        definition : { protocol: 'https://example.com/protocol' },
      }),
    };
    const recordsWriteMsg: SortEntry = {
      message: {
        ...makeMessage({
          protocol    : 'https://example.com/protocol',
          dateCreated : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'rec-1',
      } as unknown as GenericMessage,
    };

    // Input order: records first, protocol second — sort should reverse.
    const result = orderMessagesForAdmission([recordsWriteMsg, configureMsg]);
    expect(result[0]).toBe(configureMsg);
    expect(result[1]).toBe(recordsWriteMsg);
  });

  it('should place ProtocolsConfigure uses targets before composed ProtocolsConfigure and records', () => {
    const socialProtocol = 'https://identity.foundation/protocols/social-graph';
    const profileProtocol = 'https://identity.foundation/protocols/profile';

    const socialConfigure: SortEntry = {
      message: makeMessage({
        interface  : DwnInterfaceName.Protocols,
        method     : DwnMethodName.Configure,
        definition : { protocol: socialProtocol },
      }),
    };
    const profileConfigure: SortEntry = {
      message: makeMessage({
        interface  : DwnInterfaceName.Protocols,
        method     : DwnMethodName.Configure,
        definition : {
          protocol : profileProtocol,
          uses     : { social: socialProtocol },
        },
      }),
    };
    const profileRecord: SortEntry = {
      message: {
        ...makeMessage({
          protocol         : profileProtocol,
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'profile-rec',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([profileRecord, profileConfigure, socialConfigure]);
    expect(result[0]).toBe(socialConfigure);
    expect(result[1]).toBe(profileConfigure);
    expect(result[2]).toBe(profileRecord);
  });

  it('should place initial write before update write for same recordId', () => {
    const initialWrite: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'rec-1',
      } as unknown as GenericMessage,
    };
    const updateWrite: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-02T00:00:00.000000Z',
        }),
        recordId: 'rec-1',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([updateWrite, initialWrite]);
    expect(result[0]).toBe(initialWrite);
    expect(result[1]).toBe(updateWrite);
  });

  it('should place parent record before child record (parentId)', () => {
    const parent: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'parent-rec',
      } as unknown as GenericMessage,
    };
    const child: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'parent-rec',
        }),
        recordId: 'child-rec',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([child, parent]);
    expect(result[0]).toBe(parent);
    expect(result[1]).toBe(child);
  });

  it('should place initial write before RecordsDelete for same recordId', () => {
    const initialWrite: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'rec-to-delete',
      } as unknown as GenericMessage,
    };
    const deleteMsg: SortEntry = {
      message: makeMessage({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Delete,
        recordId  : 'rec-to-delete',
      }),
    };

    const result = orderMessagesForAdmission([deleteMsg, initialWrite]);
    expect(result[0]).toBe(initialWrite);
    expect(result[1]).toBe(deleteMsg);
  });

  it('should place permission grant before a direct message referencing permissionGrantId', () => {
    const grantMsg: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          protocol         : PermissionsProtocol.uri,
          protocolPath     : PermissionsProtocol.grantPath,
        }),
        recordId: 'grant-rec-id',
      } as unknown as GenericMessage,
    };
    const dependentMsg: SortEntry = {
      message: makeAuthorizedMessage(
        { permissionGrantId: 'grant-rec-id' },
        { permissionGrantId: 'grant-rec-id' },
      ),
    };

    const result = orderMessagesForAdmission([dependentMsg, grantMsg]);
    expect(result[0]).toBe(grantMsg);
    expect(result[1]).toBe(dependentMsg);
  });

  it('should place permission grant before a Messages operation referencing permissionGrantIds', () => {
    const grantMsg: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          protocol         : PermissionsProtocol.uri,
          protocolPath     : PermissionsProtocol.grantPath,
        }),
        recordId: 'grant-rec-id',
      } as unknown as GenericMessage,
    };
    const dependentMsg: SortEntry = {
      message: makeAuthorizedMessage(
        {
          interface          : DwnInterfaceName.Messages,
          method             : DwnMethodName.Query,
          permissionGrantIds : ['grant-rec-id'],
        },
        { permissionGrantIds: ['grant-rec-id'] },
      ),
    };

    const result = orderMessagesForAdmission([dependentMsg, grantMsg]);
    expect(result[0]).toBe(grantMsg);
    expect(result[1]).toBe(dependentMsg);
  });

  it('should place invoked role records before role-authorized writes', () => {
    const protocol = 'https://example.com/role-sort';
    const roleMsg: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          protocol,
          protocolPath     : 'friend',
          recipient        : 'did:example:bob',
        }),
        recordId  : 'friend-role',
        contextId : 'friend-role',
      } as unknown as GenericMessage,
    };
    const dependentMsg: SortEntry = {
      message: {
        ...makeAuthorizedMessage(
          {
            dateCreated      : '2024-01-01T00:00:00.000000Z',
            messageTimestamp : '2024-01-01T00:00:00.000000Z',
            protocol,
            protocolPath     : 'chat',
          },
          { protocolRole: 'friend' },
          'did:example:bob',
        ),
        recordId: 'chat-record',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([dependentMsg, roleMsg]);
    expect(result[0]).toBe(roleMsg);
    expect(result[1]).toBe(dependentMsg);
  });

  it('should match invoked context roles by ancestor context prefix', () => {
    const protocol = 'https://example.com/context-role-sort';
    const matchingRole: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'thread-1',
          protocol,
          protocolPath     : 'thread/participant',
          recipient        : 'did:example:bob',
        }),
        recordId  : 'thread-1-role',
        contextId : 'thread-1/thread-1-role',
      } as unknown as GenericMessage,
    };
    const otherRole: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'thread-2',
          protocol,
          protocolPath     : 'thread/participant',
          recipient        : 'did:example:bob',
        }),
        recordId  : 'thread-2-role',
        contextId : 'thread-2/thread-2-role',
      } as unknown as GenericMessage,
    };
    const dependentMsg: SortEntry = {
      message: {
        ...makeAuthorizedMessage(
          {
            dateCreated      : '2024-01-01T00:00:00.000000Z',
            messageTimestamp : '2024-01-01T00:00:00.000000Z',
            parentId         : 'thread-1',
            protocol,
            protocolPath     : 'thread/chat',
          },
          { protocolRole: 'thread/participant' },
          'did:example:bob',
        ),
        recordId  : 'thread-1-chat',
        contextId : 'thread-1/thread-1-chat',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([dependentMsg, otherRole, matchingRole]);
    expect(result.indexOf(matchingRole)).toBeLessThan(result.indexOf(dependentMsg));
    expect(result.includes(otherRole)).toBe(true);
  });

  it('should place audienceEpoch and role records before audienceKey records', () => {
    const protocol = 'https://example.com/encrypted-chat';
    const tags = {
      protocol,
      contextId : 'chat-1',
      role      : 'chat/member',
      epoch     : 1,
      keyId     : 'key-1',
    };
    const audienceKey: SortEntry = {
      message: {
        ...makeMessage({
          protocol     : EncryptionProtocol.uri,
          protocolPath : EncryptionProtocol.audienceKeyPath,
          recipient    : 'did:example:bob',
          tags,
        }),
        recordId: 'audience-key',
      } as unknown as GenericMessage,
    };
    const audienceEpoch: SortEntry = {
      message: {
        ...makeMessage({
          protocol     : EncryptionProtocol.uri,
          protocolPath : EncryptionProtocol.audienceEpochPath,
          tags,
        }),
        recordId: 'audience-epoch',
      } as unknown as GenericMessage,
    };
    const role: SortEntry = {
      message: {
        ...makeMessage({
          protocol,
          protocolPath : 'chat/member',
          recipient    : 'did:example:bob',
        }),
        recordId  : 'member-role',
        contextId : 'chat-1/member-role',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([audienceKey, audienceEpoch, role]);

    expect(result.indexOf(audienceEpoch)).toBeLessThan(result.indexOf(audienceKey));
    expect(result.indexOf(role)).toBeLessThan(result.indexOf(audienceKey));
  });

  it('should place source-protocol audience records before encrypted records that reference them', () => {
    const protocol = 'https://example.com/source-audience-ordering';
    const audience: SortEntry = {
      message: {
        ...makeMessage({
          protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol,
            contextId : 'thread-1',
            rolePath  : 'thread/member',
            keyId     : 'key-1',
          },
        }),
        recordId  : 'audience-record',
        contextId : 'audience-record',
      } as unknown as GenericMessage,
    };
    const encryptedRecord: SortEntry = {
      message: {
        ...makeMessage({
          protocol,
          protocolPath     : 'thread/message',
          parentId         : 'thread-1',
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        contextId  : 'thread-1/message-1',
        encryption : {
          keyEncryption: [{
            derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
            protocol,
            rolePath         : 'thread/member',
            keyId            : 'key-1',
          }],
        },
        recordId: 'message-1',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([encryptedRecord, audience]);

    expect(result.indexOf(audience)).toBeLessThan(result.indexOf(encryptedRecord));
  });

  it('should place permission grants before grantKey records', () => {
    const grant: SortEntry = {
      message: {
        ...makeMessage({
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.grantPath,
        }),
        recordId: 'grant-rec-id',
      } as unknown as GenericMessage,
    };
    const grantKey: SortEntry = {
      message: {
        ...makeMessage({
          protocol     : EncryptionProtocol.uri,
          protocolPath : EncryptionProtocol.grantKeyPath,
          tags         : {
            grantId  : 'grant-rec-id',
            protocol : 'https://example.com/encrypted-chat',
            keyId    : 'key-1',
          },
        }),
        recordId: 'grant-key',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([grantKey, grant]);

    expect(result[0]).toBe(grant);
    expect(result[1]).toBe(grantKey);
  });

  it('should handle self-referencing edge (from === to) without infinite loop', () => {
    // A RecordsWrite whose parentId is its own recordId should not break.
    const selfRef: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'self-ref',
        }),
        recordId: 'self-ref',
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([selfRef]);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(selfRef);
  });

  it('should append cycle nodes at the end when a dependency cycle exists', () => {
    // Simulate a cycle: A depends on B (via parentId), B depends on A (via parentId).
    // Both are "initial writes" so initialWriteIndex maps both.
    const msgA: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'rec-b',
        }),
        recordId: 'rec-a',
      } as unknown as GenericMessage,
    };
    const msgB: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'rec-a',
        }),
        recordId: 'rec-b',
      } as unknown as GenericMessage,
    };

    // Both nodes are in a cycle, neither has inDegree 0 when processed together.
    // An independent node should come first.
    const independent: SortEntry = {
      message: {
        ...makeMessage({
          interface  : DwnInterfaceName.Protocols,
          method     : DwnMethodName.Configure,
          definition : { protocol: 'https://example.com/other' },
        }),
      } as unknown as GenericMessage,
    };

    const result = orderMessagesForAdmission([msgA, msgB, independent]);
    // The independent node should be first; the cycle nodes appended at the end.
    expect(result.length).toBe(3);
    expect(result[0]).toBe(independent);
    // Both cycle nodes are present in the result.
    expect(result.includes(msgA)).toBe(true);
    expect(result.includes(msgB)).toBe(true);
  });

  it('should handle messages with no dependency relations', () => {
    const msg1: SortEntry = { message: makeMessage({ interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }) };
    const msg2: SortEntry = { message: makeMessage({ interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }) };
    const msg3: SortEntry = { message: makeMessage({ interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }) };

    const result = orderMessagesForAdmission([msg1, msg2, msg3]);
    expect(result.length).toBe(3);
  });
});
