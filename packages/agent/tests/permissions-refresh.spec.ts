import type { PermissionGrant, PermissionScope } from '@enbox/dwn-sdk-js';

import type { DwnDataEncodedRecordsWriteMessage } from '../src/types/dwn.js';
import type { EnboxAgent } from '../src/types/agent.js';
import type { PermissionGrantEntry } from '../src/types/permissions.js';

import sinon from 'sinon';
import { afterEach, describe, expect, test } from 'bun:test';

import { DwnInterface } from '../src/types/dwn.js';
import { AgentPermissionsApi, PermissionGrantNotFoundError } from '../src/permissions-api.js';

const OWNER_DID = 'did:dht:owner';
const DELEGATE_DID = 'did:dht:delegate';
const RECORDS_WRITE_SCOPE: PermissionScope = {
  interface : 'Records',
  method    : 'Write',
  protocol  : 'https://example.com/notes',
};

function createGrantEntry(params: {
  id: string;
  dateGranted: string;
  dateExpires: string;
  delegated?: boolean;
  scope?: PermissionScope;
}): PermissionGrantEntry {
  const grant = {
    id          : params.id,
    grantor     : OWNER_DID,
    grantee     : DELEGATE_DID,
    dateGranted : params.dateGranted,
    dateExpires : params.dateExpires,
    delegated   : params.delegated ?? true,
    scope       : params.scope ?? RECORDS_WRITE_SCOPE,
  } as PermissionGrant;

  return {
    grant,
    message: { recordId: params.id },
  } as PermissionGrantEntry;
}

