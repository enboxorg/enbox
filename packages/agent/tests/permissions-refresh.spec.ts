import type { PermissionGrant, PermissionScope } from '@enbox/dwn-sdk-js';

import type { PermissionGrantEntry } from '../src/types/permissions.js';

import sinon from 'sinon';
import { afterEach, describe, expect, test } from 'bun:test';

import { AgentPermissionsApi } from '../src/permissions-api.js';
import { DwnInterface } from '../src/types/dwn.js';

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

  test('keeps delegated-only lookups separate from permissive cache entries', async () => {
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
    expect(fetchGrants.callCount).toBe(2);
    clock.restore();
  });
});
