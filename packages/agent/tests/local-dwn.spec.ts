import type { EnboxRpc } from '@enbox/dwn-clients';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import type { DwnDiscoveryFile, DwnDiscoveryRecord } from '../src/dwn-discovery-file.js';
import {
  LocalDwnDiscovery,
  localDwnServerName,
} from '../src/local-dwn.js';

// ─── Helpers ─────────────────────────────────────────────────────

function createRpcStub(behavior: 'valid' | 'invalid' | 'error' = 'valid'): EnboxRpc {
  const stub = sinon.stub();

  if (behavior === 'valid') {
    stub.resolves({ server: localDwnServerName });
  } else if (behavior === 'invalid') {
    stub.resolves({ server: 'some-other-server' });
  } else {
    stub.rejects(new Error('connection refused'));
  }

  return { getServerInfo: stub } as unknown as EnboxRpc;
}

function createDiscoveryFileStub(record?: DwnDiscoveryRecord | null): DwnDiscoveryFile {
  return {
    read   : sinon.stub().resolves(record ?? undefined),
    write  : sinon.stub().resolves(),
    remove : sinon.stub().resolves(),
    path   : '/home/test/.enbox/dwn.json',
  } as unknown as DwnDiscoveryFile;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('LocalDwnDiscovery', () => {
  afterEach(() => {
    sinon.restore();
  });

  // ─── No discovery file (browser-like) ─────────────────────────

  describe('no discovery file', () => {
    it('should return undefined when no discovery file is configured', async () => {
      const rpcClient = createRpcStub('valid');
      const discovery = new LocalDwnDiscovery(rpcClient);
      const endpoint = await discovery.getEndpoint();

      expect(endpoint).toBeUndefined();
      // No RPC calls — there is no file to validate and no port probing.
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(0);
    });
  });

  // ─── Caching ──────────────────────────────────────────────────

  describe('caching', () => {
    it('should cache a positive result and return it without re-discovery', async () => {
      const rpcClient = createRpcStub('valid');
      const discoveryFile = createDiscoveryFileStub({
        endpoint : 'http://127.0.0.1:55557',
        pid      : 12345,
      });
      const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
      const first = await discovery.getEndpoint();
      const second = await discovery.getEndpoint();

      expect(first).toBe('http://127.0.0.1:55557');
      expect(first).toBe(second);
      // Only one validation call (first getEndpoint); second served from cache.
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(1);
    });

    it('should cache a negative result and return undefined without re-discovery', async () => {
      const rpcClient = createRpcStub('error');
      const discovery = new LocalDwnDiscovery(rpcClient);
      const first = await discovery.getEndpoint();
      const second = await discovery.getEndpoint();

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      // No RPC calls — no file, no probing.
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(0);
    });

    it('should re-discover after the cache TTL expires', async () => {
      const rpcClient = createRpcStub('valid');
      const discoveryFile = createDiscoveryFileStub({
        endpoint : 'http://127.0.0.1:55557',
        pid      : 12345,
      });
      const discovery = new LocalDwnDiscovery(rpcClient, 0, discoveryFile);
      await discovery.getEndpoint();
      await discovery.getEndpoint();

      // Two validation calls — one per getEndpoint (TTL=0 means cache expires immediately).
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(2);
    });
  });

  // ─── File-based discovery ─────────────────────────────────────

  describe('file-based discovery', () => {
    it('should use the discovery file endpoint when it is valid', async () => {
      const rpcClient = createRpcStub('valid');
      const discoveryFile = createDiscoveryFileStub({
        endpoint : 'http://127.0.0.1:55557',
        pid      : 12345,
      });

      const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
      const endpoint = await discovery.getEndpoint();

      expect(endpoint).toBe('http://127.0.0.1:55557');
      // Should have called getServerInfo once (to validate the file endpoint).
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(1);
      expect((rpcClient.getServerInfo as sinon.SinonStub).firstCall.args[0]).toBe('http://127.0.0.1:55557');
    });

    it('should return undefined when the discovery file is empty', async () => {
      const rpcClient = createRpcStub('valid');
      const discoveryFile = createDiscoveryFileStub(null);

      const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
      const endpoint = await discovery.getEndpoint();

      expect(endpoint).toBeUndefined();
      // No RPC calls — file returned nothing, no fallback.
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(0);
    });

    it('should return undefined when the file endpoint fails validation', async () => {
      const rpcClient = createRpcStub('error');
      const discoveryFile = createDiscoveryFileStub({
        endpoint : 'http://127.0.0.1:55557',
        pid      : 12345,
      });

      const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
      const endpoint = await discovery.getEndpoint();

      expect(endpoint).toBeUndefined();
      // One RPC call to validate the file endpoint (which failed).
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(1);
    });

    it('should return undefined when the discovery file read throws', async () => {
      const rpcClient = createRpcStub('valid');
      const discoveryFile = {
        read   : sinon.stub().rejects(new Error('filesystem error')),
        write  : sinon.stub().resolves(),
        remove : sinon.stub().resolves(),
        path   : '/home/test/.enbox/dwn.json',
      } as unknown as DwnDiscoveryFile;

      const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
      const endpoint = await discovery.getEndpoint();

      expect(endpoint).toBeUndefined();
      // No RPC calls — file read threw, no fallback.
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(0);
    });

    it('should cache the file-based discovery result', async () => {
      const rpcClient = createRpcStub('valid');
      const discoveryFile = createDiscoveryFileStub({
        endpoint : 'http://127.0.0.1:55557',
        pid      : 12345,
      });

      const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
      const first = await discovery.getEndpoint();
      const second = await discovery.getEndpoint();

      expect(first).toBe(second);
      // File read + validation only on first call; second served from cache.
      expect((discoveryFile.read as sinon.SinonStub).callCount).toBe(1);
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(1);
    });
  });

  // ─── setCachedEndpoint ────────────────────────────────────────

  describe('setCachedEndpoint', () => {
    it('should validate and cache a valid endpoint', async () => {
      const rpcClient = createRpcStub('valid');
      const discovery = new LocalDwnDiscovery(rpcClient);

      const success = await discovery.setCachedEndpoint('http://127.0.0.1:55557');
      expect(success).toBe(true);

      const endpoint = await discovery.getEndpoint();
      expect(endpoint).toBe('http://127.0.0.1:55557');
      // Only the validation call from setCachedEndpoint.
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(1);
    });

    it('should return false and not cache an invalid endpoint', async () => {
      const rpcClient = createRpcStub('error');
      const discovery = new LocalDwnDiscovery(rpcClient);

      const success = await discovery.setCachedEndpoint('http://127.0.0.1:55557');
      expect(success).toBe(false);
    });

    it('should return false when the server is not @enbox/dwn-server', async () => {
      const rpcClient = createRpcStub('invalid');
      const discovery = new LocalDwnDiscovery(rpcClient);

      const success = await discovery.setCachedEndpoint('http://127.0.0.1:55557');
      expect(success).toBe(false);
    });

    it('should normalize trailing slashes', async () => {
      const rpcClient = createRpcStub('valid');
      const discovery = new LocalDwnDiscovery(rpcClient);

      await discovery.setCachedEndpoint('http://127.0.0.1:55557/');
      const endpoint = await discovery.getEndpoint();

      expect(endpoint).toBe('http://127.0.0.1:55557');
    });
  });

  // ─── clearCache ───────────────────────────────────────────────

  describe('clearCache', () => {
    it('should force fresh discovery on the next getEndpoint call', async () => {
      const rpcClient = createRpcStub('valid');
      const discoveryFile = createDiscoveryFileStub({
        endpoint : 'http://127.0.0.1:55557',
        pid      : 12345,
      });
      const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);

      await discovery.getEndpoint();
      discovery.clearCache();
      await discovery.getEndpoint();

      // Two validation calls: one before and one after cache clear.
      expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(2);
    });

    it('should clear a previously cached positive result', async () => {
      const rpcClient = createRpcStub('valid');
      const discovery = new LocalDwnDiscovery(rpcClient);

      // Inject an endpoint via setCachedEndpoint.
      await discovery.setCachedEndpoint('http://127.0.0.1:55557');
      const first = await discovery.getEndpoint();
      expect(first).toBe('http://127.0.0.1:55557');

      // Clear the cache. Without a discovery file, getEndpoint returns undefined.
      discovery.clearCache();
      const second = await discovery.getEndpoint();
      expect(second).toBeUndefined();
    });
  });
});