describe('AgentPermissionsApi refresh grant selection', () => {
  afterEach(() => {
    sinon.restore();
  });

  test('ignores expired and not-yet-active grants', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const expired = createGrantEntry({
      id          : 'expired',
      dateGranted : '2026-07-01T00:00:00.000000Z',
      dateExpires : '2026-07-13T11:59:59.000000Z',
    });
    const future = createGrantEntry({
      id          : 'future',
      dateGranted : '2026-07-13T12:00:01.000000Z',
      dateExpires : '2026-07-14T00:00:00.000000Z',
    });
    const active = createGrantEntry({
      id          : 'active',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-13T13:00:00.000000Z',
    });

    const selected = await AgentPermissionsApi.matchGrantFromArray(
      OWNER_DID,
      DELEGATE_DID,
      {
        messageType : DwnInterface.RecordsWrite,
        protocol    : 'https://example.com/notes',
      },
      [expired, future, active],
    );

    expect(selected?.grant.id).toBe('active');
    clock.restore();
  });

  test('prefers the matching grant with the later expiry on an equal scope', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const shorter = createGrantEntry({
      id          : 'shorter',
      dateGranted : '2026-07-13T11:59:00.000000Z',
      dateExpires : '2026-07-13T13:00:00.000000Z',
    });
    const refreshed = createGrantEntry({
      id          : 'refreshed',
      dateGranted : '2026-07-13T11:58:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
    });

    const selected = await AgentPermissionsApi.matchGrantFromArray(
      OWNER_DID,
      DELEGATE_DID,
      {
        messageType : DwnInterface.RecordsWrite,
        protocol    : 'https://example.com/notes',
      },
      [shorter, refreshed],
    );

    expect(selected?.grant.id).toBe('refreshed');
    clock.restore();
  });

  test('does not return a cached grant after its enforcing expiry', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const permissions = new AgentPermissionsApi();
    const expiring = createGrantEntry({
      id          : 'expiring',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-13T12:00:01.000000Z',
    });
    const refreshed = createGrantEntry({
      id          : 'refreshed',
      dateGranted : '2026-07-13T12:00:01.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants');
    fetchGrants.onFirstCall().resolves([expiring]);
    fetchGrants.onSecondCall().resolves([refreshed]);

    const first = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });
    await clock.tickAsync(2000);
    const second = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });

    expect(first.grant.id).toBe('expiring');
    expect(second.grant.id).toBe('refreshed');
    expect(fetchGrants.callCount).toBe(2);
    clock.restore();
  });

  test('applies delegated-only selection independently within one cached catalog', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const permissions = new AgentPermissionsApi();
    const direct = createGrantEntry({
      id          : 'direct',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-15T12:00:00.000000Z',
      delegated   : false,
    });
    const delegated = createGrantEntry({
      id          : 'delegated',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants').resolves([direct, delegated]);

    const permissiveMatch = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });
    const delegatedMatch = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      delegate     : true,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });

    expect(permissiveMatch.grant.id).toBe('direct');
    expect(delegatedMatch.grant.id).toBe('delegated');
    expect(fetchGrants.callCount).toBe(1);
    clock.restore();
  });

  test('reuses one grant catalog across distinct context-scoped lookups', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const permissions = new AgentPermissionsApi();
    const firstContext = createGrantEntry({
      id          : 'first-context',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
      scope       : { ...RECORDS_WRITE_SCOPE, contextId: 'conversation-a' },
    });
    const secondContext = createGrantEntry({
      id          : 'second-context',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
      scope       : { ...RECORDS_WRITE_SCOPE, contextId: 'conversation-b' },
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants').resolves([firstContext, secondContext]);

    const first = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      contextId    : 'conversation-a',
      cached       : true,
    });
    const second = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      contextId    : 'conversation-b',
      cached       : true,
    });

    expect(first.grant.id).toBe('first-context');
    expect(second.grant.id).toBe('second-context');
    expect(fetchGrants.callCount).toBe(1);
    clock.restore();
  });

  test('refreshes a cached catalog when a newly requested scope has no match', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const permissions = new AgentPermissionsApi();
    const firstContext = createGrantEntry({
      id          : 'first-context',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
      scope       : { ...RECORDS_WRITE_SCOPE, contextId: 'conversation-a' },
    });
    const addedContext = createGrantEntry({
      id          : 'added-context',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
      scope       : { ...RECORDS_WRITE_SCOPE, contextId: 'conversation-b' },
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants');
    fetchGrants.onFirstCall().resolves([firstContext]);
    fetchGrants.onSecondCall().resolves([firstContext, addedContext]);

    await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      contextId    : 'conversation-a',
      cached       : true,
    });
    const added = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      contextId    : 'conversation-b',
      cached       : true,
    });

    expect(added.grant.id).toBe('added-context');
    expect(fetchGrants.callCount).toBe(2);
    clock.restore();
  });

  test('coalesces concurrent catalog fetches for the same grantor and grantee', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const permissions = new AgentPermissionsApi();
    const grant = createGrantEntry({
      id          : 'shared-grant',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
    });
    let resolveFetch!: (grants: PermissionGrantEntry[]) => void;
    const pendingFetch = new Promise<PermissionGrantEntry[]>((resolve): void => {
      resolveFetch = resolve;
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants').returns(pendingFetch);

    const first = permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });
    const second = permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });
    resolveFetch([grant]);

    const [firstMatch, secondMatch] = await Promise.all([first, second]);
    expect(firstMatch.grant.id).toBe('shared-grant');
    expect(secondMatch.grant.id).toBe('shared-grant');
    expect(fetchGrants.callCount).toBe(1);
    clock.restore();
  });

  test('performs an explicit fresh fetch instead of joining an active cached lookup', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const permissions = new AgentPermissionsApi();
    const stale = createGrantEntry({
      id          : 'stale',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
    });
    const fresh = createGrantEntry({
      id          : 'fresh',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-15T12:00:00.000000Z',
    });
    let resolveCachedFetch!: (grants: PermissionGrantEntry[]) => void;
    const cachedFetch = new Promise<PermissionGrantEntry[]>((resolve): void => {
      resolveCachedFetch = resolve;
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants');
    fetchGrants.onFirstCall().returns(cachedFetch);
    fetchGrants.onSecondCall().resolves([fresh]);

    const cachedLookup = permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });
    const freshLookup = permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : false,
    });
    resolveCachedFetch([stale]);

    expect((await cachedLookup).grant.id).toBe('stale');
    expect((await freshLookup).grant.id).toBe('fresh');
    expect((await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    })).grant.id).toBe('fresh');
    expect(fetchGrants.callCount).toBe(2);
    clock.restore();
  });

  test('does not let an in-flight lookup repopulate a cleared catalog', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const permissions = new AgentPermissionsApi();
    const grant = createGrantEntry({
      id          : 'grant-after-clear',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
    });
    let resolveFetch!: (grants: PermissionGrantEntry[]) => void;
    const pendingFetch = new Promise<PermissionGrantEntry[]>((resolve): void => {
      resolveFetch = resolve;
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants');
    fetchGrants.onFirstCall().returns(pendingFetch);
    fetchGrants.onSecondCall().resolves([grant]);

    const lookupBeforeClear = permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });
    await permissions.clear();
    resolveFetch([grant]);
    await lookupBeforeClear;

    const lookupAfterClear = await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    });

    expect(lookupAfterClear.grant.id).toBe('grant-after-clear');
    expect(fetchGrants.callCount).toBe(2);
    clock.restore();
  });

  test('excludes a locally stored revocation from a cached grant catalog', async () => {
    const clock = sinon.useFakeTimers({ now: new Date('2026-07-13T12:00:00.000Z') });
    const processDwnRequest = sinon.stub().resolves({
      message : { recordId: 'revocation' },
      reply   : { status: { code: 202, detail: 'Accepted' } },
    });
    const permissions = new AgentPermissionsApi({
      agent: { processDwnRequest } as unknown as EnboxAgent,
    });
    const grant = createGrantEntry({
      id          : 'revoked-grant',
      dateGranted : '2026-07-13T11:00:00.000000Z',
      dateExpires : '2026-07-14T12:00:00.000000Z',
    });
    const fetchGrants = sinon.stub(permissions, 'fetchGrants').resolves([grant]);

    expect((await permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    })).grant.id).toBe('revoked-grant');

    await permissions.createRevocation({ author: OWNER_DID, grant: grant.grant, store: true });

    await expect(permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
      cached       : true,
    })).rejects.toBeInstanceOf(PermissionGrantNotFoundError);
    expect(fetchGrants.callCount).toBe(2);
    clock.restore();
  });

  test('does not let a revocation read started before clear repopulate revoked IDs', async () => {
    let resolveGrantQuery!: (response: unknown) => void;
    const grantQuery = new Promise((resolve): void => {
      resolveGrantQuery = resolve;
    });
    const processDwnRequest = sinon.stub();
    processDwnRequest.onFirstCall().returns(grantQuery);
    processDwnRequest.onSecondCall().resolves({
      reply: { status: { code: 200, detail: 'OK' } },
    });
    processDwnRequest.onThirdCall().resolves({
      reply: { status: { code: 404, detail: 'Not Found' } },
    });
    const permissions = new AgentPermissionsApi({
      agent: { processDwnRequest } as unknown as EnboxAgent,
    });

    const fetch = permissions.fetchGrants({
      author       : DELEGATE_DID,
      target       : DELEGATE_DID,
      grantor      : OWNER_DID,
      grantee      : DELEGATE_DID,
      checkRevoked : true,
    });
    await permissions.clear();
    resolveGrantQuery({
      reply: {
        status  : { code: 200, detail: 'OK' },
        entries : [{ recordId: 'grant-after-clear' } as DwnDataEncodedRecordsWriteMessage],
      },
    });

    expect(await fetch).toEqual([]);
    expect(await permissions.isGrantRevoked({
      author        : DELEGATE_DID,
      target        : DELEGATE_DID,
      grantRecordId : 'grant-after-clear',
    })).toBe(false);
    expect(processDwnRequest.callCount).toBe(3);
  });

  test('throws a typed not-found error without masking catalog fetch failures', async () => {
    const permissions = new AgentPermissionsApi();
    const fetchGrants = sinon.stub(permissions, 'fetchGrants');
    fetchGrants.onFirstCall().resolves([]);
    fetchGrants.onSecondCall().rejects(new Error('grant store unavailable'));

    await expect(permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
    })).rejects.toBeInstanceOf(PermissionGrantNotFoundError);

    await expect(permissions.getPermissionForRequest({
      connectedDid : OWNER_DID,
      delegateDid  : DELEGATE_DID,
      messageType  : DwnInterface.RecordsWrite,
      protocol     : 'https://example.com/notes',
    })).rejects.toThrow('grant store unavailable');
  });
});
