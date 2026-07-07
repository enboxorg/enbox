import { describe, expect, it } from 'bun:test';

import { TypedEnbox } from '../src/typed-enbox.js';

/**
 * Builds a TypedEnbox instance over a stubbed DwnApi so the private
 * delegate-protocol ensure path can be exercised without an agent.
 */
function createDelegateTypedEnbox(queryResult: unknown): any {
  const typed: any = Object.create((TypedEnbox as any).prototype);
  typed._definition = { protocol: 'https://example.com/protocols/demo', types: {}, structure: {} };
  typed._dwn = {
    connectedDid : 'did:dht:owner',
    isDelegate   : true,
    protocols    : {
      query: async (): Promise<unknown> => queryResult,
    },
  };
  return typed;
}

describe('TypedEnbox delegate protocol ensure', () => {
  it('should surface authorization failures instead of reporting a missing protocol', async () => {
    const typed = createDelegateTypedEnbox({
      status    : { code: 401, detail: 'GrantAuthorizationGrantRevoked: grant has been revoked' },
      protocols : [],
    });

    await expect(typed._autoConfigureDelegateProtocol()).rejects.toThrow(
      '401 GrantAuthorizationGrantRevoked'
    );
  });

  it('should return undefined when the wallet has genuinely not installed the protocol', async () => {
    const typed = createDelegateTypedEnbox({
      status    : { code: 200, detail: 'OK' },
      protocols : [],
    });

    await expect(typed._autoConfigureDelegateProtocol()).resolves.toBeUndefined();
  });
});
