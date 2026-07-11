import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { fetchWalletWellKnown, probeWalletWellKnown, WALLET_WELL_KNOWN_PATH } from '../src/ui/wallet-well-known.js';

const ORIGIN = 'https://wallet.example.com';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status  : 200,
    headers : { 'content-type': 'application/json' },
    ...init,
  });
}

describe('wallet well-known discovery', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it('resolves the parsed document when connectServerUrl is present', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ connectServerUrl: 'https://relay.example.com/connect' }),
    );

    const doc = await fetchWalletWellKnown(ORIGIN);
    expect(doc).toEqual({ connectServerUrl: 'https://relay.example.com/connect' });
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${ORIGIN}${WALLET_WELL_KNOWN_PATH}`);
  });

  it('resolves undefined for a malformed document', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ nope: true }));
    expect(await fetchWalletWellKnown(ORIGIN)).toBeUndefined();
  });

  it('resolves undefined for non-2xx responses', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));
    expect(await fetchWalletWellKnown(ORIGIN)).toBeUndefined();
  });

  it('resolves undefined when the fetch rejects (unreachable / CORS)', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network error'));
    expect(await fetchWalletWellKnown(ORIGIN)).toBeUndefined();
  });

  it('probeWalletWellKnown mirrors document presence as a boolean', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ connectServerUrl: 'https://relay.example.com/connect' }),
    );
    expect(await probeWalletWellKnown(ORIGIN)).toBe(true);

    fetchSpy.mockResolvedValue(jsonResponse({}));
    expect(await probeWalletWellKnown(ORIGIN)).toBe(false);
  });
});
