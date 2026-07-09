import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { LocalReplicaDrainProof } from '../src/enbox-user-agent.js';
import type { SyncScope } from '../src/types/sync.js';

import { join } from 'node:path';
import sinon from 'sinon';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { Replication } from '@enbox/dwn-sdk-js';
import { MessageStoreLevel, ResumableTaskStoreLevel } from '@enbox/dwn-sdk-js/stores/level';

import { EnboxUserAgent } from '../src/enbox-user-agent.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';

const tenantDid = 'did:example:alice';
const notesProtocol = 'https://example.com/protocols/notes';
const photosProtocol = 'https://example.com/protocols/photos';

describe('EnboxUserAgent.inspectLocalReplicaDrainProof()', () => {
  const dataPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(dataPaths.splice(0).map((dataPath) => rm(dataPath, { force: true, recursive: true })));
  });

  it('accepts an unchanged retired replica and closes every temporary store', async () => {
    const dataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [notesProtocol],
      scope            : { kind: 'full' },
    });

    await expect(EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof })).resolves.toEqual({ valid: true });
    await expect(EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof })).resolves.toEqual({ valid: true });
  });

  it('rejects an in-scope write committed after the drain snapshot', async () => {
    const dataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [notesProtocol],
      scope            : { kind: 'protocolSet', protocols: [notesProtocol] },
    });

    await appendMessage(dataPath, notesProtocol, 'late-note');

    const inspection = await EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof });
    expect(inspection).toEqual({
      valid  : false,
      reason : `local replica fingerprint changed for tenant '${tenantDid}'`,
    });
  });

  it('rejects an out-of-scope write by detecting the advanced feed head', async () => {
    const dataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [notesProtocol],
      scope            : { kind: 'protocolSet', protocols: [notesProtocol] },
    });

    await appendMessage(dataPath, photosProtocol, 'late-photo');

    const inspection = await EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof });
    expect(inspection).toEqual({
      valid  : false,
      reason : `local replica feed head changed for tenant '${tenantDid}'`,
    });
  });

  it('rejects the first out-of-scope write after an empty drain snapshot', async () => {
    const dataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [],
      scope            : { kind: 'protocolSet', protocols: [notesProtocol] },
    });

    expect(proof.targets[0].pushCheckpoint).toBeUndefined();
    await appendMessage(dataPath, photosProtocol, 'first-photo');

    const inspection = await EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof });
    expect(inspection).toEqual({
      valid  : false,
      reason : `local replica feed is no longer empty for tenant '${tenantDid}'`,
    });
  });

  it('rejects the wrong replica path, replica ID, and registration snapshot', async () => {
    const dataPath = await createDataPath(dataPaths);
    const wrongDataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [notesProtocol],
      scope            : { kind: 'full' },
    });

    const wrongReplicaIdProof: LocalReplicaDrainProof = {
      ...proof,
      replicaId: 'wrong-replica-id',
    };
    await expect(EnboxUserAgent.inspectLocalReplicaDrainProof({
      dataPath,
      proof: wrongReplicaIdProof,
    })).resolves.toEqual({
      valid  : false,
      reason : 'local replica ID does not match the drain proof',
    });

    await expect(EnboxUserAgent.inspectLocalReplicaDrainProof({
      dataPath: wrongDataPath,
      proof,
    })).resolves.toEqual({
      valid  : false,
      reason : 'local replica ID does not match the drain proof',
    });

    const syncEngine = new SyncEngineLevel({ dataPath });
    try {
      await syncEngine.registerIdentity({
        did     : 'did:example:bob',
        options : { protocols: 'all' },
      });
    } finally {
      await syncEngine.close();
    }

    await expect(EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof })).resolves.toEqual({
      valid  : false,
      reason : 'local sync registrations changed after the drain',
    });
  });

  it('rejects a retired replica with a pending resumable task', async () => {
    const dataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [notesProtocol],
      scope            : { kind: 'full' },
    });
    const taskStore = new ResumableTaskStoreLevel({ location: join(dataPath, 'DWN_RESUMABLETASKSTORE') });

    try {
      await taskStore.open();
      await taskStore.register({ operation: 'records-write' }, 60);
    } finally {
      await taskStore.close();
    }

    await expect(EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof })).resolves.toEqual({
      valid  : false,
      reason : 'local replica has a pending resumable task',
    });
  });

  it('closes stores opened before a later store-open failure', async () => {
    const dataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [notesProtocol],
      scope            : { kind: 'full' },
    });
    const taskStoreOpenStub = sinon.stub(ResumableTaskStoreLevel.prototype, 'open').rejects(new Error('task store unavailable'));
    try {
      const inspection = await EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof });
      expect(inspection.valid).toBe(false);
    } finally {
      taskStoreOpenStub.restore();
    }

    await expect(EnboxUserAgent.inspectLocalReplicaDrainProof({ dataPath, proof })).resolves.toEqual({ valid: true });
  });

  it('rejects malformed, non-converged, and duplicate target proofs', async () => {
    const dataPath = await createDataPath(dataPaths);
    const proof = await createProof(dataPath, {
      initialProtocols : [notesProtocol],
      scope            : { kind: 'protocolSet', protocols: [notesProtocol] },
    });
    const target = proof.targets[0];
    const malformedProofs: LocalReplicaDrainProof[] = [
      {
        ...proof,
        targets: [{ ...target, remoteFingerprint: 'f'.repeat(64) }],
      },
      {
        ...proof,
        targets: [{ ...target, localFingerprint: 'NOT-A-FINGERPRINT' }],
      },
      {
        ...proof,
        targets: [{ ...target, tenantDid: 'not-a-did' }],
      },
      {
        ...proof,
        targets: [{
          ...target,
          scope: { kind: 'protocolSet', protocols: [] },
        }],
      },
      {
        ...proof,
        targets: [{
          ...target,
          pushCheckpoint: { ...target.pushCheckpoint!, position: '-1' },
        }],
      },
      {
        ...proof,
        targets: [{
          ...target,
          pushCheckpoint: null,
        }],
      },
      {
        ...proof,
        targets: [target, target],
      },
      {
        ...proof,
        targets: [
          target,
          {
            ...target,
            scope: { protocols: [notesProtocol], kind: 'protocolSet' },
          },
        ],
      },
    ] as unknown as LocalReplicaDrainProof[];

    for (const malformedProof of malformedProofs) {
      const inspection = await EnboxUserAgent.inspectLocalReplicaDrainProof({
        dataPath,
        proof: malformedProof,
      });
      expect(inspection.valid).toBe(false);
      if (!inspection.valid) {
        expect(inspection.reason.startsWith('malformed local replica drain proof:')).toBe(true);
      }
    }
  });
});

