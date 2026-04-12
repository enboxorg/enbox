import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Convert, MemoryStore } from '@enbox/common';

import { HdIdentityVault } from '../src/hd-identity-vault.js';
import { InMemorySecretStore, VaultBackedSecretStore } from '../src/secret-store.js';

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_PASSWORD = 'test-password';

/** Encode a string as Uint8Array for convenience. */
function toBytes(s: string): Uint8Array {
  return Convert.string(s).toUint8Array();
}

/** Decode Uint8Array back to a string. */
function fromBytes(b: Uint8Array): string {
  return Convert.uint8Array(b).toString();
}

/** Create an unlocked vault backed by an in-memory store. */
async function createUnlockedVault(): Promise<{
  vault: HdIdentityVault;
  vaultStore: MemoryStore<string, string>;
}> {
  const vaultStore = new MemoryStore<string, string>();
  const vault = new HdIdentityVault({ keyDerivationWorkFactor: 1, store: vaultStore });
  await vault.initialize({ password: TEST_PASSWORD });
  return { vault, vaultStore };
}

// ===========================================================================
//  InMemorySecretStore
// ===========================================================================

describe('SecretStore', () => {
  describe('InMemorySecretStore', () => {
    let store: InMemorySecretStore;

    beforeEach(() => {
      store = new InMemorySecretStore();
    });

    // ─── put / get ───────────────────────────────────────────────

    describe('put() and get()', () => {
      it('should round-trip a secret', async () => {
        const value = toBytes('my-secret-token');
        await store.put('token:server-1', value);

        const retrieved = await store.get('token:server-1');
        expect(retrieved).toBeDefined();
        expect(fromBytes(retrieved!)).toBe('my-secret-token');
      });

      it('should store binary data without corruption', async () => {
        const binary = new Uint8Array([0, 1, 127, 128, 255]);
        await store.put('binary-key', binary);

        const retrieved = await store.get('binary-key');
        expect(retrieved).toEqual(binary);
      });

      it('should overwrite an existing secret on re-put', async () => {
        await store.put('key', toBytes('first'));
        await store.put('key', toBytes('second'));

        const retrieved = await store.get('key');
        expect(fromBytes(retrieved!)).toBe('second');
      });

      it('should isolate stored values from the original buffer', async () => {
        const original = toBytes('original');
        await store.put('key', original);

        // Mutate the input buffer after put.
        original[0] = 0xFF;

        const retrieved = await store.get('key');
        expect(fromBytes(retrieved!)).toBe('original');
      });

      it('should isolate returned values from the internal store', async () => {
        await store.put('key', toBytes('value'));
        const first = await store.get('key');
        first![0] = 0xFF; // mutate returned buffer

        const second = await store.get('key');
        expect(fromBytes(second!)).toBe('value');
      });
    });

    // ─── get — missing key ───────────────────────────────────────

    describe('get() — missing key', () => {
      it('should return undefined for a non-existent key', async () => {
        const result = await store.get('does-not-exist');
        expect(result).toBeUndefined();
      });
    });

    // ─── delete ──────────────────────────────────────────────────

    describe('delete()', () => {
      it('should delete an existing secret and return true', async () => {
        await store.put('key', toBytes('value'));

        const deleted = await store.delete('key');
        expect(deleted).toBe(true);

        const after = await store.get('key');
        expect(after).toBeUndefined();
      });

      it('should return false for a non-existent key', async () => {
        const deleted = await store.delete('does-not-exist');
        expect(deleted).toBe(false);
      });
    });

    // ─── TTL / expiry ────────────────────────────────────────────

    describe('expiry (expiresAt)', () => {
      it('should return undefined and auto-delete when the secret has expired', async () => {
        const pastDate = new Date(Date.now() - 60_000).toISOString();
        await store.put('expired', toBytes('old'), { expiresAt: pastDate });

        const result = await store.get('expired');
        expect(result).toBeUndefined();

        // Verify it was actually deleted, not just skipped.
        const again = await store.get('expired');
        expect(again).toBeUndefined();
      });

      it('should return the secret when it has not yet expired', async () => {
        const futureDate = new Date(Date.now() + 60_000).toISOString();
        await store.put('valid', toBytes('still-good'), { expiresAt: futureDate });

        const result = await store.get('valid');
        expect(result).toBeDefined();
        expect(fromBytes(result!)).toBe('still-good');
      });

      it('should treat exactly-now as expired (boundary)', async () => {
        // Set expiresAt to a time that is definitely in the past by the time get() runs.
        const justPast = new Date(Date.now() - 1).toISOString();
        await store.put('boundary', toBytes('edge'), { expiresAt: justPast });

        const result = await store.get('boundary');
        expect(result).toBeUndefined();
      });

      it('should allow secrets without expiry to persist indefinitely', async () => {
        await store.put('no-ttl', toBytes('forever'));

        const result = await store.get('no-ttl');
        expect(fromBytes(result!)).toBe('forever');
      });
    });
  });

  // =========================================================================
  //  VaultBackedSecretStore
  // =========================================================================

  describe('VaultBackedSecretStore', () => {
    let vault: HdIdentityVault;
    let vaultStore: MemoryStore<string, string>;
    let backingStore: MemoryStore<string, string>;
    let store: VaultBackedSecretStore;

    beforeAll(async () => {
      ({ vault, vaultStore } = await createUnlockedVault());
    });

    beforeEach(async () => {
      backingStore = new MemoryStore<string, string>();
      store = new VaultBackedSecretStore({ vault, store: backingStore });

      // Ensure vault is unlocked before each test.
      if (vault.isLocked()) {
        await vault.unlock({ password: TEST_PASSWORD });
      }
    });

    afterAll(async () => {
      await vaultStore.close();
    });

    // ─── put / get ───────────────────────────────────────────────

    describe('put() and get()', () => {
      it('should round-trip a secret through vault encryption', async () => {
        const value = toBytes('registration-token-abc');
        await store.put('reg:server-1', value);

        const retrieved = await store.get('reg:server-1');
        expect(retrieved).toBeDefined();
        expect(fromBytes(retrieved!)).toBe('registration-token-abc');
      });

      it('should store binary data without corruption', async () => {
        const binary = new Uint8Array([0, 1, 127, 128, 255]);
        await store.put('binary-key', binary);

        const retrieved = await store.get('binary-key');
        expect(retrieved).toEqual(binary);
      });

      it('should overwrite an existing secret on re-put', async () => {
        await store.put('key', toBytes('first'));
        await store.put('key', toBytes('second'));

        const retrieved = await store.get('key');
        expect(fromBytes(retrieved!)).toBe('second');
      });

      it('should store different secrets under different keys', async () => {
        await store.put('key-a', toBytes('alpha'));
        await store.put('key-b', toBytes('bravo'));

        expect(fromBytes((await store.get('key-a'))!)).toBe('alpha');
        expect(fromBytes((await store.get('key-b'))!)).toBe('bravo');
      });
    });

    // ─── encryption at rest ──────────────────────────────────────

    describe('encryption at rest', () => {
      it('should store data as encrypted JWE in the backing store', async () => {
        await store.put('secret', toBytes('plaintext-value'));

        // Read the raw backing store entry — it should be a JSON envelope
        // containing a JWE, not the plaintext.
        const raw = await backingStore.get('secret');
        expect(raw).toBeDefined();
        expect(raw).not.toContain('plaintext-value');

        const envelope = JSON.parse(raw!);
        expect(envelope.jwe).toBeDefined();
        expect(typeof envelope.jwe).toBe('string');

        // Compact JWE has 5 dot-separated parts.
        const parts = envelope.jwe.split('.');
        expect(parts.length).toBe(5);
      });

      it('should persist expiresAt metadata alongside the JWE', async () => {
        const expiresAt = '2099-12-31T23:59:59.000Z';
        await store.put('expiring', toBytes('temp'), { expiresAt });

        const raw = await backingStore.get('expiring');
        const envelope = JSON.parse(raw!);
        expect(envelope.expiresAt).toBe(expiresAt);
      });

      it('should omit expiresAt when not provided', async () => {
        await store.put('no-ttl', toBytes('permanent'));

        const raw = await backingStore.get('no-ttl');
        const envelope = JSON.parse(raw!);
        expect(envelope.expiresAt).toBeUndefined();
      });
    });

    // ─── get — missing key ───────────────────────────────────────

    describe('get() — missing key', () => {
      it('should return undefined for a non-existent key', async () => {
        const result = await store.get('does-not-exist');
        expect(result).toBeUndefined();
      });
    });

    // ─── delete ──────────────────────────────────────────────────

    describe('delete()', () => {
      it('should delete an existing secret and return true', async () => {
        await store.put('key', toBytes('value'));

        const deleted = await store.delete('key');
        expect(deleted).toBe(true);

        const after = await store.get('key');
        expect(after).toBeUndefined();
      });

      it('should return false for a non-existent key', async () => {
        const deleted = await store.delete('does-not-exist');
        expect(deleted).toBe(false);
      });

      it('should not require the vault to be unlocked', async () => {
        await store.put('key', toBytes('value'));

        // Lock the vault.
        await vault.lock();

        // Delete should still work — it only touches the backing store.
        const deleted = await store.delete('key');
        expect(deleted).toBe(true);

        // Re-unlock for subsequent tests.
        await vault.unlock({ password: TEST_PASSWORD });
      });
    });

    // ─── TTL / expiry ────────────────────────────────────────────

    describe('expiry (expiresAt)', () => {
      it('should return undefined and auto-delete when the secret has expired', async () => {
        const pastDate = new Date(Date.now() - 60_000).toISOString();
        await store.put('expired', toBytes('old'), { expiresAt: pastDate });

        const result = await store.get('expired');
        expect(result).toBeUndefined();

        // Verify it was actually purged from the backing store.
        const raw = await backingStore.get('expired');
        expect(raw).toBeUndefined();
      });

      it('should return the secret when it has not yet expired', async () => {
        const futureDate = new Date(Date.now() + 60_000).toISOString();
        await store.put('valid', toBytes('still-good'), { expiresAt: futureDate });

        const result = await store.get('valid');
        expect(result).toBeDefined();
        expect(fromBytes(result!)).toBe('still-good');
      });
    });

    // ─── vault locked behavior ───────────────────────────────────

    describe('vault locked behavior', () => {
      afterEach(async () => {
        // Always re-unlock so other tests aren't affected.
        if (vault.isLocked()) {
          await vault.unlock({ password: TEST_PASSWORD });
        }
      });

      it('should throw on put() when the vault is locked', async () => {
        await vault.lock();

        await expect(
          store.put('key', toBytes('value'))
        ).rejects.toThrow('vault is locked');
      });

      it('should throw on get() when the vault is locked and the key exists', async () => {
        // Store a secret while unlocked.
        await store.put('key', toBytes('value'));

        await vault.lock();

        // get() must fail because decryption requires the vault CEK.
        await expect(
          store.get('key')
        ).rejects.toThrow('vault is locked');
      });

      it('should return undefined on get() when the vault is locked and key does not exist', async () => {
        await vault.lock();

        // No encrypted data to decrypt → undefined (not a throw).
        const result = await store.get('no-such-key');
        expect(result).toBeUndefined();
      });

      it('should allow delete() when the vault is locked', async () => {
        await store.put('key', toBytes('to-delete'));
        await vault.lock();

        const deleted = await store.delete('key');
        expect(deleted).toBe(true);
      });
    });

    // ─── vault unlock / re-read ──────────────────────────────────

    describe('vault unlock cycle', () => {
      it('should decrypt secrets after vault lock/unlock cycle', async () => {
        await store.put('persistent', toBytes('survives-lock'));

        // Lock and re-unlock.
        await vault.lock();
        await vault.unlock({ password: TEST_PASSWORD });

        const result = await store.get('persistent');
        expect(result).toBeDefined();
        expect(fromBytes(result!)).toBe('survives-lock');
      });
    });

    // ─── empty value ─────────────────────────────────────────────

    describe('edge cases', () => {
      it('should handle an empty Uint8Array value', async () => {
        await store.put('empty', new Uint8Array(0));

        const result = await store.get('empty');
        expect(result).toBeDefined();
        expect(result!.length).toBe(0);
      });

      it('should handle keys with special characters', async () => {
        const key = 'enbox:auth:registrationTokens:https://dwn.example.com/api';
        await store.put(key, toBytes('token'));

        const result = await store.get(key);
        expect(fromBytes(result!)).toBe('token');
      });

      it('should handle large values', async () => {
        const large = new Uint8Array(64 * 1024);
        for (let i = 0; i < large.length; i++) {
          large[i] = i % 256;
        }
        await store.put('large', large);

        const result = await store.get('large');
        expect(result).toEqual(large);
      });
    });
  });
});
