import { Convert } from '@enbox/common';
import { CryptoUtils } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';

import { buildWalletConnectUri, parseWalletConnectUri } from '../src/uri.js';

describe('wallet connect uri', () => {
  const requestUri = 'https://relay.example/connect/authorize/8b2f.jwt';

  it('should round-trip the request pointer and encryption key through the fragment', () => {
    const encryptionKey = CryptoUtils.randomBytes(32);

    const walletUri = buildWalletConnectUri({
      walletUri: 'https://wallet.example/connect/app',
      requestUri,
      encryptionKey,
    });
    const parsed = parseWalletConnectUri(walletUri);

    expect(parsed).toBeDefined();
    expect(parsed!.requestUri).toBe(requestUri);
    expect(parsed!.encryptionKey).toEqual(encryptionKey);
  });

  it('should carry connect parameters fragment-only', () => {
    const walletUri = buildWalletConnectUri({
      walletUri     : 'https://wallet.example/connect/app',
      requestUri,
      encryptionKey : CryptoUtils.randomBytes(32),
    });
    const parsed = new URL(walletUri);

    expect(parsed.search).toBe('');
    expect(parsed.hash).toContain('request_uri=');
    expect(parsed.hash).toContain('encryption_key=');
  });

  it('should support custom-scheme wallet uris', () => {
    const encryptionKey = CryptoUtils.randomBytes(32);
    const walletUri = buildWalletConnectUri({ walletUri: 'enbox://connect', requestUri, encryptionKey });

    const parsed = parseWalletConnectUri(walletUri);
    expect(parsed!.requestUri).toBe(requestUri);
    expect(parsed!.encryptionKey).toEqual(encryptionKey);
  });

  it('should reject building with a wrong-length encryption key', () => {
    expect(() => buildWalletConnectUri({
      walletUri     : 'https://wallet.example/connect/app',
      requestUri,
      encryptionKey : CryptoUtils.randomBytes(16),
    })).toThrow('must be 32 bytes');
  });

  it('should return undefined for a malformed uri', () => {
    expect(parseWalletConnectUri('not a url')).toBeUndefined();
  });

  it('should return undefined when the fragment parameters are missing', () => {
    expect(parseWalletConnectUri('https://wallet.example/connect/app')).toBeUndefined();
    expect(parseWalletConnectUri(`https://wallet.example/connect/app#request_uri=${encodeURIComponent(requestUri)}`)).toBeUndefined();
  });

  it('should ignore connect parameters carried in the query string', () => {
    const key = Convert.uint8Array(CryptoUtils.randomBytes(32)).toBase64Url();
    const uri = `https://wallet.example/connect/app?request_uri=${encodeURIComponent(requestUri)}&encryption_key=${key}`;

    expect(parseWalletConnectUri(uri)).toBeUndefined();
  });

  it('should return undefined for a non-base64url encryption key', () => {
    const uri = `https://wallet.example/connect/app#request_uri=${encodeURIComponent(requestUri)}&encryption_key=$$$$`;

    expect(parseWalletConnectUri(uri)).toBeUndefined();
  });

  it('should return undefined for a wrong-length encryption key', () => {
    const shortKey = Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url();
    const uri = `https://wallet.example/connect/app#request_uri=${encodeURIComponent(requestUri)}&encryption_key=${shortKey}`;

    expect(parseWalletConnectUri(uri)).toBeUndefined();
  });
});