async function createDataPath(dataPaths: string[]): Promise<string> {
  const dataPath = await mkdtemp(join(tmpdir(), 'enbox-local-replica-proof-'));
  dataPaths.push(dataPath);
  return dataPath;
}

async function createProof(dataPath: string, options: {
  initialProtocols: string[];
  scope: SyncScope;
}): Promise<LocalReplicaDrainProof> {
  const syncEngine = new SyncEngineLevel({ dataPath });
  let snapshot;
  try {
    await syncEngine.registerIdentity({
      did     : tenantDid,
      options : { protocols: 'all' },
    });
    snapshot = await syncEngine.getEjectionSnapshot();
  } finally {
    await syncEngine.close();
  }

  const messageStore = new MessageStoreLevel({ location: join(dataPath, 'DWN_MESSAGESTORE') });
  try {
    await messageStore.open();
    for (const [index, protocol] of options.initialProtocols.entries()) {
      await putMessage(messageStore, protocol, `initial-${index}`);
    }

    const fingerprint = await messageStore.fingerprint(tenantDid, fingerprintScopes(options.scope));
    const bounds = await messageStore.logBounds(tenantDid);
    return {
      ...snapshot,
      targets: [{
        tenantDid,
        scope             : options.scope,
        pushCheckpoint    : bounds?.latest,
        localFingerprint  : fingerprint,
        remoteFingerprint : fingerprint,
      }],
    };
  } finally {
    await messageStore.close();
  }
}

async function appendMessage(dataPath: string, protocol: string, marker: string): Promise<void> {
  const messageStore = new MessageStoreLevel({ location: join(dataPath, 'DWN_MESSAGESTORE') });
  try {
    await messageStore.open();
    await putMessage(messageStore, protocol, marker);
  } finally {
    await messageStore.close();
  }
}

async function putMessage(messageStore: MessageStoreLevel, protocol: string, marker: string): Promise<void> {
  const messageTimestamp = `2026-07-09T00:00:00.${marker.length.toString().padStart(6, '0')}Z`;
  const message = {
    descriptor: {
      interface : 'Records',
      method    : 'Write',
      messageTimestamp,
      protocol,
      marker,
    },
  } as GenericMessage;

  await messageStore.put(tenantDid, message, { messageTimestamp, protocol });
}

function fingerprintScopes(scope: SyncScope): string[] {
  if (scope.kind === 'full') {
    return [Replication.globalDomain];
  }

  const protocols = new Set(scope.protocols);
  return [...protocols].flatMap((protocol: string): string[] => [
    Replication.protocolDomain(protocol),
    ...Replication.taggedCoreProtocolDomains(protocol, protocols),
  ]);
}
