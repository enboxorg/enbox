import type { BearerDid } from '@enbox/dids';
import type { DwnModuleDefinition } from '@enbox/agent';
import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { DwnInterface, EnboxUserAgent } from '@enbox/agent';
import { DwnInterfaceName, DwnMethodName, Poller } from '@enbox/dwn-sdk-js';

import { DwnApi } from '../src/dwn-api.js';
import { TestDataGenerator } from './utils/test-data-generator.js';

function getRecordId(message: DwnSubscriptionMessage): string | undefined {
  if (message.type !== 'event') {
    return undefined;
  }

  const recordMessage = message.event.message as { recordId?: string; descriptor?: { recordId?: string } };
  return recordMessage.recordId ?? recordMessage.descriptor?.recordId;
}

describe('DwnApi raw subscriptions', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory',
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
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  async function configureNoteModule(): Promise<DwnModuleDefinition> {
    const module = `https://example.com/modules/raw-subscription-${TestDataGenerator.randomString(15)}`;
    const definition: DwnModuleDefinition = {
      module,
      published : true,
      types     : {
        note: {
          dataFormats : ['text/plain'],
          schema      : `${module}/note`,
        },
      },
      structure: { note: {} },
    };

    expect((await dwnAlice.modules.configure({ definition })).status.code).toBe(202);
    return definition;
  }

  async function writeNote(definition: DwnModuleDefinition, data: string): Promise<string> {
    const { status, record } = await dwnAlice.records.write({
      data,
      dataFormat : 'text/plain',
      module     : definition.module,
      modulePath : 'note',
      schema     : definition.types.note.schema,
    });
    expect(status.code).toBe(202);
    return record!.id;
  }

  it('should return the raw MessagesSubscribe reply and deliver raw module events', async () => {
    const definition = await configureNoteModule();
    const messages: DwnSubscriptionMessage[] = [];

    const reply = await dwnAlice.messages.subscribe({
      filters             : [{ module: definition.module }],
      subscriptionHandler : (message): void => { messages.push(message); },
    });

    expect(reply.status.code).toBe(200);
    expect(reply.subscription).toBeDefined();

    const recordId = await writeNote(definition, 'raw message event');
    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(messages.some(message => getRecordId(message) === recordId)).toBe(true);
    });

    const delivered = messages.find(message => getRecordId(message) === recordId)!;
    expect(delivered.type).toBe('event');
    if (delivered.type === 'event') {
      expect(delivered.event.message.descriptor.interface).toBe(DwnInterfaceName.Records);
      expect(delivered.event.message.descriptor.method).toBe(DwnMethodName.Write);
      expect(delivered.cursor.position).toBeDefined();
    }

    await reply.subscription!.close();
  });

  it('should install the handler before synchronous cursor catch-up begins', async () => {
    const definition = await configureNoteModule();
    const baselineMessages: DwnSubscriptionMessage[] = [];
    const baseline = await dwnAlice.messages.subscribe({
      filters             : [{ module: definition.module }],
      subscriptionHandler : (message): void => { baselineMessages.push(message); },
    });

    const firstRecordId = await writeNote(definition, 'first');
    const secondRecordId = await writeNote(definition, 'second');
    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(baselineMessages.some(message => getRecordId(message) === secondRecordId)).toBe(true);
    });

    const firstEvent = baselineMessages.find(message => getRecordId(message) === firstRecordId);
    expect(firstEvent?.type).toBe('event');
    if (firstEvent?.type !== 'event') {
      throw new Error('expected the first write event');
    }
    await baseline.subscription!.close();

    const resumedMessages: DwnSubscriptionMessage[] = [];
    const resumed = await dwnAlice.messages.subscribe({
      cursor              : firstEvent.cursor,
      filters             : [{ module: definition.module }],
      subscriptionHandler : (message): void => { resumedMessages.push(message); },
    });

    expect(resumed.status.code).toBe(200);
    expect(resumedMessages.map(message => message.type)).toEqual(['event', 'eose']);
    expect(getRecordId(resumedMessages[0])).toBe(secondRecordId);
    await resumed.subscription!.close();
  });

  it('should return the raw RecordsSubscribe snapshot and deliver later record events', async () => {
    const definition = await configureNoteModule();
    const initialRecordId = await writeNote(definition, 'initial');
    const messages: DwnSubscriptionMessage[] = [];

    const reply = await dwnAlice.records.subscribe({
      filter              : { module: definition.module, modulePath: 'note' },
      subscriptionHandler : (message): void => { messages.push(message); },
    });

    expect(reply.status.code).toBe(200);
    expect(reply.subscription).toBeDefined();
    expect(reply.entries?.map(entry => entry.recordId)).toEqual([initialRecordId]);

    const laterRecordId = await writeNote(definition, 'later');
    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(messages.some(message => getRecordId(message) === laterRecordId)).toBe(true);
    });

    await reply.subscription!.close();
  });

  it('should pass the exact handler through to the agent request', async () => {
    const definition = await configureNoteModule();
    const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');
    const subscriptionHandler = (_message: DwnSubscriptionMessage): void => {};

    const reply = await dwnAlice.records.subscribe({
      filter: { module: definition.module, modulePath: 'note' },
      subscriptionHandler,
    });

    const request = processSpy.getCalls().find(
      call => call.args[0].messageType === DwnInterface.RecordsSubscribe
    )!.args[0];
    expect(request.subscriptionHandler).toBe(subscriptionHandler);
    await reply.subscription!.close();
  });

  it('should reject ambiguous delegated message feeds before dispatch', async () => {
    const delegated = new DwnApi({
      agent        : testHarness.agent,
      connectedDid : aliceDid.uri,
      delegateDid  : aliceDid.uri,
    });

    await expect(delegated.messages.subscribe({
      filters             : [{ module: 'http://a.example' }, { module: 'http://b.example' }],
      subscriptionHandler : (): void => {},
    })).rejects.toThrow('single-module filter set or explicit permissionGrantIds');
  });
});
