import type { ConnectRequest } from '../src/types.js';
import type { Jwk } from '@enbox/crypto';

import { DidJwk } from '@enbox/dids';
import { X25519 } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';

import {
  CONNECT_VERIFICATION_SYMBOL_COUNT,
  CONNECT_VERIFICATION_SYMBOLS,
  createConnectVerificationHandshake,
  deriveConnectVerificationSymbols,
  formatVerificationSymbols,
} from '../src/sas.js';

/** RFC 7748 §6.1 low-order X25519 public key (32 zero bytes) producing an all-zero shared secret. */
const LOW_ORDER_X25519_PUBLIC_KEY: Jwk = {
  kty : 'OKP',
  crv : 'X25519',
  x   : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

async function createDeterministicKeys(): Promise<{
  appPrivateKey: Jwk;
  appPublicKey: Jwk;
  walletPrivateKey: Jwk;
  walletPublicKey: Jwk;
  otherPrivateKey: Jwk;
  otherPublicKey: Jwk;
}> {
  const fromSeed = async (seed: number): Promise<{ privateKey: Jwk; publicKey: Jwk }> => {
    const privateKey = await X25519.bytesToPrivateKey({ privateKeyBytes: new Uint8Array(32).fill(seed) });
    const publicKey = await X25519.computePublicKey({ key: privateKey });
    return { privateKey, publicKey };
  };
  const app = await fromSeed(0x11);
  const wallet = await fromSeed(0x22);
  const other = await fromSeed(0x33);
  return {
    appPrivateKey    : app.privateKey,
    appPublicKey     : app.publicKey,
    walletPrivateKey : wallet.privateKey,
    walletPublicKey  : wallet.publicKey,
    otherPrivateKey  : other.privateKey,
    otherPublicKey   : other.publicKey,
  };
}

describe('Connect SAS verification', () => {
  describe('CONNECT_VERIFICATION_SYMBOLS palette', () => {
    it('contains 64 Emoji_Presentation symbols with sequential IDs, unique emojis, and unique labels', () => {
      expect(CONNECT_VERIFICATION_SYMBOLS).toHaveLength(64);
      const emojis = new Set<string>();
      const labels = new Set<string>();
      for (let i = 0; i < CONNECT_VERIFICATION_SYMBOLS.length; i++) {
        const entry = CONNECT_VERIFICATION_SYMBOLS[i];
        expect(entry.id).toBe(i);
        expect(/\p{Emoji_Presentation}/u.test(entry.emoji)).toBe(true);
        expect(entry.label.length).toBeGreaterThan(0);
        emojis.add(entry.emoji);
        labels.add(entry.label);
      }
      expect(emojis.size).toBe(64);
      expect(labels.size).toBe(64);
    });
  });

  describe('deriveConnectVerificationSymbols', () => {
    it('derives the same deterministic 3 distinct symbols on both app and wallet sides (golden vector)', async () => {
      const { appPrivateKey, appPublicKey, walletPrivateKey, walletPublicKey } = await createDeterministicKeys();
      const shared = {
        requestJwe  : 'header..iv.ciphertext.tag',
        state       : 'fixed-state-token-0001',
        nonce       : 'fixed-nonce-token-0001',
        responseKey : appPublicKey,
        walletEpk   : walletPublicKey,
      };

      const appSymbols = await deriveConnectVerificationSymbols({ ...shared, privateKey: appPrivateKey });
      const walletSymbols = await deriveConnectVerificationSymbols({ ...shared, privateKey: walletPrivateKey });

      expect(appSymbols).toHaveLength(CONNECT_VERIFICATION_SYMBOL_COUNT);
      expect(appSymbols).toEqual(walletSymbols);
      expect(new Set(appSymbols.map((s): number => s.id)).size).toBe(CONNECT_VERIFICATION_SYMBOL_COUNT);
      // Pin the wire-format golden vector so KDF/transcript regressions fail loudly.
      expect(appSymbols.map((s): number => s.id)).toEqual([31, 23, 30]);
    });

    it('binds requestJwe, state, nonce, public keys, and NUL-separated fields unambiguously', async () => {
      const { appPrivateKey, appPublicKey, walletPublicKey, otherPrivateKey, otherPublicKey } = await createDeterministicKeys();
      const baseParams = {
        privateKey  : appPrivateKey,
        requestJwe  : 'header..iv.ciphertext.tag',
        state       : 'fixed-state-token-0001',
        nonce       : 'fixed-nonce-token-0001',
        responseKey : appPublicKey,
        walletEpk   : walletPublicKey,
      };
      const base = await deriveConnectVerificationSymbols(baseParams);

      const variants = [
        await deriveConnectVerificationSymbols({ ...baseParams, requestJwe: 'different..jwe.body.tag' }),
        await deriveConnectVerificationSymbols({ ...baseParams, state: 'different-state-token' }),
        await deriveConnectVerificationSymbols({ ...baseParams, nonce: 'different-nonce-token' }),
        await deriveConnectVerificationSymbols({ ...baseParams, walletEpk: otherPublicKey }),
        await deriveConnectVerificationSymbols({ ...baseParams, privateKey: otherPrivateKey, responseKey: otherPublicKey }),
      ];
      for (const variant of variants) {
        expect(variant).not.toEqual(base);
      }

      const nulA = await deriveConnectVerificationSymbols({ ...baseParams, state: 'a\u0000b', nonce: 'c' });
      const nulB = await deriveConnectVerificationSymbols({ ...baseParams, state: 'a', nonce: 'b\u0000c' });
      expect(nulA).not.toEqual(nulB);
    });

    it('rejects low-order X25519 peer keys, mismatched key pairs, and malformed JWKs', async () => {
      const { appPrivateKey, appPublicKey, walletPublicKey, otherPublicKey } = await createDeterministicKeys();
      const baseParams = {
        privateKey  : appPrivateKey,
        requestJwe  : 'header..iv.ciphertext.tag',
        state       : 'fixed-state-token-0001',
        nonce       : 'fixed-nonce-token-0001',
        responseKey : appPublicKey,
        walletEpk   : walletPublicKey,
      };

      // Real RFC 7748 low-order point (32 zero bytes) is rejected end-to-end.
      await expect(deriveConnectVerificationSymbols({
        ...baseParams,
        walletEpk: LOW_ORDER_X25519_PUBLIC_KEY,
      })).rejects.toThrow();

      await expect(deriveConnectVerificationSymbols({
        ...baseParams,
        responseKey: otherPublicKey,
      })).rejects.toThrow('does not match');

      for (const badPrivateKey of [
        appPublicKey,
        { kty: 'OKP', crv: 'Ed25519', d: 'abc', x: 'def' },
        { kty: 'OKP', crv: 'X25519', d: 'abc', x: appPublicKey.x },
      ] as Jwk[]) {
        await expect(deriveConnectVerificationSymbols({ ...baseParams, privateKey: badPrivateKey }))
          .rejects.toThrow('X25519 OKP JWK');
      }

      await expect(deriveConnectVerificationSymbols({ ...baseParams, walletEpk: appPrivateKey }))
        .rejects.toThrow('X25519 public JWK');
    });
  });

  describe('createConnectVerificationHandshake & formatting', () => {
    it('creates a public-only walletEpk, matching app symbols, 3x3 grid, and single-use verifier', async () => {
      const clientDid = await DidJwk.create();
      const appPrivateKey = await X25519.generateKey();
      const appPublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: appPrivateKey.x };
      const request: ConnectRequest = {
        clientDid           : clientDid.uri,
        appName             : 'SAS Test App',
        permissionRequests  : [],
        supportedDidMethods : ['did:dht', 'did:jwk'],
        nonce               : 'nonce-1234567890123456789012',
        state               : 'state-1234567890123456789012',
        responseKey         : appPublicKey,
        reply               : { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' },
      };
      const requestJwe = 'header..iv.ciphertext.tag';

      const handshake = await createConnectVerificationHandshake({ request, requestJwe });

      expect(handshake.walletEpk.kty).toBe('OKP');
      expect(handshake.walletEpk.crv).toBe('X25519');
      expect(handshake.walletEpk.d).toBeUndefined();
      expect(handshake.symbols).toHaveLength(3);
      expect(handshake.grid).toHaveLength(9);
      const gridIds = new Set(handshake.grid.map((s): number => s.id));
      expect(gridIds.size).toBe(9);
      for (const target of handshake.symbols) {
        expect(gridIds.has(target.id)).toBe(true);
      }

      const appSymbols = await deriveConnectVerificationSymbols({
        privateKey  : appPrivateKey,
        requestJwe,
        state       : request.state,
        nonce       : request.nonce,
        responseKey : appPublicKey,
        walletEpk   : handshake.walletEpk,
      });
      expect(appSymbols).toEqual(handshake.symbols);

      // Unordered exact match succeeds once, then single-attempt lockout rejects retries.
      expect(handshake.verifySelection([appSymbols[2].id, appSymbols[0].id, appSymbols[1].id])).toBe(true);
      expect(handshake.verifySelection([appSymbols[0].id, appSymbols[1].id, appSymbols[2].id])).toBe(false);

      // Invalid selections (decoy, wrong count, duplicate, NaN, out-of-range) fail and consume the single attempt.
      const decoy = handshake.grid.find(
        (item): boolean => !handshake.symbols.some((s): boolean => s.id === item.id),
      )!;
      for (const badSelection of [
        [handshake.symbols[0].id, handshake.symbols[1].id, decoy.id],
        [handshake.symbols[0].id, handshake.symbols[1].id],
        [handshake.symbols[0].id, handshake.symbols[0].id, handshake.symbols[1].id],
        [handshake.symbols[0].id, handshake.symbols[1].id, Number.NaN],
        [handshake.symbols[0].id, handshake.symbols[1].id, 99],
      ]) {
        const attempt = await createConnectVerificationHandshake({ request, requestJwe });
        expect(attempt.verifySelection(badSelection)).toBe(false);
        expect(attempt.verifySelection(attempt.symbols.map((s): number => s.id))).toBe(false);
      }

      expect(formatVerificationSymbols([
        CONNECT_VERIFICATION_SYMBOLS[0],
        CONNECT_VERIFICATION_SYMBOLS[1],
        CONNECT_VERIFICATION_SYMBOLS[2],
      ])).toBe('🐶 Dog · 🐱 Cat · 🦁 Lion');
    });
  });
});
