import type { MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import { MemoryStore } from '@enbox/common';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { SyncNextLinkIdentity } from '../src/sync-next/types.js';

import { HdIdentityVault } from '../src/hd-identity-vault.js';
import {
  openSyncNextQuarantinePayload,
  sealSyncNextQuarantinePayload,
  SYNC_NEXT_MAX_QUARANTINE_PLAINTEXT_BYTES,
} from '../src/sync-next/quarantine-codec.js';

const TEST_PASSWORD = 'sync-next-test-password';

function identity(endpoint = 'https://dwn.example.com'): SyncNextLinkIdentity {
  return {
    authorizationEpoch : 'owner-epoch',
    projectionId       : 'projection',
    remoteEndpoint     : endpoint,
    tenantDid          : 'did:example:alice',
  };
}

function source(position = '1', messageCid = 'cid-1'): ProgressToken {
  return {
    epoch: 'epoch', messageCid, position, streamId: 'stream',
  };
}

function entry(messageCid = 'cid-1', encodedData?: string): MessagesQueryReplyEntry {
  return {
    messageCid,
    seq     : '1',
    message : {
      descriptor: {
        interface        : 'Records',
        method           : 'Write',
        messageTimestamp : '2026-09-20T00:00:00.000000Z',
      },
    } as never,
    ...(encodedData === undefined ? {} : { encodedData }),
  };
}

describe('SyncNext quarantine codec', () => {
  let vault: HdIdentityVault;

  beforeEach(async () => {
    vault = new HdIdentityVault({
      keyDerivationWorkFactor : 1,
      store                   : new MemoryStore<string, string>(),
    });
    await vault.initialize({ password: TEST_PASSWORD });
  });

  it('should round-trip received input through the existing vault encryption', async () => {
    const binding = { identity: identity(), messageCid: 'cid-1', source: source() };
    const payload = entry();

    const encrypted = await sealSyncNextQuarantinePayload(vault, binding, payload);

    expect(encrypted).not.toContain('cid-1');
    expect(await openSyncNextQuarantinePayload(vault, binding, encrypted)).toEqual(payload);
  });

  it('should reject ciphertext moved to another link, source position, or CID', async () => {
    const binding = { identity: identity(), messageCid: 'cid-1', source: source() };
    const encrypted = await sealSyncNextQuarantinePayload(vault, binding, entry());

    await expect(openSyncNextQuarantinePayload(vault, {
      ...binding,
      identity: identity('https://other.example.com'),
    }, encrypted)).rejects.toThrow('does not belong to this receipt');
    await expect(openSyncNextQuarantinePayload(vault, {
      ...binding,
      source: source('2'),
    }, encrypted)).rejects.toThrow('does not belong to this receipt');
    await expect(openSyncNextQuarantinePayload(vault, {
      ...binding,
      messageCid : 'cid-2',
      source     : source('1', 'cid-2'),
    }, encrypted)).rejects.toThrow('does not belong to this receipt');
  });

  it('should reject a root whose CID differs from its source receipt', async () => {
    await expect(sealSyncNextQuarantinePayload(vault, {
      identity   : identity(),
      messageCid : 'cid-1',
      source     : source(),
    }, entry('cid-2'))).rejects.toThrow('root entry CID does not match its receipt');
  });

  it('should reject an oversized row before encryption', async () => {
    const oversized = 'a'.repeat(SYNC_NEXT_MAX_QUARANTINE_PLAINTEXT_BYTES);
    await expect(sealSyncNextQuarantinePayload(vault, {
      identity   : identity(),
      messageCid : 'cid-1',
      source     : source(),
    }, entry('cid-1', oversized))).rejects.toThrow('payload exceeds');
  });

  it('should fail closed while the vault is locked', async () => {
    await vault.lock();

    await expect(sealSyncNextQuarantinePayload(vault, {
      identity   : identity(),
      messageCid : 'cid-1',
      source     : source(),
    }, entry())).rejects.toThrow('vault is locked');
  });
});
