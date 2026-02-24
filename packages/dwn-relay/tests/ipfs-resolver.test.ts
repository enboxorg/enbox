import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Cid, DataStream } from '@enbox/dwn-sdk-js';

import { IpfsResolver } from '../src/proxy/ipfs-resolver.js';

describe('IpfsResolver', () => {
  const gatewayUrl = 'http://localhost:8080';
  let resolver: IpfsResolver;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    resolver = new IpfsResolver(gatewayUrl, 5_000);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should resolve data and verify CID', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const expectedCid = await Cid.computeDagPbCidFromBytes(testData);

    globalThis.fetch = (async (_url: any, _opts: any) => {
      return new Response(testData, { status: 200 });
    }) as any;

    const result = await resolver.resolve(expectedCid);
    expect(result).toBeDefined();
    expect(result!.dataSize).toBe(8);

    const bytes = await DataStream.toBytes(result!.dataStream);
    expect(bytes).toEqual(testData);
  });

  it('should return undefined on CID mismatch', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    const wrongCid = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenera28z4'; // bogus CID

    globalThis.fetch = (async () => {
      return new Response(testData, { status: 200 });
    }) as any;

    const result = await resolver.resolve(wrongCid);
    expect(result).toBeUndefined();
  });

  it('should return undefined on non-200 status', async () => {
    globalThis.fetch = (async () => {
      return new Response(null, { status: 404 });
    }) as any;

    const result = await resolver.resolve('some-cid');
    expect(result).toBeUndefined();
  });

  it('should return undefined on network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network error');
    }) as any;

    const result = await resolver.resolve('some-cid');
    expect(result).toBeUndefined();
  });

  it('should return undefined on timeout (abort)', async () => {
    globalThis.fetch = (async (_url: any, _opts: any) => {
      // Simulate a slow response by checking if signal is already aborted
      // Use a very short timeout resolver
      const _shortResolver = new IpfsResolver(gatewayUrl, 1);
      // We need to actually abort, so let's trigger it manually
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as any;

    const result = await resolver.resolve('some-cid');
    expect(result).toBeUndefined();
  });

  it('should construct correct gateway URL', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: any) => {
      capturedUrl = url.toString ? url.toString() : String(url);
      return new Response(null, { status: 404 });
    }) as any;

    await resolver.resolve('bafybeicid123');
    expect(capturedUrl).toBe('http://localhost:8080/ipfs/bafybeicid123');
  });

  it('should normalize gateway URL trailing slashes', async () => {
    const r = new IpfsResolver('http://localhost:8080///', 5_000);
    let capturedUrl = '';
    globalThis.fetch = (async (url: any) => {
      capturedUrl = url.toString ? url.toString() : String(url);
      return new Response(null, { status: 404 });
    }) as any;

    await r.resolve('bafybeicid');
    expect(capturedUrl).toBe('http://localhost:8080/ipfs/bafybeicid');
  });
});
