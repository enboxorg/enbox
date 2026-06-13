import type { PermissionGrant } from '../../src/protocols/permission-grant.js';
import type { RecordsPermissionScope } from '../../src/types/permission-types.js';
import type { ValidationStateReader } from '../../src/types/validation-state-reader.js';
import type { RecordsCountMessage, RecordsFilter, RecordsQueryMessage, RecordsSubscribeMessage, RecordsWriteMessage } from '../../src/types/records-types.js';

import { describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { RecordsGrantAuthorization } from '../../src/core/records-grant-authorization.js';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';

describe('RecordsGrantAuthorization', () => {
  const grantor = 'did:example:alice';
  const grantee = 'did:example:bob';
  const protocol = 'https://example.com/protocol';
  const timestamp = '2026-05-31T00:00:00.000000Z';
  const validationStateReader = {
    fetchOldestGrantRevocation: async () => undefined,
  } as unknown as ValidationStateReader;

  function makeRecordsWrite(contextId: string): RecordsWriteMessage {
    const contextIdSegments = contextId.split('/');
    return {
      recordId   : contextIdSegments[contextIdSegments.length - 1] ?? contextId,
      contextId,
      descriptor : {
        interface        : DwnInterfaceName.Records,
        method           : DwnMethodName.Write,
        protocol         : 'https://example.com/protocol',
        protocolPath     : 'thread/message',
        dataFormat       : 'application/json',
        dataCid          : 'bafybeigdyrztj3md',
        dataSize         : 2,
        dateCreated      : '2026-01-01T00:00:00.000000Z',
        messageTimestamp : '2026-01-01T00:00:00.000000Z',
      },
    } as RecordsWriteMessage;
  }

  function makePermissionGrant(
    method: RecordsPermissionScope['method'],
    scope: Pick<RecordsPermissionScope, 'protocol'> & Partial<Pick<RecordsPermissionScope, 'protocolPath' | 'contextId'>>
  ): PermissionGrant {
    return {
      id          : 'grant-record-id',
      grantor,
      grantee,
      dateGranted : '2026-01-01T00:00:00.000000Z',
      dateExpires : '2027-01-01T00:00:00.000000Z',
      scope       : {
        interface: DwnInterfaceName.Records,
        method,
        ...scope,
      },
    } as PermissionGrant;
  }

  function makeIncomingMessage(
    method: DwnMethodName.Count | DwnMethodName.Query | DwnMethodName.Subscribe,
    filter: RecordsFilter
  ): RecordsCountMessage | RecordsQueryMessage | RecordsSubscribeMessage {
    return {
      descriptor: {
        interface        : DwnInterfaceName.Records,
        method,
        messageTimestamp : timestamp,
        filter,
      },
    } as RecordsCountMessage | RecordsQueryMessage | RecordsSubscribeMessage;
  }

  async function expectQueryOrSubscribeScopeMismatch(
    method: DwnMethodName.Count | DwnMethodName.Query | DwnMethodName.Subscribe,
    grantScope: Pick<RecordsPermissionScope, 'protocol'> & Partial<Pick<RecordsPermissionScope, 'protocolPath' | 'contextId'>>,
    filter: RecordsFilter
  ): Promise<void> {
    await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
      incomingMessage : makeIncomingMessage(method, filter),
      expectedGrantor : grantor,
      expectedGrantee : grantee,
      permissionGrant : makePermissionGrant(method, grantScope),
      validationStateReader,
    })).rejects.toThrow(DwnErrorCode.RecordsGrantAuthorizationQueryOrSubscribeProtocolScopeMismatch);
  }

  it('matches contextId scopes by context subtree', () => {
    const scope: RecordsPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
      protocol  : 'https://example.com/protocol',
      contextId : 'root',
    };

    expect(() => {
      (RecordsGrantAuthorization as any).verifyScope(makeRecordsWrite('root'), scope);
    }).not.toThrow();
    expect(() => {
      (RecordsGrantAuthorization as any).verifyScope(makeRecordsWrite('root/child'), scope);
    }).not.toThrow();
    expect(() => {
      (RecordsGrantAuthorization as any).verifyScope(makeRecordsWrite('rootEVIL'), scope);
    }).toThrow(DwnErrorCode.RecordsGrantAuthorizationScopeContextIdMismatch);
  });

  describe('authorizeQueryOrSubscribe()', () => {
    it('rejects a broad query with a protocolPath-scoped grant', async () => {
      await expectQueryOrSubscribeScopeMismatch(
        DwnMethodName.Query,
        { protocol, protocolPath: 'thread/message' },
        { protocol }
      );
    });

    it('allows a matching protocolPath-scoped query', async () => {
      await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage: makeIncomingMessage(DwnMethodName.Query, {
          protocol,
          protocolPath: 'thread/message',
        }),
        expectedGrantor : grantor,
        expectedGrantee : grantee,
        permissionGrant : makePermissionGrant(DwnMethodName.Query, {
          protocol,
          protocolPath: 'thread/message',
        }),
        validationStateReader,
      })).resolves.toBeUndefined();
    });

    it('rejects sibling protocolPath and contextId filters', async () => {
      await expectQueryOrSubscribeScopeMismatch(
        DwnMethodName.Query,
        { protocol, protocolPath: 'thread/message' },
        { protocol, protocolPath: 'thread/reaction' }
      );

      await expectQueryOrSubscribeScopeMismatch(
        DwnMethodName.Subscribe,
        { protocol, contextId: 'root' },
        { protocol, contextId: 'rootEVIL' }
      );
    });

    it('allows protocol-scoped query and count filters', async () => {
      for (const method of [DwnMethodName.Query, DwnMethodName.Count] as const) {
        await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
          incomingMessage : makeIncomingMessage(method, { protocol }),
          expectedGrantor : grantor,
          expectedGrantee : grantee,
          permissionGrant : makePermissionGrant(method, { protocol }),
          validationStateReader,
        })).resolves.toBeUndefined();
      }
    });
  });
});
