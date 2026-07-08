import type { LocalNodePairingRequestView } from '@enbox/dwn-server';
import type { PairingBroker, PairingDecision } from '../src/pairing-broker.js';

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'bun:test';

import { AllowOriginPairingBroker, TtyPairingBroker } from '../src/pairing-broker.js';

function createRequest(origin: string): LocalNodePairingRequestView {
  return {
    createdAt : 1,
    expiresAt : 2,
    id        : 'request-id',
    origin,
    status    : 'pending',
  };
}

describe('AllowOriginPairingBroker', () => {
  it('should approve allowed origins', async () => {
    const broker = new AllowOriginPairingBroker(['https://app.example']);

    await expect(broker.decidePairingRequest(createRequest('https://app.example'))).resolves.toBe('approve');
  });

  it('should deny unlisted origins without a fallback broker', async () => {
    const broker = new AllowOriginPairingBroker(['https://app.example']);

    await expect(broker.decidePairingRequest(createRequest('https://other.example'))).resolves.toBe('deny');
  });

  it('should delegate unlisted origins to the fallback broker', async () => {
    const fallback: PairingBroker = {
      async decidePairingRequest(request: LocalNodePairingRequestView): Promise<PairingDecision> {
        return request.origin === 'https://other.example' ? 'approve' : 'deny';
      },
    };
    const broker = new AllowOriginPairingBroker(['https://app.example'], fallback);

    await expect(broker.decidePairingRequest(createRequest('https://other.example'))).resolves.toBe('approve');
  });
});

describe('TtyPairingBroker', () => {
  it('should deny requests when no interactive TTY is available', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    output.isTTY = false;

    const broker = new TtyPairingBroker({ input, output });

    await expect(broker.decidePairingRequest(createRequest('https://app.example'))).resolves.toBe('deny');
  });
});
