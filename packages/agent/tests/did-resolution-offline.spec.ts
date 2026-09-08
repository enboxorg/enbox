import type { BearerDid } from '@enbox/dids';

import sinon from 'sinon';

import { DidDht } from '@enbox/dids';
import { afterEach, describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '../src/enbox-user-agent.js';
import { isDidResolutionUnavailableError } from '../src/did-resolution-error.js';

describe('local DWN reads during a DID resolution outage', () => {
  let agent: EnboxUserAgent | undefined;

  afterEach(async () => {
    await agent?.shutdown();
    sinon.restore();
  });

  async function createAgentDid(): Promise<BearerDid> {
    return DidDht.create({
      options: {
        publish             : false,
        verificationMethods : [
          { algorithm: 'Ed25519', id: 'sig', purposes: ['assertionMethod', 'authentication'] },
          { algorithm: 'X25519', id: 'enc', purposes: ['keyAgreement'] },
        ],
      },
    });
  }

  it('reads encrypted keys and grants from persistent storage with cold caches and a stale trusted DID', async () => {
    const agentDid = await createAgentDid();
    const dataPath = `__TESTDATA__/did-offline-retained-${crypto.randomUUID()}`;
    agent = await EnboxUserAgent.create({ agentDid, dataPath });
    await agent.did.cacheResolution(agentDid.uri, {
      didDocument           : agentDid.document,
      didDocumentMetadata   : agentDid.metadata,
      didResolutionMetadata : {},
    });
    const keyUri = await agent.keyManager.generateKey({ algorithm: 'Ed25519' });
    const publicKey = await agent.keyManager.getPublicKey({ keyUri });
    const { grant } = await agent.permissions.createGrant({
      author      : agentDid.uri,
      grantedTo   : agentDid.uri,
      store       : true,
      dateExpires : '2099-01-01T00:00:00.000000Z',
      scope       : { interface: 'Messages', method: 'Read' },
    });
    await agent.shutdown();

    // Reopening keeps only durable state; key, store, and JWS caches are cold.
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    clock.tick(16 * 60 * 1000);
    const fetch = sinon.stub(globalThis, 'fetch').rejects(new TypeError('gateway unreachable'));
    agent = await EnboxUserAgent.create({ agentDid, dataPath });

    expect(await agent.keyManager.getPublicKey({ keyUri })).toEqual(publicKey);
    const grants = await agent.permissions.fetchGrants({
      author       : agentDid.uri,
      target       : agentDid.uri,
      checkRevoked : true,
    });
    expect(grants.map(entry => entry.grant.id)).toContain(grant.id);
    const signature = await agent.keyManager.sign({ keyUri, data: new Uint8Array([1, 2, 3]) });
    expect(signature.length).toBeGreaterThan(0);
    expect(fetch.called).toBe(true);
    expect((await agent.did.cache.getRetained?.(agentDid.uri))?.didDocument).toEqual(agentDid.document);
  });

  it('preserves a missing-DID dependency failure through cold key and grant reads, then recovers', async () => {
    const agentDid = await createAgentDid();
    const dataPath = `__TESTDATA__/did-offline-missing-${crypto.randomUUID()}`;
    agent = await EnboxUserAgent.create({ agentDid, dataPath });
    const resolution = {
      didDocument           : agentDid.document,
      didDocumentMetadata   : agentDid.metadata,
      didResolutionMetadata : {},
    };
    await agent.did.cacheResolution(agentDid.uri, resolution);
    const keyUri = await agent.keyManager.generateKey({ algorithm: 'Ed25519' });
    const publicKey = await agent.keyManager.getPublicKey({ keyUri });
    await agent.did.cache.delete(agentDid.uri);
    await agent.shutdown();

    sinon.stub(globalThis, 'fetch').rejects(new TypeError('gateway unreachable'));
    agent = await EnboxUserAgent.create({ agentDid, dataPath });
    const keyFailure = await agent.keyManager.getPublicKey({ keyUri }).catch((error: unknown) => error);
    const grantFailure = await agent.permissions.fetchGrants({
      author : agentDid.uri,
      target : agentDid.uri,
    }).catch((error: unknown) => error);

    expect(isDidResolutionUnavailableError(keyFailure)).toBe(true);
    expect(isDidResolutionUnavailableError(grantFailure)).toBe(true);
    await agent.did.cacheResolution(agentDid.uri, resolution);
    expect(await agent.keyManager.getPublicKey({ keyUri })).toEqual(publicKey);
  });
});
