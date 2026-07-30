import type { AbstractLevel } from 'abstract-level';
import type { AudienceKeyDeliveryIntent } from '../src/audience-key-delivery.js';
import type { AudienceKeyDeliveryStore } from '../src/audience-key-delivery-store.js';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { audienceKeyDeliveryProjectionKey } from '../src/audience-key-delivery-store.js';
import { AudienceKeyDeliveryStoreLevel } from '../src/audience-key-delivery-store-level.js';

const location = '__TESTDATA__/audience-key-delivery-store-level-spec';

describe('AudienceKeyDeliveryStoreLevel', () => {
  let store: AudienceKeyDeliveryStoreLevel;

  beforeEach(async () => {
    store = new AudienceKeyDeliveryStoreLevel(location);
    await store.clear();
  });

  afterEach(async () => {
    await store.clear();
    await store.close();
  });

  it('stores exact role state and isolates source tenants', async () => {
    const alice = deliveryIntent();
    const carol = deliveryIntent({ sourceDid: 'did:example:carol' });

    await recordDelivered(store, alice);
    await recordDelivered(store, carol);

    expect(await store.get(alice.sourceDid, alice.roleRecordId)).toMatchObject(alice);
    expect(await store.get(carol.sourceDid, carol.roleRecordId)).toMatchObject(carol);
    expect(await store.get('did:example:missing', alice.roleRecordId)).toBeUndefined();
  });

  it('does not regress a valid delivery after a later failed attempt', async () => {
    const intent = deliveryIntent();
    await recordDelivered(store, intent);
    await store.record({
      intent,
      outcome: {
        delivered    : false,
        failure      : 'retryable',
        reason       : 'temporarily unavailable',
        recipientDid : intent.recipientDid,
      },
    });

    expect(await store.get(intent.sourceDid, intent.roleRecordId)).toEqual({ ...intent, state: 'delivered' });
  });

  it('retains a late success after a failed attempt', async () => {
    const intent = deliveryIntent();
    await store.record({
      intent,
      outcome: {
        delivered    : false,
        failure      : 'retryable',
        reason       : 'temporarily unavailable',
        recipientDid : intent.recipientDid,
      },
    });
    await recordDelivered(store, intent);

    expect(await store.get(intent.sourceDid, intent.roleRecordId)).toEqual({ ...intent, state: 'delivered' });
  });

  it('replaces a corrupt private projection on the next delivery outcome', async () => {
    const intent = deliveryIntent();
    const states = Reflect.get(store, '_states') as AbstractLevel<string, string, string>;
    await states.put(audienceKeyDeliveryProjectionKey(intent.sourceDid, intent.roleRecordId), 'not-json');

    await recordDelivered(store, intent);

    expect(await store.get(intent.sourceDid, intent.roleRecordId)).toEqual({ ...intent, state: 'delivered' });
  });

  it('survives closing and reopening the store', async () => {
    const intent = deliveryIntent();
    await recordDelivered(store, intent);
    await store.close();

    store = new AudienceKeyDeliveryStoreLevel(location);
    expect(await store.get(intent.sourceDid, intent.roleRecordId)).toEqual({ ...intent, state: 'delivered' });
  });

  it('rebuilds one protocol slice without replacing delivered or unrelated state', async () => {
    const delivered = deliveryIntent();
    const stale = deliveryIntent({ roleRecordId: 'stale-role' });
    const otherProtocol = deliveryIntent({ protocol: 'https://example.com/other', roleRecordId: 'other-protocol' });
    const otherSource = deliveryIntent({ sourceDid: `${delivered.sourceDid}-other`, roleRecordId: 'other-source' });
    const discovered = deliveryIntent({ roleRecordId: 'discovered-role' });
    await Promise.all([
      recordDelivered(store, delivered),
      recordDelivered(store, stale),
      recordDelivered(store, otherProtocol),
      recordDelivered(store, otherSource),
    ]);

    const states = await store.reconcileProtocol({
      protocol  : delivered.protocol,
      sourceDid : delivered.sourceDid,
      scan      : async () => [delivered, discovered],
    });

    expect(states).toEqual(expect.arrayContaining([
      { ...delivered, state: 'delivered' },
      { ...discovered, state: 'pending' },
    ]));
    expect(states).toHaveLength(2);
    expect(await store.get(stale.sourceDid, stale.roleRecordId)).toBeUndefined();
    expect(await store.get(otherProtocol.sourceDid, otherProtocol.roleRecordId)).toBeDefined();
    expect(await store.get(otherSource.sourceDid, otherSource.roleRecordId)).toBeDefined();
  });

  it('does not mutate state when the authoritative scan fails', async () => {
    const intent = deliveryIntent();
    await recordDelivered(store, intent);

    await expect(store.reconcileProtocol({
      protocol  : intent.protocol,
      sourceDid : intent.sourceDid,
      scan      : async () => { throw new Error('incomplete scan'); },
    })).rejects.toThrow('incomplete scan');

    expect(await store.get(intent.sourceDid, intent.roleRecordId)).toEqual({ ...intent, state: 'delivered' });
  });
});

function deliveryIntent(overrides: Partial<AudienceKeyDeliveryIntent> = {}): AudienceKeyDeliveryIntent {
  return {
    contextId    : 'workspace-id',
    protocol     : 'https://example.com/workspace',
    recipientDid : 'did:example:bob',
    rolePath     : 'workspace/member',
    roleRecordId : 'role-record-id',
    sourceDid    : 'did:example:alice',
    ...overrides,
  };
}

async function recordDelivered(
  store: AudienceKeyDeliveryStore,
  intent: AudienceKeyDeliveryIntent,
): Promise<void> {
  await store.record({
    intent,
    outcome: { delivered: true, recipientDid: intent.recipientDid },
  });
}
