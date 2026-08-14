import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { DwnInterface } from '../src/types/dwn.js';
import { PermissionGrantNotFoundError } from '../src/permissions-api.js';
import { resolveDelegatePermissionGrantId } from '../src/delegate-permission-grant.js';

describe('resolveDelegatePermissionGrantId', () => {
  it('returns undefined when there is no delegate', async () => {
    const result = await resolveDelegatePermissionGrantId(
      { did: 'did:example:alice' },
      DwnInterface.RecordsQuery,
      'https://example.com/protocol',
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when no permissions API is configured', async () => {
    const result = await resolveDelegatePermissionGrantId(
      { did: 'did:example:alice', delegateDid: 'did:example:delegate' },
      DwnInterface.RecordsQuery,
      'https://example.com/protocol',
    );
    expect(result).toBeUndefined();
  });

  it('returns the grant id when a matching grant exists', async () => {
    const permissionsApi = { getPermissionForRequest: sinon.stub().resolves({ grant: { id: 'grant-123' } }) };
    const result = await resolveDelegatePermissionGrantId(
      { did: 'did:example:alice', delegateDid: 'did:example:delegate', permissionsApi: permissionsApi as any },
      DwnInterface.RecordsQuery,
      'https://example.com/protocol',
    );
    expect(result).toBe('grant-123');
    expect(permissionsApi.getPermissionForRequest.firstCall.args[0]).toEqual({
      connectedDid : 'did:example:alice',
      delegateDid  : 'did:example:delegate',
      messageType  : DwnInterface.RecordsQuery,
      protocol     : 'https://example.com/protocol',
    });
  });

  it('returns undefined when no matching grant exists (expected not-found)', async () => {
    const permissionsApi = {
      getPermissionForRequest: sinon.stub().rejects(
        new PermissionGrantNotFoundError({
          messageType : DwnInterface.RecordsQuery,
          protocol    : 'https://example.com/protocol',
        })
      ),
    };
    const result = await resolveDelegatePermissionGrantId(
      { did: 'did:example:alice', delegateDid: 'did:example:delegate', permissionsApi: permissionsApi as any },
      DwnInterface.RecordsQuery,
      'https://example.com/protocol',
    );
    expect(result).toBeUndefined();
  });

  it('surfaces an unexpected error instead of treating it as no grant', async () => {
    const permissionsApi = {
      getPermissionForRequest: sinon.stub().rejects(new Error('PermissionsApi: Failed to fetch grants: 500 boom')),
    };
    await expect(resolveDelegatePermissionGrantId(
      { did: 'did:example:alice', delegateDid: 'did:example:delegate', permissionsApi: permissionsApi as any },
      DwnInterface.RecordsQuery,
      'https://example.com/protocol',
    )).rejects.toThrow('Failed to fetch grants');
  });
});
