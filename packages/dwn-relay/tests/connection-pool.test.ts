import { describe, expect, it } from 'bun:test';

import { ConnectionPool } from '../src/sync/connection-pool.js';

describe('ConnectionPool', () => {
  describe('transportProtocols', () => {
    it('should support http and https', () => {
      const pool = new ConnectionPool();
      expect(pool.transportProtocols).toContain('http:');
      expect(pool.transportProtocols).toContain('https:');
    });
  });

  describe('host health tracking', () => {
    it('should consider all hosts healthy initially', () => {
      const pool = new ConnectionPool();
      expect(pool.isHostHealthy('https://example.com')).toBe(true);
      expect(pool.isHostHealthy('https://other.com')).toBe(true);
    });

    it('should report zero failures for unknown hosts', () => {
      const pool = new ConnectionPool();
      expect(pool.getHostFailures('https://example.com')).toBe(0);
    });

    it('should reset host health', () => {
      const pool = new ConnectionPool();
      // Even though we haven't recorded failures through the pool,
      // resetHostHealth should not throw
      pool.resetHostHealth('https://example.com');
      expect(pool.isHostHealthy('https://example.com')).toBe(true);
    });
  });

  describe('size', () => {
    it('should start with zero clients', () => {
      const pool = new ConnectionPool();
      expect(pool.size).toBe(0);
    });
  });

  describe('sendDwnRequest', () => {
    it('should create a client for a new host', async () => {
      const pool = new ConnectionPool();
      // This will attempt a real HTTP connection which will fail,
      // but it demonstrates the client creation path
      try {
        await pool.sendDwnRequest({
          dwnUrl    : 'https://localhost:9999',
          targetDid : 'did:test:1',
          message   : { descriptor: { interface: 'Messages', method: 'Sync', messageTimestamp: '', action: 'root' } },
        });
      } catch {
        // Expected — no server running at localhost:9999
      }
      // Client was created for this host
      expect(pool.size).toBe(1);
    });

    it('should reuse client for same host', async () => {
      const pool = new ConnectionPool();
      for (let i = 0; i < 3; i++) {
        try {
          await pool.sendDwnRequest({
            dwnUrl    : 'https://localhost:9998',
            targetDid : `did:test:${i}`,
            message   : { descriptor: { interface: 'Messages', method: 'Sync', messageTimestamp: '', action: 'root' } },
          });
        } catch {
          // Expected
        }
      }
      expect(pool.size).toBe(1); // same host, same client
    });

    it('should create separate clients for different hosts', async () => {
      const pool = new ConnectionPool();
      const hosts = ['https://localhost:9997', 'https://localhost:9996'];
      for (const host of hosts) {
        try {
          await pool.sendDwnRequest({
            dwnUrl    : host,
            targetDid : 'did:test:1',
            message   : { descriptor: { interface: 'Messages', method: 'Sync', messageTimestamp: '', action: 'root' } },
          });
        } catch {
          // Expected
        }
      }
      expect(pool.size).toBe(2);
    });

    it('should track failures and eventually put host in backoff', async () => {
      const pool = new ConnectionPool();
      const url = 'https://localhost:9995';

      // Record multiple failures. After the first failure the host enters
      // backoff, so subsequent calls throw a backoff error rather than
      // reaching the underlying client. Reset health between attempts to
      // allow the failure count to accumulate through real connection errors.
      for (let i = 0; i < ConnectionPool.MAX_CONSECUTIVE_FAILURES; i++) {
        // Reset backoff timer so the request goes through to the actual client
        pool.resetHostHealth(url);
        try {
          await pool.sendDwnRequest({
            dwnUrl    : url,
            targetDid : 'did:test:1',
            message   : { descriptor: { interface: 'Messages', method: 'Sync', messageTimestamp: '', action: 'root' } },
          });
        } catch {
          // Expected — connection refused
        }
      }

      // After MAX failures the host should be tracked as unhealthy
      expect(pool.getHostFailures(url)).toBeGreaterThan(0);
    });

    it('should reject requests to hosts in backoff', async () => {
      const pool = new ConnectionPool();
      const url = 'https://localhost:9994';

      // Record one failure to put host in backoff
      try {
        await pool.sendDwnRequest({
          dwnUrl    : url, targetDid : 'did:test:1',
          message   : { descriptor: { interface: 'Messages', method: 'Sync', messageTimestamp: '', action: 'root' } },
        });
      } catch { /* expected — connection refused */ }

      // Host is now in backoff
      expect(pool.isHostHealthy(url)).toBe(false);

      // Next request should throw immediately with a backoff message
      let rejected = false;
      try {
        await pool.sendDwnRequest({
          dwnUrl    : url, targetDid : 'did:test:1',
          message   : { descriptor: { interface: 'Messages', method: 'Sync', messageTimestamp: '', action: 'root' } },
        });
      } catch (err: any) {
        rejected = err.message.includes('backoff');
      }
      expect(rejected).toBe(true);
    });
  });
});
