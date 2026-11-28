import type { ConnectRequest } from '../src/types.js';
import type { Jwk } from '@enbox/crypto';

import sinon from 'sinon';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { afterEach, describe, expect, it } from 'bun:test';
import { CryptoUtils, X25519 } from '@enbox/crypto';

import {
  buildVerificationGrid,
  CONNECT_VERIFICATION_GRID_SIZE,
  CONNECT_VERIFICATION_SYMBOL_COUNT,
  CONNECT_VERIFICATION_SYMBOLS,
  createConnectVerificationHandshake,
  deriveConnectVerificationSymbols,
  formatVerificationLabels,
  formatVerificationSymbols,
  verifyVerificationSelection,
} from '../src/sas.js';

async function createSampleTranscript(): Promise<{
  appPrivateKey: Jwk;
  appPublicKey: Jwk;
  walletPrivateKey: Jwk;
  walletPublicKey: Jwk;
  request: ConnectRequest;
  requestJwe: string;
}> {
  const clientDid = await DidJwk.create();
  const appPrivateKey = await X25519.generateKey();
  const appPublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: appPrivateKey.x };
  const walletPrivateKey = await X25519.generateKey();
  const walletPublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: walletPrivateKey.x };

  const request: ConnectRequest = {
    clientDid           : clientDid.uri,
    appName             : 'SAS Test App',
    permissionRequests  : [],
    supportedDidMethods : ['did:dht', 'did:jwk'],
    nonce               : Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url(),
    state               : Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url(),
    responseKey         : appPublicKey,
    reply               : { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' },
  };

  return {
    appPrivateKey,
    appPublicKey,
    walletPrivateKey,
    walletPublicKey,
    request,
    requestJwe: 'header..iv.ciphertext.tag',
  };
}

