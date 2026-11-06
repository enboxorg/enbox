import type { PermissionGrant } from '../../src/modules/permission-grant.js';
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
  const module = 'https://example.com/module';
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
        module           : 'https://example.com/module',
        modulePath       : 'thread/message',
        dataFormat       : 'application/json',
        dataCid          : 'bafybeigdyrztj3md',
        dataSize         : 2,
        dateCreated      : '2026-01-01T00:00:00.000000Z',
        messageTimestamp : '2026-01-01T00:00:00.000000Z',
      },
    } as RecordsWriteMessage;
  }

  function makePermissionGrant(
    method: DwnMethodName,
    scope: Pick<RecordsPermissionScope, 'module'> & Partial<Pick<RecordsPermissionScope, 'modulePath' | 'contextId'>>
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
    grantScope: Pick<RecordsPermissionScope, 'module'> & Partial<Pick<RecordsPermissionScope, 'modulePath' | 'contextId'>>,
    filter: RecordsFilter
  ): Promise<void> {
    await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
      incomingMessage : makeIncomingMessage(method, filter),
      expectedGrantor : grantor,
      expectedGrantee : grantee,
      permissionGrant : makePermissionGrant(DwnMethodName.Read, grantScope),
      validationStateReader,
    })).rejects.toThrow(DwnErrorCode.RecordsGrantAuthorizationQueryOrSubscribeModuleScopeMismatch);
  }

  it('matches contextId scopes by context subtree', () => {
    const scope: RecordsPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
      module    : 'https://example.com/module',
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
    it('rejects a broad query with a modulePath-scoped grant', async () => {
      await expectQueryOrSubscribeScopeMismatch(
        DwnMethodName.Query,
        { module, modulePath: 'thread/message' },
        { module }
      );
    });

    it('allows a matching modulePath-scoped query', async () => {
      await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage: makeIncomingMessage(DwnMethodName.Query, {
          module,
          modulePath: 'thread/message',
        }),
        expectedGrantor : grantor,
        expectedGrantee : grantee,
        permissionGrant : makePermissionGrant(DwnMethodName.Read, {
          module,
          modulePath: 'thread/message',
        }),
        validationStateReader,
      })).resolves.toBeUndefined();
    });

    it('rejects sibling modulePath and contextId filters', async () => {
      await expectQueryOrSubscribeScopeMismatch(
        DwnMethodName.Query,
        { module, modulePath: 'thread/message' },
        { module, modulePath: 'thread/reaction' }
      );

      await expectQueryOrSubscribeScopeMismatch(
        DwnMethodName.Subscribe,
        { module, contextId: 'root' },
        { module, contextId: 'rootEVIL' }
      );
    });

    it('allows equal and narrower context queries but rejects a broader requested ancestor', async () => {
      const grantScope = { module, contextId: 'root/branch' };
      for (const contextId of ['root/branch', 'root/branch/child']) {
        await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
          incomingMessage : makeIncomingMessage(DwnMethodName.Query, { module, contextId }),
          expectedGrantor : grantor,
          expectedGrantee : grantee,
          permissionGrant : makePermissionGrant(DwnMethodName.Read, grantScope),
          validationStateReader,
        })).resolves.toBeUndefined();
      }

      await expectQueryOrSubscribeScopeMismatch(
        DwnMethodName.Query,
        grantScope,
        { module, contextId: 'root' },
      );
    });

    it('allows module-scoped query, subscribe, and count filters with a Records.Read grant', async () => {
      for (const method of [DwnMethodName.Query, DwnMethodName.Subscribe, DwnMethodName.Count] as const) {
        await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
          incomingMessage : makeIncomingMessage(method, { module }),
          expectedGrantor : grantor,
          expectedGrantee : grantee,
          permissionGrant : makePermissionGrant(DwnMethodName.Read, { module }),
          validationStateReader,
        })).resolves.toBeUndefined();
      }
    });

    it('rejects read-like Records grants that do not use method Read', async () => {
      const cases = [
        [DwnMethodName.Query, DwnMethodName.Query],
        [DwnMethodName.Subscribe, DwnMethodName.Subscribe],
        [DwnMethodName.Count, DwnMethodName.Count],
        [DwnMethodName.Write, DwnMethodName.Query],
      ] as const;

      for (const [grantMethod, incomingMethod] of cases) {
        await expect(RecordsGrantAuthorization.authorizeQueryOrSubscribe({
          incomingMessage : makeIncomingMessage(incomingMethod, { module }),
          expectedGrantor : grantor,
          expectedGrantee : grantee,
          permissionGrant : makePermissionGrant(grantMethod, { module }),
          validationStateReader,
        })).rejects.toThrow(DwnErrorCode.GrantAuthorizationMethodMismatch);
      }
    });
  });
});
