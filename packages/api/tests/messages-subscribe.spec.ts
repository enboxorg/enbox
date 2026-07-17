import type { BearerDid } from '@enbox/dids';
import type { MessageChange } from '../src/messages-live-query.js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { EnboxUserAgent } from '@enbox/agent';
import { DwnInterfaceName, DwnMethodName, Poller } from '@enbox/dwn-sdk-js';

import emailProtocolDefinition from './fixtures/protocol-definitions/email.json' with { type: 'json' };

import { DwnApi } from '../src/dwn-api.js';
import { TestDataGenerator } from './utils/test-data-generator.js';

describe('DwnApi.messages', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let protocolUri: string;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls: [] });
    aliceDid = alice.did;

    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    testHarness.dwnStores.clear();

    protocolUri = `http://example.com/protocol/${TestDataGenerator.randomString(15)}`;
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('subscribe()', () => {
    it('should deliver every message on the tenant log when no filters are given', async () => {
      const definition = { ...emailProtocolDefinition, protocol: protocolUri };

      const { status, liveQuery } = await dwnAlice.messages.subscribe();
      expect(status.code).toBe(200);
      expect(liveQuery).toBeDefined();

      const events: MessageChange[] = [];
      liveQuery!.on('event', (change): void => { events.push(change); });

      const { status: configureStatus } = await dwnAlice.protocols.configure({ definition });
      expect(configureStatus.code).toBe(202);

      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'hello inbox',
        protocol     : definition.protocol,
        protocolPath : 'thread',
        schema       : definition.types.thread.schema,
        dataFormat   : 'application/json',
      });
      expect(writeStatus.code).toBe(202);

      // The unfiltered feed carries every interface — the ProtocolsConfigure
      // itself and the RecordsWrite both surface, each with a descriptor.
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(events.some(event => event.descriptor.method === DwnMethodName.Configure)).toBe(true);
        expect(events.some(event => event.descriptor.recordId === record!.id)).toBe(true);
      });

      const configureChange = events.find(event => event.descriptor.method === DwnMethodName.Configure)!;
      expect(configureChange.descriptor.interface).toBe(DwnInterfaceName.Protocols);
      expect(configureChange.descriptor.protocol).toBe(definition.protocol);

      const writeChange = events.find(event => event.descriptor.recordId === record!.id)!;
      expect(writeChange.descriptor.interface).toBe(DwnInterfaceName.Records);
      expect(writeChange.descriptor.method).toBe(DwnMethodName.Write);
      expect(writeChange.descriptor.author).toBe(aliceDid.uri);
      expect(writeChange.messageCid).toBeDefined();
      expect(writeChange.cursor.position).toBeDefined();

      // After close, further writes must not dispatch.
      await liveQuery!.close();
      const countAfterClose = events.length;
      await dwnAlice.records.write({
        data         : 'after close',
        protocol     : definition.protocol,
        protocolPath : 'thread',
        schema       : definition.types.thread.schema,
        dataFormat   : 'application/json',
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(events.length).toBe(countAfterClose);
    });

    it('should route protocol-filtered events with full descriptors across multiple filters', async () => {
      const protocolA = { ...emailProtocolDefinition, protocol: protocolUri };
      const protocolB = { ...emailProtocolDefinition, protocol: `${protocolUri}-b` };
      const protocolOther = { ...emailProtocolDefinition, protocol: `${protocolUri}-other` };

      for (const definition of [protocolA, protocolB, protocolOther]) {
        const { status } = await dwnAlice.protocols.configure({ definition });
        expect(status.code).toBe(202);
      }

      // One subscription, two protocol filters — the "one feed per profile" shape.
      const { status, liveQuery } = await dwnAlice.messages.subscribe({
        filters: [{ protocol: protocolA.protocol }, { protocol: protocolB.protocol }],
      });
      expect(status.code).toBe(200);

      const events: MessageChange[] = [];
      liveQuery!.on('event', (change): void => { events.push(change); });

      const writeTo = async (protocol: typeof protocolA): Promise<string> => {
        const { status: writeStatus, record } = await dwnAlice.records.write({
          data         : `hello ${protocol.protocol}`,
          protocol     : protocol.protocol,
          protocolPath : 'thread',
          schema       : protocol.types.thread.schema,
          dataFormat   : 'application/json',
        });
        expect(writeStatus.code).toBe(202);
        return record!.id;
      };

      const recordInA = await writeTo(protocolA);
      const recordInB = await writeTo(protocolB);
      const recordInOther = await writeTo(protocolOther);

      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(events.some(event => event.descriptor.recordId === recordInA)).toBe(true);
        expect(events.some(event => event.descriptor.recordId === recordInB)).toBe(true);
      });

      const changeInA = events.find(event => event.descriptor.recordId === recordInA)!;
      expect(changeInA.descriptor).toMatchObject({
        interface    : DwnInterfaceName.Records,
        method       : DwnMethodName.Write,
        protocol     : protocolA.protocol,
        protocolPath : 'thread',
        author       : aliceDid.uri,
      });

      // The unmatched protocol never reaches this subscription.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(events.some(event => event.descriptor.recordId === recordInOther)).toBe(false);

      await liveQuery!.close();
    });

    it('should replay stored events from a cursor and emit eose before going live', async () => {
      const definition = { ...emailProtocolDefinition, protocol: protocolUri };
      const { status: configureStatus } = await dwnAlice.protocols.configure({ definition });
      expect(configureStatus.code).toBe(202);

      // Baseline subscription captures per-event cursors for two writes.
      const baseline = await dwnAlice.messages.subscribe({ filters: [{ protocol: definition.protocol }] });
      const seen: MessageChange[] = [];
      baseline.liveQuery!.on('event', (change): void => { seen.push(change); });

      const writeThread = async (data: string): Promise<string> => {
        const { record } = await dwnAlice.records.write({
          data,
          protocol     : definition.protocol,
          protocolPath : 'thread',
          schema       : definition.types.thread.schema,
          dataFormat   : 'application/json',
        });
        return record!.id;
      };

      const firstRecordId = await writeThread('first');
      const secondRecordId = await writeThread('second');

      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(seen.some(change => change.descriptor.recordId === firstRecordId)).toBe(true);
        expect(seen.some(change => change.descriptor.recordId === secondRecordId)).toBe(true);
      });
      const cursorAfterFirst = seen.find(change => change.descriptor.recordId === firstRecordId)!.cursor;
      await baseline.liveQuery!.close();

      // Resume from the first event's cursor: the stored SECOND event must
      // replay through the pre-listener buffer, followed by its EOSE — with
      // no new writes happening at all.
      const resumed = await dwnAlice.messages.subscribe({
        filters : [{ protocol: definition.protocol }],
        cursor  : cursorAfterFirst,
      });
      const ordered: string[] = [];
      const replayed: MessageChange[] = [];
      resumed.liveQuery!.on('event', (change): void => {
        ordered.push('event');
        replayed.push(change);
      });
      resumed.liveQuery!.on('eose', (): void => { ordered.push('eose'); });

      // The buffered backlog flushes one microtask after handlers attach.
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(ordered).toEqual(['event', 'eose']);
      expect(replayed[0].descriptor.recordId).toBe(secondRecordId);

      await resumed.liveQuery!.close();
    });

    it('should reject a delegated multi-protocol subscribe without explicit grants', async () => {
      const delegated = new DwnApi({
        agent        : testHarness.agent,
        connectedDid : aliceDid.uri,
        delegateDid  : aliceDid.uri,
      });

      await expect(delegated.messages.subscribe({
        filters: [{ protocol: 'http://a.example' }, { protocol: 'http://b.example' }],
      })).rejects.toThrow('single-protocol filter set or explicit permissionGrantIds');
    });

    it('should describe a RecordsDelete with the deleted recordId', async () => {
      const definition = { ...emailProtocolDefinition, protocol: protocolUri };
      const { status: configureStatus } = await dwnAlice.protocols.configure({ definition });
      expect(configureStatus.code).toBe(202);

      const { record } = await dwnAlice.records.write({
        data         : 'to be deleted',
        protocol     : definition.protocol,
        protocolPath : 'thread',
        schema       : definition.types.thread.schema,
        dataFormat   : 'application/json',
      });

      const { liveQuery } = await dwnAlice.messages.subscribe({
        filters: [{ protocol: definition.protocol }],
      });
      const events: MessageChange[] = [];
      liveQuery!.on('event', (change): void => { events.push(change); });

      const { status: deleteStatus } = await dwnAlice.records.delete({
        protocol : definition.protocol,
        recordId : record!.id,
      });
      expect(deleteStatus.code).toBe(202);

      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(events.some(event =>
          event.descriptor.method === DwnMethodName.Delete &&
          event.descriptor.recordId === record!.id,
        )).toBe(true);
      });

      await liveQuery!.close();
    });
  });
});