describe('Connect SAS verification', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('CONNECT_VERIFICATION_SYMBOLS palette', () => {
    it('contains 64 symbols with sequential IDs, unique emojis, and unique labels', () => {
      expect(CONNECT_VERIFICATION_SYMBOLS).toHaveLength(64);
      const emojis = new Set<string>();
      const labels = new Set<string>();
      for (let i = 0; i < CONNECT_VERIFICATION_SYMBOLS.length; i++) {
        const entry = CONNECT_VERIFICATION_SYMBOLS[i];
        expect(entry.id).toBe(i);
        expect(entry.emoji.length).toBeGreaterThan(0);
        expect(entry.label.length).toBeGreaterThan(0);
        emojis.add(entry.emoji);
        labels.add(entry.label);
      }
      expect(emojis.size).toBe(64);
      expect(labels.size).toBe(64);
    });
  });

  describe('deriveConnectVerificationSymbols', () => {
    it('derives the exact same 3 distinct symbols on both app and wallet sides', async () => {
      const {
        appPrivateKey,
        appPublicKey,
        walletPrivateKey,
        walletPublicKey,
        request,
        requestJwe,
      } = await createSampleTranscript();

      const appSymbols = await deriveConnectVerificationSymbols({
        privateKey    : appPrivateKey,
        peerPublicKey : walletPublicKey,
        requestJwe,
        state         : request.state,
        nonce         : request.nonce,
        responseKey   : appPublicKey,
        walletEpk     : walletPublicKey,
      });

      const walletSymbols = await deriveConnectVerificationSymbols({
        privateKey    : walletPrivateKey,
        peerPublicKey : appPublicKey,
        requestJwe,
        state         : request.state,
        nonce         : request.nonce,
        responseKey   : appPublicKey,
        walletEpk     : walletPublicKey,
      });

      expect(appSymbols).toHaveLength(CONNECT_VERIFICATION_SYMBOL_COUNT);
      expect(appSymbols).toEqual(walletSymbols);
      const ids = new Set(appSymbols.map((s): number => s.id));
      expect(ids.size).toBe(CONNECT_VERIFICATION_SYMBOL_COUNT);
    });

    it('binds requestJwe, state, nonce, and both public keys into the derived symbols', async () => {
      const {
        appPrivateKey,
        appPublicKey,
        walletPublicKey,
        request,
        requestJwe,
      } = await createSampleTranscript();

      const baseParams = {
        privateKey    : appPrivateKey,
        peerPublicKey : walletPublicKey,
        requestJwe,
        state         : request.state,
        nonce         : request.nonce,
        responseKey   : appPublicKey,
        walletEpk     : walletPublicKey,
      };
      const base = await deriveConnectVerificationSymbols(baseParams);
      const otherKey = await X25519.generateKey();
      const otherPublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: otherKey.x };

      const variants = [
        await deriveConnectVerificationSymbols({ ...baseParams, requestJwe: 'different..jwe.body.tag' }),
        await deriveConnectVerificationSymbols({ ...baseParams, state: 'different-state-token' }),
        await deriveConnectVerificationSymbols({ ...baseParams, nonce: 'different-nonce-token' }),
        await deriveConnectVerificationSymbols({ ...baseParams, peerPublicKey: otherPublicKey, walletEpk: otherPublicKey }),
        await deriveConnectVerificationSymbols({ ...baseParams, responseKey: otherPublicKey }),
      ];

      // At least 4 of 5 independent transcript mutations must produce distinct 3-symbol tuples
      // (collision probability for any pair is 1 / (64*63*62) ≈ 4e-6).
      for (const variant of variants) {
        expect(variant).not.toEqual(base);
      }
    });

    it('rejects an all-zero X25519 shared secret per RFC 7748', async () => {
      const {
        appPrivateKey,
        appPublicKey,
        walletPublicKey,
        request,
        requestJwe,
      } = await createSampleTranscript();

      sinon.stub(X25519, 'sharedSecret').resolves(new Uint8Array(32));

      await expect(deriveConnectVerificationSymbols({
        privateKey    : appPrivateKey,
        peerPublicKey : walletPublicKey,
        requestJwe,
        state         : request.state,
        nonce         : request.nonce,
        responseKey   : appPublicKey,
        walletEpk     : walletPublicKey,
      })).rejects.toThrow('must not be all zeros');
    });

    it('rejects invalid private or public keys', async () => {
      const {
        appPrivateKey,
        appPublicKey,
        walletPublicKey,
        request,
        requestJwe,
      } = await createSampleTranscript();

      const baseParams = {
        privateKey    : appPrivateKey,
        peerPublicKey : walletPublicKey,
        requestJwe,
        state         : request.state,
        nonce         : request.nonce,
        responseKey   : appPublicKey,
        walletEpk     : walletPublicKey,
      };

      // Missing private `d` parameter
      await expect(deriveConnectVerificationSymbols({ ...baseParams, privateKey: appPublicKey }))
        .rejects.toThrow('X25519 OKP JWK');

      // Wrong curve on private key
      await expect(deriveConnectVerificationSymbols({
        ...baseParams,
        privateKey: { kty: 'OKP', crv: 'Ed25519', d: 'abc', x: 'def' },
      })).rejects.toThrow('X25519 OKP JWK');

      // Private key passed as peerPublicKey
      await expect(deriveConnectVerificationSymbols({ ...baseParams, peerPublicKey: appPrivateKey }))
        .rejects.toThrow('X25519 public JWK');
    });
  });

  describe('buildVerificationGrid', () => {
    it('returns 9 distinct symbols containing all 3 targets', () => {
      const targets = [
        CONNECT_VERIFICATION_SYMBOLS[5],
        CONNECT_VERIFICATION_SYMBOLS[20],
        CONNECT_VERIFICATION_SYMBOLS[63],
      ];
      const grid = buildVerificationGrid(targets);

      expect(grid).toHaveLength(CONNECT_VERIFICATION_GRID_SIZE);
      const ids = new Set(grid.map((s): number => s.id));
      expect(ids.size).toBe(CONNECT_VERIFICATION_GRID_SIZE);
      for (const target of targets) {
        expect(ids.has(target.id)).toBe(true);
      }
    });

    it('rejects wrong target counts, duplicate targets, or out-of-range IDs', () => {
      expect(() => buildVerificationGrid([CONNECT_VERIFICATION_SYMBOLS[0], CONNECT_VERIFICATION_SYMBOLS[1]]))
        .toThrow('requires exactly 3 target symbols');
      expect(() => buildVerificationGrid([
        CONNECT_VERIFICATION_SYMBOLS[0],
        CONNECT_VERIFICATION_SYMBOLS[0],
        CONNECT_VERIFICATION_SYMBOLS[1],
      ])).toThrow('distinct symbols');
      expect(() => buildVerificationGrid([
        CONNECT_VERIFICATION_SYMBOLS[0],
        CONNECT_VERIFICATION_SYMBOLS[1],
        { id: 99, emoji: '❓', label: 'Invalid' },
      ])).toThrow('distinct symbols');
    });
  });

  describe('verifyVerificationSelection', () => {
    const targets = [
      CONNECT_VERIFICATION_SYMBOLS[2],
      CONNECT_VERIFICATION_SYMBOLS[18],
      CONNECT_VERIFICATION_SYMBOLS[45],
    ];

    it('accepts the exact 3 targets in any order', () => {
      expect(verifyVerificationSelection([2, 18, 45], targets)).toBe(true);
      expect(verifyVerificationSelection([45, 2, 18], targets)).toBe(true);
      expect(verifyVerificationSelection([18, 45, 2], targets)).toBe(true);
    });

    it('rejects wrong counts, duplicates, or non-matching selections', () => {
      expect(verifyVerificationSelection([2, 18], targets)).toBe(false);
      expect(verifyVerificationSelection([2, 18, 45, 0], targets)).toBe(false);
      expect(verifyVerificationSelection([2, 2, 18], targets)).toBe(false);
      expect(verifyVerificationSelection([2, 18, 44], targets)).toBe(false);
      expect(verifyVerificationSelection([2, 18, 45], targets.slice(0, 2))).toBe(false);
    });
  });

  describe('createConnectVerificationHandshake & formatting', () => {
    it('creates a public-only walletEpk, matching symbols with app side, 3x3 grid, and working verifier', async () => {
      const { appPrivateKey, appPublicKey, request, requestJwe } = await createSampleTranscript();

      const handshake = await createConnectVerificationHandshake({ request, requestJwe });

      expect(handshake.walletEpk.kty).toBe('OKP');
      expect(handshake.walletEpk.crv).toBe('X25519');
      expect(handshake.walletEpk.d).toBeUndefined();
      expect(handshake.symbols).toHaveLength(3);
      expect(handshake.grid).toHaveLength(9);

      const appSymbols = await deriveConnectVerificationSymbols({
        privateKey    : appPrivateKey,
        peerPublicKey : handshake.walletEpk,
        requestJwe,
        state         : request.state,
        nonce         : request.nonce,
        responseKey   : appPublicKey,
        walletEpk     : handshake.walletEpk,
      });

      expect(appSymbols).toEqual(handshake.symbols);
      expect(handshake.verifySelection([appSymbols[2].id, appSymbols[0].id, appSymbols[1].id])).toBe(true);
      const decoy = handshake.grid.find((item): boolean => !appSymbols.some((s): boolean => s.id === item.id))!;
      expect(handshake.verifySelection([appSymbols[0].id, appSymbols[1].id, decoy.id])).toBe(false);

      const expectedFormatted = [
        `${appSymbols[0].emoji} ${appSymbols[0].label}`,
        `${appSymbols[1].emoji} ${appSymbols[1].label}`,
        `${appSymbols[2].emoji} ${appSymbols[2].label}`,
      ].join(' · ');
      expect(formatVerificationSymbols(appSymbols)).toBe(expectedFormatted);
      expect(formatVerificationLabels(appSymbols)).toBe(
        `${appSymbols[0].label} · ${appSymbols[1].label} · ${appSymbols[2].label}`,
      );
    });
  });
});
