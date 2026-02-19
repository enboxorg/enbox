import sinon from 'sinon';

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { DwnRegistrar } from '../src/dwn-registrar.js';

describe('DwnRegistrar', () => {
  beforeEach(() => {
    sinon.restore();
  });

  afterAll(() => {
    sinon.restore();
  });

  describe('hashAsHexString', () => {
    it('should return the correct SHA-256 hex for a known input', async () => {
      // SHA-256 of empty string is well-known
      const hash = await DwnRegistrar.hashAsHexString('');
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should return a 64-character lowercase hex string', async () => {
      const hash = await DwnRegistrar.hashAsHexString('hello world');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should return different hashes for different inputs', async () => {
      const hash1 = await DwnRegistrar.hashAsHexString('input-a');
      const hash2 = await DwnRegistrar.hashAsHexString('input-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateNonce', () => {
    it('should return a 64-character uppercase hex string', async () => {
      const nonce = await DwnRegistrar.generateNonce();
      expect(nonce).toHaveLength(64);
      expect(nonce).toMatch(/^[0-9A-F]{64}$/);
    });

    it('should return different values on successive calls', async () => {
      const nonce1 = await DwnRegistrar.generateNonce();
      const nonce2 = await DwnRegistrar.generateNonce();
      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe('findQualifiedResponseNonce', () => {
    it('should return a nonce that satisfies the difficulty requirement', async () => {
      // Use a very high maximum (easiest difficulty) so it resolves quickly.
      const maximumAllowedHashValue = 'f'.repeat(64);

      // Suppress console.log output from the method.
      sinon.stub(console, 'log');

      const nonce = await DwnRegistrar.findQualifiedResponseNonce({
        maximumAllowedHashValue,
        challengeNonce : 'challenge-nonce',
        requestData    : 'request-data',
      });

      expect(nonce).toHaveLength(64);
      expect(nonce).toMatch(/^[0-9A-F]{64}$/);
    });

    it('should produce a hash within the difficulty bound', async () => {
      const maximumAllowedHashValue = 'f'.repeat(64);
      const challengeNonce = 'test-challenge';
      const requestData = 'test-request';

      sinon.stub(console, 'log');

      const responseNonce = await DwnRegistrar.findQualifiedResponseNonce({
        maximumAllowedHashValue,
        challengeNonce,
        requestData,
      });

      // Verify the proof-of-work contract: hash(challenge + response + data) <= maximum
      const computedHash = await DwnRegistrar.hashAsHexString(
        challengeNonce + responseNonce + requestData
      );
      const computedBigInt = BigInt(`0x${computedHash}`);
      const maximumBigInt = BigInt(`0x${maximumAllowedHashValue}`);

      expect(computedBigInt <= maximumBigInt).toBe(true);
    });

    it('should find a nonce even with moderate difficulty', async () => {
      // Set a maximum that's roughly half the hash space — should resolve within a few iterations.
      const maximumAllowedHashValue = '7' + 'f'.repeat(63);

      sinon.stub(console, 'log');

      const nonce = await DwnRegistrar.findQualifiedResponseNonce({
        maximumAllowedHashValue,
        challengeNonce : 'moderate-challenge',
        requestData    : 'moderate-data',
      });

      // Verify the result satisfies the constraint.
      const computedHash = await DwnRegistrar.hashAsHexString(
        'moderate-challenge' + nonce + 'moderate-data'
      );
      const computedBigInt = BigInt(`0x${computedHash}`);
      const maximumBigInt = BigInt(`0x${maximumAllowedHashValue}`);

      expect(computedBigInt <= maximumBigInt).toBe(true);
    });
  });

  describe('registerTenant', () => {
    it('should make three fetch calls with correct URLs', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      sinon.stub(console, 'log');

      // Stub the terms-of-service GET
      fetchStub.onFirstCall().resolves(new Response('Terms of Service text', { status: 200 }));

      // Stub the proof-of-work GET
      fetchStub.onSecondCall().resolves(new Response(JSON.stringify({
        challengeNonce          : 'test-challenge-nonce',
        maximumAllowedHashValue : 'f'.repeat(64), // easiest difficulty
      }), {
        status  : 200,
        headers : { 'Content-Type': 'application/json' },
      }));

      // Stub the registration POST
      fetchStub.onThirdCall().resolves(new Response('OK', { status: 200 }));

      await DwnRegistrar.registerTenant('https://dwn.example.com', 'did:example:alice');

      expect(fetchStub.callCount).toBe(3);

      // Verify the URLs
      expect(fetchStub.firstCall.args[0]).toBe('https://dwn.example.com/registration/terms-of-service');
      expect(fetchStub.secondCall.args[0]).toBe('https://dwn.example.com/registration/proof-of-work');
      expect(fetchStub.thirdCall.args[0]).toBe('https://dwn.example.com/registration');
    });

    it('should POST the correct registration request body', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      sinon.stub(console, 'log');

      const termsOfServiceText = 'You agree to our terms.';
      const did = 'did:example:bob';

      // Stub the terms-of-service GET
      fetchStub.onFirstCall().resolves(new Response(termsOfServiceText, { status: 200 }));

      // Stub the proof-of-work GET
      fetchStub.onSecondCall().resolves(new Response(JSON.stringify({
        challengeNonce          : 'fixed-challenge',
        maximumAllowedHashValue : 'f'.repeat(64),
      }), {
        status  : 200,
        headers : { 'Content-Type': 'application/json' },
      }));

      // Stub the registration POST
      fetchStub.onThirdCall().resolves(new Response('OK', { status: 200 }));

      await DwnRegistrar.registerTenant('https://dwn.example.com', did);

      // Verify the POST request body shape
      const postCallArgs = fetchStub.thirdCall.args[1];
      expect(postCallArgs!.method).toBe('POST');
      expect(postCallArgs!.headers).toEqual({ 'Content-Type': 'application/json' });

      const requestBody = JSON.parse(postCallArgs!.body as string);
      expect(requestBody.registrationData.did).toBe(did);
      expect(requestBody.registrationData.termsOfServiceHash).toBe(
        await DwnRegistrar.hashAsHexString(termsOfServiceText)
      );
      expect(requestBody.proofOfWork.challengeNonce).toBe('fixed-challenge');
      expect(typeof requestBody.proofOfWork.responseNonce).toBe('string');
      expect(requestBody.proofOfWork.responseNonce).toHaveLength(64);
    });

    it('should throw when terms-of-service fetch returns non-200', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      fetchStub.onFirstCall().resolves(new Response('Not Found', {
        status     : 404,
        statusText : 'Not Found',
      }));

      await expect(
        DwnRegistrar.registerTenant('https://dwn.example.com', 'did:example:alice')
      ).rejects.toThrow('Failed fetching terms-of-service: 404 Not Found: Not Found');
    });

    it('should throw when registration POST returns non-200', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      sinon.stub(console, 'log');

      // Stub the terms-of-service GET — success
      fetchStub.onFirstCall().resolves(new Response('Terms', { status: 200 }));

      // Stub the proof-of-work GET — success
      fetchStub.onSecondCall().resolves(new Response(JSON.stringify({
        challengeNonce          : 'challenge',
        maximumAllowedHashValue : 'f'.repeat(64),
      }), {
        status  : 200,
        headers : { 'Content-Type': 'application/json' },
      }));

      // Stub the registration POST — failure
      fetchStub.onThirdCall().resolves(new Response('Server Error', {
        status     : 500,
        statusText : 'Internal Server Error',
      }));

      await expect(
        DwnRegistrar.registerTenant('https://dwn.example.com', 'did:example:alice')
      ).rejects.toThrow('Registration failed: 500 Internal Server Error: Server Error');
    });

    it('should handle endpoint URLs with trailing slashes', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      sinon.stub(console, 'log');

      fetchStub.onFirstCall().resolves(new Response('Terms', { status: 200 }));
      fetchStub.onSecondCall().resolves(new Response(JSON.stringify({
        challengeNonce          : 'challenge',
        maximumAllowedHashValue : 'f'.repeat(64),
      }), {
        status  : 200,
        headers : { 'Content-Type': 'application/json' },
      }));
      fetchStub.onThirdCall().resolves(new Response('OK', { status: 200 }));

      await DwnRegistrar.registerTenant('https://dwn.example.com/', 'did:example:alice');

      // Should not have double slashes in URLs
      expect(fetchStub.firstCall.args[0]).toBe('https://dwn.example.com/registration/terms-of-service');
      expect(fetchStub.secondCall.args[0]).toBe('https://dwn.example.com/registration/proof-of-work');
      expect(fetchStub.thirdCall.args[0]).toBe('https://dwn.example.com/registration');
    });
  });
});
