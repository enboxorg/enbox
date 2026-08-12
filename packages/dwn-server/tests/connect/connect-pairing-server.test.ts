import type { ConnectPairingResult } from '../../src/connect/connect-pairing-server.js';

import { useFakeTimers } from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { ConnectPairingServer } from '../../src/connect/connect-pairing-server.js';
import { createMigratedInMemoryDialect } from '../utils.js';

const publicKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const nonce = '__________________________________________8';
const commitment = 'dHsifoINpJTsDquTwQTeVZPHPTCykyEs2rVUJ8acBzw';
const firstWalletCapability = publicKey;
const secondWalletCapability = nonce;

function requireOk<T extends object>(result: ConnectPairingResult<T>): { status: 'ok' } & T {
  if (result.status !== 'ok') {
    throw new Error(`Expected an ok result, received '${result.status}'.`);
  }
  return result;
}

describe('ConnectPairingServer', () => {
  let server: ConnectPairingServer;

  beforeAll(async () => {
    server = await ConnectPairingServer.create({
      baseUrl    : 'https://relay.example',
      sqlDialect : await createMigratedInMemoryDialect(),
    });
  });

  afterAll(() => {
    server.close();
  });

  it('should atomically admit only the first wallet claim', async () => {
    const pairing = requireOk(await server.create(commitment));
    const results = await Promise.all([
      server.claim(pairing.pairing_id, commitment, 'https://first-wallet.example', firstWalletCapability),
      server.claim(pairing.pairing_id, commitment, 'https://second-wallet.example', secondWalletCapability),
    ]);

    expect(results.filter((result): boolean => result.status === 'ok')).toHaveLength(1);
    expect(results.filter((result): boolean => result.status === 'already-claimed')).toHaveLength(1);

    const claim = requireOk(await server.pollClaim(pairing.pairing_id, pairing.client_capability));
    const winner = results.find((result): boolean => result.status === 'ok');
    expect(claim.wallet_origin).toBe(winner?.status === 'ok' ? winner.wallet_origin : undefined);
    expect(claim.relay_origin).toBe('https://relay.example');
  });

  it('should return the same claim metadata when a wallet retries with its capability', async () => {
    const pairing = requireOk(await server.create(commitment));
    const first = requireOk(await server.claim(
      pairing.pairing_id,
      commitment,
      'https://wallet.example',
      firstWalletCapability,
    ));
    const retried = requireOk(await server.claim(
      pairing.pairing_id,
      commitment,
      'https://wallet.example',
      firstWalletCapability,
    ));

    expect(retried).toEqual(first);
  });

  it('should validate commitments and release each reveal only after it is published', async () => {
    const pairing = requireOk(await server.create(commitment));
    requireOk(await server.claim(
      pairing.pairing_id,
      commitment,
      'https://wallet.example',
      firstWalletCapability,
    ));

    expect((await server.putReveal(pairing.pairing_id, 'client', pairing.client_capability, {
      nonce      : publicKey,
      public_key : publicKey,
    })).status).toBe('commitment-mismatch');
    expect((await server.putReveal(pairing.pairing_id, 'client', pairing.client_capability, {
      nonce,
      public_key: publicKey,
    })).status).toBe('ok');
    expect(requireOk(await server.getReveal(pairing.pairing_id, 'client', firstWalletCapability)).public_key)
      .toBe(publicKey);
    expect((await server.getReveal(pairing.pairing_id, 'wallet', pairing.client_capability)).status).toBe('pending');

    expect((await server.putReveal(pairing.pairing_id, 'wallet', firstWalletCapability, {
      nonce,
      public_key: publicKey,
    })).status).toBe('ok');
    expect(requireOk(await server.getReveal(pairing.pairing_id, 'wallet', pairing.client_capability))).toMatchObject({
      key_commitment : commitment,
      nonce,
      public_key     : publicKey,
      relay_origin   : 'https://relay.example',
      wallet_origin  : 'https://wallet.example',
    });
  });

  it('should enforce capabilities, frame order, and idempotent reads', async () => {
    const pairing = requireOk(await server.create(commitment));
    await server.claim(pairing.pairing_id, commitment, 'https://wallet.example', firstWalletCapability);
    await server.putReveal(pairing.pairing_id, 'client', pairing.client_capability, { nonce, public_key: publicKey });
    await server.putReveal(pairing.pairing_id, 'wallet', firstWalletCapability, { nonce, public_key: publicKey });

    expect((await server.putFrame(pairing.pairing_id, 'wallet', firstWalletCapability, {
      frame : 'early',
      stage : 'decision',
    })).status).toBe('invalid-state');
    expect((await server.getFrame(
      pairing.pairing_id,
      'wallet',
      pairing.client_capability,
      'decision',
    )).status).toBe('pending');
    expect((await server.putFrame(pairing.pairing_id, 'client', firstWalletCapability, {
      frame : 'request',
      stage : 'request',
    })).status).toBe('unauthorized');

    expect((await server.putFrame(pairing.pairing_id, 'client', pairing.client_capability, {
      frame : 'request',
      stage : 'request',
    })).status).toBe('ok');
    expect((await server.getFrame(pairing.pairing_id, 'client', firstWalletCapability, 'request')).status).toBe('ok');
    expect((await server.getFrame(pairing.pairing_id, 'client', firstWalletCapability, 'request')).status).toBe('ok');

    expect((await server.putFrame(pairing.pairing_id, 'wallet', firstWalletCapability, {
      frame : 'signed-encrypted-decision',
      stage : 'decision',
    })).status).toBe('ok');
    expect((await server.getFrame(pairing.pairing_id, 'wallet', pairing.client_capability, 'decision')).status).toBe('ok');
    expect((await server.putFrame(pairing.pairing_id, 'client', pairing.client_capability, {
      frame : 'confirmation',
      stage : 'confirmation',
    })).status).toBe('ok');
  });

  it('should complete the approved frame sequence', async () => {
    const pairing = requireOk(await server.create(commitment));
    await server.claim(pairing.pairing_id, commitment, 'https://wallet.example', firstWalletCapability);
    await server.putReveal(pairing.pairing_id, 'client', pairing.client_capability, { nonce, public_key: publicKey });
    await server.putReveal(pairing.pairing_id, 'wallet', firstWalletCapability, { nonce, public_key: publicKey });

    const frames = [
      ['client', 'request', 'request'],
      ['wallet', 'decision', 'decision'],
      ['client', 'confirmation', 'confirmation'],
      ['wallet', 'response', 'response'],
    ] as const;

    for (const [direction, stage, frame] of frames) {
      const capability = direction === 'client' ? pairing.client_capability : firstWalletCapability;
      const peerCapability = direction === 'client' ? firstWalletCapability : pairing.client_capability;
      expect((await server.putFrame(pairing.pairing_id, direction, capability, { frame, stage })).status).toBe('ok');
      expect((await server.getFrame(pairing.pairing_id, direction, peerCapability, stage)).status).toBe('ok');
    }
  });

  it('should reject insecure wallet origins', async () => {
    const pairing = requireOk(await server.create(commitment));
    await expect(server.claim(pairing.pairing_id, commitment, 'http://wallet.example', firstWalletCapability))
      .rejects.toThrow('wallet origin must be an HTTPS origin');
  });

  it('should require a canonical relay origin', async () => {
    const sqlDialect = await createMigratedInMemoryDialect();
    for (const baseUrl of [
      'https://user:password@relay.example',
      'https://relay.example/connect',
      'https://relay.example?tenant=secret',
    ]) {
      await expect(ConnectPairingServer.create({ baseUrl, sqlDialect }))
        .rejects.toThrow('baseUrl must be a canonical origin');
    }
  });

  it('should expire pairings after ten minutes', async () => {
    const clock = useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pairing = requireOk(await server.create(commitment));
      await clock.tickAsync(ConnectPairingServer.ttlInSeconds * 1000);

      expect((await server.pollClaim(pairing.pairing_id, pairing.client_capability)).status).toBe('unauthorized');
      expect((await server.claim(
        pairing.pairing_id,
        commitment,
        'https://wallet.example',
        firstWalletCapability,
      )).status).toBe('not-found');
    } finally {
      clock.restore();
    }
  });
});
