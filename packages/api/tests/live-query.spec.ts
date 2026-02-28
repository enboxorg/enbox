import type { Record } from '../src/record.js';
import type { RecordChange } from '../src/live-query.js';
import type { DwnMessageSubscription, EnboxAgent } from '@enbox/agent';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { LiveQuery, RecordChangeEvent } from '../src/live-query.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal mock Record with the given id, timestamp, and deleted flag. */
function createMockRecord(
  id: string,
  timestamp: string,
  deleted: boolean = false,
): Record {
  return {
    id,
    timestamp,
    deleted,
  } as unknown as Record;
}

/** Creates a minimal mock DwnMessageSubscription. */
function createMockSubscription(): sinon.SinonStubbedInstance<DwnMessageSubscription> {
  return {
    close: sinon.stub().resolves(),
  } as unknown as sinon.SinonStubbedInstance<DwnMessageSubscription>;
}

/** Creates a LiveQuery with sensible defaults. */
function createLiveQuery(options?: {
  initialEntries?: any[];
  subscription?: DwnMessageSubscription;
}): LiveQuery {
  return new LiveQuery({
    agent          : {} as EnboxAgent,
    connectedDid   : 'did:test:alice',
    initialEntries : options?.initialEntries ?? [],
    subscription   : options?.subscription ?? createMockSubscription() as unknown as DwnMessageSubscription,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveQuery', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should initialize with empty records when no entries are provided', () => {
      const live = createLiveQuery();

      expect(live.records).toEqual([]);
      expect(live.cursor).toBeUndefined();
      expect(live.isConnected).toBe(true);
    });
  });

  describe('isConnected', () => {
    it('should return true by default', () => {
      const live = createLiveQuery();
      expect(live.isConnected).toBe(true);
    });

    it('should return false after a disconnected event', () => {
      const live = createLiveQuery();
      live.handleLifecycleEvent('disconnected');
      expect(live.isConnected).toBe(false);
    });

    it('should return true after reconnected event', () => {
      const live = createLiveQuery();
      live.handleLifecycleEvent('disconnected');
      expect(live.isConnected).toBe(false);
      live.handleLifecycleEvent('reconnected');
      expect(live.isConnected).toBe(true);
    });
  });

  describe('handleEvent()', () => {
    it('should classify a new record as a create event', () => {
      const live = createLiveQuery();
      const changes: RecordChange[] = [];
      live.on('change', (change) => { changes.push(change); });

      const record = createMockRecord('rec-1', '2024-01-01T00:00:00Z');
      live.handleEvent(record);

      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('create');
      expect(changes[0].record).toBe(record);
    });

    it('should classify an updated record as an update event', () => {
      const live = createLiveQuery();
      const changes: RecordChange[] = [];
      live.on('change', (change) => { changes.push(change); });

      // First event — create
      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));
      // Second event — update (newer timestamp, same id)
      const updatedRecord = createMockRecord('rec-1', '2024-01-02T00:00:00Z');
      live.handleEvent(updatedRecord);

      expect(changes).toHaveLength(2);
      expect(changes[1].type).toBe('update');
      expect(changes[1].record).toBe(updatedRecord);
    });

    it('should classify a deleted record as a delete event', () => {
      const live = createLiveQuery();
      const changes: RecordChange[] = [];
      live.on('change', (change) => { changes.push(change); });

      // First event — create
      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));
      // Second event — delete
      const deletedRecord = createMockRecord('rec-1', '2024-01-02T00:00:00Z', true);
      live.handleEvent(deletedRecord);

      expect(changes).toHaveLength(2);
      expect(changes[1].type).toBe('delete');
      expect(changes[1].record).toBe(deletedRecord);
    });

    it('should deduplicate stale events with same or older timestamp', () => {
      const live = createLiveQuery();
      const changes: RecordChange[] = [];
      live.on('change', (change) => { changes.push(change); });

      // Initial create
      live.handleEvent(createMockRecord('rec-1', '2024-01-02T00:00:00Z'));
      // Stale event — same timestamp (duplicate from overlap window)
      live.handleEvent(createMockRecord('rec-1', '2024-01-02T00:00:00Z'));
      // Stale event — older timestamp
      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));

      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('create');
    });

    it('should not dispatch events after close()', async () => {
      const live = createLiveQuery();
      const changes: RecordChange[] = [];
      live.on('change', (change) => { changes.push(change); });

      await live.close();

      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));
      expect(changes).toHaveLength(0);
    });

    it('should dispatch both specific and catch-all change events', () => {
      const live = createLiveQuery();
      const creates: Record[] = [];
      const allChanges: RecordChange[] = [];

      live.on('create', (record) => { creates.push(record); });
      live.on('change', (change) => { allChanges.push(change); });

      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));

      expect(creates).toHaveLength(1);
      expect(allChanges).toHaveLength(1);
    });

    it('should remove the record from known set on delete, then classify new write as create', () => {
      const live = createLiveQuery();
      const changes: RecordChange[] = [];
      live.on('change', (change) => { changes.push(change); });

      // Create -> Delete -> Re-create should be create, delete, create
      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));
      live.handleEvent(createMockRecord('rec-1', '2024-01-02T00:00:00Z', true));
      live.handleEvent(createMockRecord('rec-1', '2024-01-03T00:00:00Z'));

      expect(changes).toHaveLength(3);
      expect(changes[0].type).toBe('create');
      expect(changes[1].type).toBe('delete');
      expect(changes[2].type).toBe('create');
    });
  });

  describe('handleLifecycleEvent()', () => {
    it('should dispatch disconnected event', () => {
      const live = createLiveQuery();
      let fired = false;
      live.on('disconnected', () => { fired = true; });

      live.handleLifecycleEvent('disconnected');
      expect(fired).toBe(true);
    });

    it('should dispatch reconnecting event with attempt detail', () => {
      const live = createLiveQuery();
      let receivedDetail: { attempt: number } | undefined;
      live.on('reconnecting', (detail) => { receivedDetail = detail; });

      live.handleLifecycleEvent('reconnecting', { attempt: 3 });
      expect(receivedDetail).toEqual({ attempt: 3 });
    });

    it('should dispatch reconnected event', () => {
      const live = createLiveQuery();
      let fired = false;
      live.on('reconnected', () => { fired = true; });

      live.handleLifecycleEvent('reconnected');
      expect(fired).toBe(true);
    });

    it('should dispatch eose event', () => {
      const live = createLiveQuery();
      let fired = false;
      live.on('eose', () => { fired = true; });

      live.handleLifecycleEvent('eose');
      expect(fired).toBe(true);
    });

    it('should not dispatch events after close()', async () => {
      const live = createLiveQuery();
      let fired = false;
      live.on('disconnected', () => { fired = true; });

      await live.close();
      live.handleLifecycleEvent('disconnected');
      expect(fired).toBe(false);
    });
  });

  describe('on()', () => {
    it('should return an unsubscribe function that removes the handler', () => {
      const live = createLiveQuery();
      const changes: RecordChange[] = [];
      const off = live.on('change', (change) => { changes.push(change); });

      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));
      expect(changes).toHaveLength(1);

      off(); // unsubscribe

      live.handleEvent(createMockRecord('rec-2', '2024-01-01T00:00:00Z'));
      expect(changes).toHaveLength(1); // no new events
    });

    it('should route create events to the create handler with the record', () => {
      const live = createLiveQuery();
      const received: Record[] = [];
      live.on('create', (record) => { received.push(record); });

      const rec = createMockRecord('rec-1', '2024-01-01T00:00:00Z');
      live.handleEvent(rec);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(rec);
    });

    it('should route update events to the update handler', () => {
      const live = createLiveQuery();
      const received: Record[] = [];
      live.on('update', (record) => { received.push(record); });

      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));
      const updated = createMockRecord('rec-1', '2024-01-02T00:00:00Z');
      live.handleEvent(updated);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(updated);
    });

    it('should route delete events to the delete handler', () => {
      const live = createLiveQuery();
      const received: Record[] = [];
      live.on('delete', (record) => { received.push(record); });

      live.handleEvent(createMockRecord('rec-1', '2024-01-01T00:00:00Z'));
      const deleted = createMockRecord('rec-1', '2024-01-02T00:00:00Z', true);
      live.handleEvent(deleted);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(deleted);
    });
  });

  describe('close()', () => {
    it('should close the underlying subscription', async () => {
      const sub = createMockSubscription();
      const live = createLiveQuery({ subscription: sub as unknown as DwnMessageSubscription });

      await live.close();
      expect(sub.close.calledOnce).toBe(true);
    });

    it('should be idempotent — calling close() twice should not throw', async () => {
      const sub = createMockSubscription();
      const live = createLiveQuery({ subscription: sub as unknown as DwnMessageSubscription });

      await live.close();
      await live.close(); // second call is a no-op

      expect(sub.close.calledOnce).toBe(true);
    });
  });
});

describe('RecordChangeEvent', () => {
  it('should construct a CustomEvent with the correct type and detail', () => {
    const record = createMockRecord('rec-1', '2024-01-01T00:00:00Z');
    const change: RecordChange = { type: 'create', record };
    const event = new RecordChangeEvent(change);

    expect(event.type).toBe('create');
    expect(event.detail).toBe(change);
  });

  it('should use the change type as the event name', () => {
    const record = createMockRecord('rec-1', '2024-01-01T00:00:00Z', true);
    const change: RecordChange = { type: 'delete', record };
    const event = new RecordChangeEvent(change);

    expect(event.type).toBe('delete');
  });
});
