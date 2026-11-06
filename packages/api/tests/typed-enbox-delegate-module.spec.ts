import { describe, expect, it } from 'bun:test';

import { TypedEnbox, WalletReapprovalRequiredError } from '../src/typed-enbox.js';

/**
 * Builds a TypedEnbox instance over a stubbed DwnApi so the private
 * delegate configure path can be exercised without an agent.
 */
function createDelegateTypedEnbox(queryResult: unknown): any {
  const typed: any = Object.create((TypedEnbox as any).prototype);
  typed._definition = { module: 'https://example.com/modules/demo', types: {}, structure: {} };
  typed._options = {};
  typed._dwn = {
    connectedDid : 'did:dht:owner',
    isDelegate   : true,
    modules      : {
      query: async (): Promise<unknown> => queryResult,
    },
  };
  return typed;
}

describe('TypedEnbox delegate module ensure', () => {
  it('should surface authorization failures instead of reporting a missing module', async () => {
    const typed = createDelegateTypedEnbox({
      status  : { code: 401, detail: 'GrantAuthorizationGrantRevoked: grant has been revoked' },
      modules : [],
    });

    await expect(typed.configure()).rejects.toMatchObject({
      status: {
        code   : 401,
        detail : 'GrantAuthorizationGrantRevoked: grant has been revoked',
      },
    });
  });

  it('should require wallet reapproval when the wallet has not installed the module', async () => {
    const typed = createDelegateTypedEnbox({
      status  : { code: 200, detail: 'OK' },
      modules : [],
    });

    await expect(typed.configure()).rejects.toBeInstanceOf(WalletReapprovalRequiredError);
  });

  it('should reuse a matching local wallet configuration for implicit readiness', async () => {
    const requests: unknown[] = [];
    const typed = createDelegateTypedEnbox({
      status  : { code: 200, detail: 'OK' },
      modules : [{ definition: { module: 'https://example.com/modules/demo', types: {}, structure: {} } }],
    });
    const query = typed._dwn.modules.query;
    typed._dwn.modules.query = async (request: unknown): Promise<unknown> => {
      requests.push(request);
      return query(request);
    };
    typed._hasEncryptedTypes = false;

    await typed._autoConfigureOnce();

    expect(typed._configured).toBe(true);
    expect(requests).toEqual([{ filter: { module: 'https://example.com/modules/demo' } }]);
  });
});
