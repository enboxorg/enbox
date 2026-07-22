/**
 * Role-audience key-delivery propagation through the `@enbox/api` layer.
 *
 * Verifies that `DwnApi.records.write()`, `Record.update()`, and the typed
 * `records.create()` / `TypedRecord.update()` surfaces forward the agent's
 * `audienceKeyDelivery` outcome, and that a caller-supplied
 * `recipientRolePublicKey` rides `agent.processDwnRequest()` at the top level
 * (never inside `messageParams`). Mirrors the agent's own role-delivery tests
 * in `packages/agent/tests/dwn-api.spec.ts`.
 */

import type { BearerDid } from '@enbox/dids';
import type { DwnProtocolDefinition, DwnPublicKeyJwk } from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const testDwnUrls: string[] = [testDwnUrl];

// A structurally valid X25519 OKP public key (canonical 32-byte base64url `x`)
// that passes the agent's usability validation, mirroring the agent's own
// role-delivery tests. Supplying it makes the agent wrap the role-audience key
// delivery to this key instead of resolving the recipient's key itself.
const VALID_X25519_KEY: DwnPublicKeyJwk = { kty: 'OKP', crv: 'X25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };

// Multi-party protocol with root (`admin`) and nested (`thread/participant`)
// `$role` paths plus a `settings` singleton. Each type requires encryption so
// the role paths carry a `$keyAgreement` audience, which makes role-audience
// key delivery provisioning run.
const chatDefinitionTemplate = {
  published : true,
  protocol  : 'https://protocol.xyz/api-chat' as string,
  types     : {
    admin       : { schema: 'https://schemas.xyz/admin', dataFormats: ['application/json'], encryptionRequired: true },
    thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'], encryptionRequired: true },
    participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'], encryptionRequired: true },
    chat        : { schema: 'https://schemas.xyz/chat', dataFormats: ['text/plain'], encryptionRequired: true },
    settings    : { schema: 'https://schemas.xyz/settings', dataFormats: ['application/json'], encryptionRequired: true },
    meta        : { schema: 'https://schemas.xyz/meta', dataFormats: ['application/json'], encryptionRequired: true },
  },
  structure: {
    admin  : { $role: true },
    thread : {
      participant : { $role: true },
      chat        : {},
      meta        : { $recordLimit: { max: 1, strategy: 'reject' } },
    },
    settings: { $recordLimit: { max: 1, strategy: 'reject' } },
  },
} as const satisfies DwnProtocolDefinition;

type ChatDefinition = typeof chatDefinitionTemplate;

type ChatSchemaMap = {
  admin: { name: string };
  thread: { title: string };
  participant: { name: string; role?: string };
  chat: string;
  settings: { theme: string };
  meta: { note: string };
};

/** Returns a fresh definition with a unique protocol URI so tests never share protocol state. */
function makeChatDefinition(): ChatDefinition {
  return {
    ...structuredClone(chatDefinitionTemplate),
    protocol: `https://protocol.xyz/api-chat-${TestDataGenerator.randomString(15)}`,
  };
}

describe('audience key delivery propagation', () => {
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/audience-key-delivery',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    bobDid = bob.did;

    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  /** Installs a fresh chat protocol (with `$keyAgreement` injection) and writes a parent thread record. */
  async function installChatProtocolWithThread(): Promise<{ definition: ChatDefinition; threadContextId: string }> {
    const definition = makeChatDefinition();

    const { status: configureStatus } = await dwnAlice.protocols.configure({
      definition,
    });
    expect(configureStatus.code).toBe(202);

    const { status: threadStatus, record: thread } = await dwnAlice.records.write({
      data         : { title: 'Test Thread' },
      protocol     : definition.protocol,
      protocolPath : 'thread',
      schema       : definition.types.thread.schema,
      dataFormat   : 'application/json',
    });
    expect(threadStatus.code).toBe(202);

    return { definition, threadContextId: thread!.contextId };
  }

  describe('DwnApi records.write()', () => {
    it('should surface a best-effort delivery skip on the write response', async () => {
      const { definition, threadContextId } = await installChatProtocolWithThread();

      // Force best-effort recipient key resolution to fail so delivery is skipped.
      const roleKeyLookupStub = sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
        .rejects(new Error('recipient protocol not installed'));

      const { status, record, audienceKeyDelivery } = await dwnAlice.records.write({
        data            : { name: 'Bob' },
        protocol        : definition.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        schema          : definition.types.participant.schema,
        dataFormat      : 'application/json',
        recipient       : bobDid.uri,
      });

      // Best-effort reporting: the accepted write stands and the skipped
      // delivery is surfaced on the response instead of failing the write.
      expect(status.code).toBe(202);
      expect(record).toBeDefined();
      expect(audienceKeyDelivery).toBeDefined();
      expect(audienceKeyDelivery!.delivered).toBe(false);
      expect(audienceKeyDelivery!.recipientDid).toBe(bobDid.uri);
      expect((audienceKeyDelivery as { reason: string }).reason).toContain('recipient protocol not installed');
      expect(roleKeyLookupStub.calledOnce).toBe(true);
    }, 15000);

    it('should pass a caller-supplied recipientRolePublicKey through to the agent and report delivered', async () => {
      const { definition, threadContextId } = await installChatProtocolWithThread();

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const { status, audienceKeyDelivery } = await dwnAlice.records.write({
        data                   : { name: 'Bob' },
        protocol               : definition.protocol,
        protocolPath           : 'thread/participant',
        parentContextId        : threadContextId,
        schema                 : definition.types.participant.schema,
        dataFormat             : 'application/json',
        recipient              : bobDid.uri,
        recipientRolePublicKey : VALID_X25519_KEY,
      });

      expect(status.code).toBe(202);
      // The delivery could only have been provisioned from the supplied key:
      // Bob has no protocol installed to resolve a role-path key from.
      expect(audienceKeyDelivery).toEqual({ delivered: true, recipientDid: bobDid.uri });

      // The key rides the agent request at the top level, never inside `messageParams`.
      const writeCall = processSpy.getCalls().find((call): boolean =>
        call.args[0].messageType === DwnInterface.RecordsWrite &&
        (call.args[0] as { messageParams?: { protocolPath?: string } }).messageParams?.protocolPath === 'thread/participant');
      expect(writeCall).toBeDefined();
      expect((writeCall!.args[0] as { recipientRolePublicKey?: DwnPublicKeyJwk }).recipientRolePublicKey).toEqual(VALID_X25519_KEY);
      expect((writeCall!.args[0] as { messageParams?: Record<string, unknown> }).messageParams!.recipientRolePublicKey).toBeUndefined();
    }, 15000);

    it('should leave audienceKeyDelivery undefined on non-role writes', async () => {
      const { definition, threadContextId } = await installChatProtocolWithThread();

      const { status, audienceKeyDelivery } = await dwnAlice.records.write({
        data            : 'hello there',
        protocol        : definition.protocol,
        protocolPath    : 'thread/chat',
        parentContextId : threadContextId,
        schema          : definition.types.chat.schema,
        dataFormat      : 'text/plain',
      });

      expect(status.code).toBe(202);
      expect(audienceKeyDelivery).toBeUndefined();
    }, 15000);
  });

  describe('Record.update()', () => {
    it('should surface audienceKeyDelivery on role-record update results', async () => {
      const { definition, threadContextId } = await installChatProtocolWithThread();

      sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
        .rejects(new Error('recipient protocol not installed'));

      const { status: writeStatus, record } = await dwnAlice.records.write({
        data            : { name: 'Bob' },
        protocol        : definition.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        schema          : definition.types.participant.schema,
        dataFormat      : 'application/json',
        recipient       : bobDid.uri,
      });
      expect(writeStatus.code).toBe(202);

      // Updating the `$role` record re-provisions delivery — the retry idiom
      // for a previously skipped best-effort delivery.
      const updateResult = await record!.update({ data: { name: 'Bob', role: 'admin' } });

      expect(updateResult.status.code).toBe(202);
      expect(updateResult.audienceKeyDelivery).toBeDefined();
      expect(updateResult.audienceKeyDelivery!.delivered).toBe(false);
      expect(updateResult.audienceKeyDelivery!.recipientDid).toBe(bobDid.uri);
    }, 15000);

    it('should retry a skipped delivery via update() with a caller-supplied recipientRolePublicKey', async () => {
      const { definition, threadContextId } = await installChatProtocolWithThread();

      // Best-effort resolution stays broken for the whole test, so only the
      // supplied key can produce a delivery on the retry.
      sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
        .rejects(new Error('recipient protocol not installed'));

      const { status: writeStatus, record, audienceKeyDelivery: writeOutcome } = await dwnAlice.records.write({
        data            : { name: 'Bob' },
        protocol        : definition.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        schema          : definition.types.participant.schema,
        dataFormat      : 'application/json',
        recipient       : bobDid.uri,
      });
      expect(writeStatus.code).toBe(202);
      expect(writeOutcome!.delivered).toBe(false);

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const updateResult = await record!.update({
        data                   : { name: 'Bob', role: 'admin' },
        recipientRolePublicKey : VALID_X25519_KEY,
      });

      expect(updateResult.status.code).toBe(202);
      expect(updateResult.audienceKeyDelivery).toEqual({ delivered: true, recipientDid: bobDid.uri });

      // The key rides the update's agent request at the top level and never
      // lands in `messageParams`, where the DWN would reject it as an
      // immutable descriptor property.
      const updateCall = processSpy.getCalls().find((call): boolean =>
        call.args[0].messageType === DwnInterface.RecordsWrite &&
        (call.args[0] as { messageParams?: { protocolPath?: string } }).messageParams?.protocolPath === 'thread/participant');
      expect(updateCall).toBeDefined();
      expect((updateCall!.args[0] as { recipientRolePublicKey?: DwnPublicKeyJwk }).recipientRolePublicKey).toEqual(VALID_X25519_KEY);
      expect((updateCall!.args[0] as { messageParams?: Record<string, unknown> }).messageParams!.recipientRolePublicKey).toBeUndefined();
    }, 15000);

    it('should leave audienceKeyDelivery undefined on non-role record updates', async () => {
      const { definition } = await installChatProtocolWithThread();

      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : { title: 'Another Thread' },
        protocol     : definition.protocol,
        protocolPath : 'thread',
        schema       : definition.types.thread.schema,
        dataFormat   : 'application/json',
      });
      expect(writeStatus.code).toBe(202);

      const updateResult = await record!.update({ data: { title: 'Renamed Thread' } });

      expect(updateResult.status.code).toBe(202);
      expect(updateResult.audienceKeyDelivery).toBeUndefined();
    }, 15000);
  });

  describe('TypedEnbox records.create() and TypedRecord.update()', () => {
    it('should forward recipientRolePublicKey and surface audienceKeyDelivery on typed create', async () => {
      const definition = makeChatDefinition();
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, {} as ChatSchemaMap));

      const { status: configureStatus } = await typed.configure();
      expect(configureStatus.code).toBe(202);

      const { record: thread } = await typed.records.create('thread', { data: { title: 'Typed Thread' } });
      expect(thread).toBeDefined();

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const createResult = await typed.records.create('thread/participant', {
        data                   : { name: 'Bob' },
        parentContextId        : thread!.contextId,
        recipient              : bobDid.uri,
        recipientRolePublicKey : VALID_X25519_KEY,
      });

      expect(createResult.status.code).toBe(202);
      expect(createResult.record).toBeDefined();
      expect(createResult.audienceKeyDelivery).toEqual({ delivered: true, recipientDid: bobDid.uri });

      // The typed surface forwards the key into the low-level write, which
      // passes it to the agent request at the top level.
      const writeCall = processSpy.getCalls().find((call): boolean =>
        call.args[0].messageType === DwnInterface.RecordsWrite &&
        (call.args[0] as { messageParams?: { protocolPath?: string } }).messageParams?.protocolPath === 'thread/participant');
      expect(writeCall).toBeDefined();
      expect((writeCall!.args[0] as { recipientRolePublicKey?: DwnPublicKeyJwk }).recipientRolePublicKey).toEqual(VALID_X25519_KEY);
    }, 15000);

    it('should surface audienceKeyDelivery on typed record update results', async () => {
      const definition = makeChatDefinition();
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, {} as ChatSchemaMap));

      const { status: configureStatus } = await typed.configure();
      expect(configureStatus.code).toBe(202);

      const { record: thread } = await typed.records.create('thread', { data: { title: 'Typed Thread' } });
      expect(thread).toBeDefined();

      sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
        .rejects(new Error('recipient protocol not installed'));

      const { record: participant, audienceKeyDelivery: createOutcome } = await typed.records.create('thread/participant', {
        data            : { name: 'Bob' },
        parentContextId : thread!.contextId,
        recipient       : bobDid.uri,
      });

      // The typed create surfaces the best-effort skip.
      expect(createOutcome).toBeDefined();
      expect(createOutcome!.delivered).toBe(false);
      expect(createOutcome!.recipientDid).toBe(bobDid.uri);

      // The typed update re-provisions delivery and surfaces the outcome too.
      const updateResult = await participant!.update({ data: { name: 'Bob', role: 'admin' } });

      expect(updateResult.status.code).toBe(202);
      expect(updateResult.audienceKeyDelivery).toBeDefined();
      expect(updateResult.audienceKeyDelivery!.delivered).toBe(false);
      expect(updateResult.audienceKeyDelivery!.recipientDid).toBe(bobDid.uri);
    }, 15000);

    it('should retry a skipped delivery via typed update() with a caller-supplied recipientRolePublicKey', async () => {
      const definition = makeChatDefinition();
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, {} as ChatSchemaMap));

      const { status: configureStatus } = await typed.configure();
      expect(configureStatus.code).toBe(202);

      const { record: thread } = await typed.records.create('thread', { data: { title: 'Typed Thread' } });
      expect(thread).toBeDefined();

      sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
        .rejects(new Error('recipient protocol not installed'));

      const { record: participant, audienceKeyDelivery: createOutcome } = await typed.records.create('thread/participant', {
        data            : { name: 'Bob' },
        parentContextId : thread!.contextId,
        recipient       : bobDid.uri,
      });
      expect(createOutcome!.delivered).toBe(false);

      const updateResult = await participant!.update({
        data                   : { name: 'Bob', role: 'admin' },
        recipientRolePublicKey : VALID_X25519_KEY,
      });

      expect(updateResult.status.code).toBe(202);
      expect(updateResult.audienceKeyDelivery).toEqual({ delivered: true, recipientDid: bobDid.uri });
    }, 15000);
  });

});
