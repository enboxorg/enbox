import type { AudienceKeyDeliveryOutcome } from '../src/types/dwn.js';
import type { BearerIdentity } from '../src/bearer-identity.js';
import type { PublicKeyJwk } from '@enbox/crypto';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { Ed25519 } from '@enbox/crypto';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { requireDwnServer } from './utils/require-dwn-server.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, ENCRYPTION_CONTROL_DELIVERY_PATH, getRuleSetAtPath } from '@enbox/dwn-sdk-js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// Role-audience key DELIVERY to recipients that publish no resolvable DWN.
//
// A `$encryption/delivery` record is encrypted to the *recipient's* role-path
// public key — a hardened derivation of the recipient's own encryption root, so
// only the recipient can produce it. The agent normally discovers it by resolving
// the recipient's DID to a DWN and reading its installed protocol definition. A
// bare `did:jwk` node running in "remote-only" mode (its records live only on a
// shared anchor DWN, it hosts none of its own) advertises no DWN service
// endpoint, so that resolution fails.
//
// Design A: the recipient computes its role-path public key locally and hands it
// to the owner out of band (e.g. a signed join request); the owner supplies it via
// `recipientRolePublicKey`. Supplying it asserts delivery MUST succeed (failure
// throws). Omitting it is best-effort — a recipient whose key can't be resolved is
// a supported participant state, so the `$role` write still succeeds and the
// skipped delivery is surfaced on `response.audienceKeyDelivery`, not swallowed.
//
//   1. resolvable recipient           -> resolution path works (regression guard)
//   2. remote-only recipient, no key  -> best-effort skip: write ok, delivered:false
//   3. remote-only recipient, key     -> delivery written; recipient decrypts
//   4. remote-only recipient, bad key -> strict: supplied key that can't deliver throws
// ---------------------------------------------------------------------------

const ROLE_PATH = 'thread/participant';

function chatProtocolDefinition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : `https://protocol.test/remote-only-chat/${crypto.randomUUID()}`,
    types     : {
      thread      : { schema: 'https://schemas.test/thread', dataFormats: ['application/json'] },
      participant : { schema: 'https://schemas.test/participant', dataFormats: ['application/json'] },
      chat        : { schema: 'https://schemas.test/chat', dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      thread: {
        participant : { $role: true },
        chat        : { $actions: [{ role: ROLE_PATH, can: ['read'] }] },
      },
    },
  };
}

describe('AgentDwnApi role-audience delivery to remote-only recipients', () => {
  let ownerHarness: PlatformAgentTestHarness;
  let recipientHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;
  const chat = chatProtocolDefinition();

  // Alice authors a thread, grants `recipient` the participant role (optionally
  // with a supplied role-path key), then writes one encrypted chat message and
  // pushes everything to the anchor. Returns the chat record id + plaintext.
  async function seedThreadFor(
    recipientDid: string,
    opts: { recipientRolePublicKey?: PublicKeyJwk } = {},
  ): Promise<{ chatRecordId: string; chatText: string; roleDelivery?: AudienceKeyDeliveryOutcome }> {
    const threadWrite = await ownerHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/json',
        protocol     : chat.protocol,
        protocolPath : 'thread',
        schema       : chat.types.thread.schema,
      },
      dataStream: new Blob([JSON.stringify({ title: 'remote-only thread' })]),
    });
    expect(threadWrite.reply.status.code).toBe(202);
    const threadContextId = (threadWrite.message as RecordsWriteMessage).contextId!;

    // Writing the $role record triggers audience mint + delivery provisioning.
    const roleWrite = await ownerHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat      : 'application/json',
        parentContextId : threadContextId,
        protocol        : chat.protocol,
        protocolPath    : ROLE_PATH,
        recipient       : recipientDid,
        schema          : chat.types.participant.schema,
      },
      dataStream             : new Blob([JSON.stringify({ role: 'participant' })]),
      recipientRolePublicKey : opts.recipientRolePublicKey,
    });
    expect(roleWrite.reply.status.code).toBe(202);
    const roleDelivery = roleWrite.audienceKeyDelivery;

    const chatText = `remote-only encrypted message ${crypto.randomUUID()}`;
    const chatWrite = await ownerHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat      : 'text/plain',
        parentContextId : threadContextId,
        protocol        : chat.protocol,
        protocolPath    : 'thread/chat',
        schema          : chat.types.chat.schema,
      },
      dataStream : new Blob([chatText]),
      encryption : true,
    });
    expect(chatWrite.reply.status.code).toBe(202);

    await ownerHarness.agent.sync.sync('push');

    return { chatRecordId: (chatWrite.message as RecordsWriteMessage).recordId!, chatText, roleDelivery };
  }

  // The recipient reads its delivery + the encrypted chat message straight from
  // the anchor (remote-only: it holds no local copy). The agent auto-decrypts via
  // the recipient's delivery record (resolved from the anchor) and its own root.
  async function recipientReads(recipientDid: string, chatRecordId: string): Promise<{ deliveryCount: number; text: string }> {
    const deliveryQuery = await recipientHarness.agent.dwn.sendRequest({
      author        : recipientDid,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          recipient    : recipientDid,
          protocol     : chat.protocol,
          protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
          tags         : { protocol: chat.protocol, rolePath: ROLE_PATH },
        },
      },
    });
    expect(deliveryQuery.reply.status.code).toBe(200);

    const read = await recipientHarness.agent.dwn.sendRequest({
      author        : recipientDid,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: chatRecordId }, protocolRole: ROLE_PATH },
      encryption    : true,
    });
    expect(read.reply.status.code).toBe(200);
    const bytes = await DataStream.toBytes(read.reply.entry!.data!);
    return { deliveryCount: deliveryQuery.reply.entries?.length ?? 0, text: new TextDecoder().decode(bytes) };
  }

  // A bare did:jwk identity with NO DWN service endpoint ("remote-only"): the
  // X25519 keyAgreement private key is imported so the agent can encrypt/decrypt
  // as this identity, but nothing advertises a DWN to resolve.
  async function createRemoteOnlyRecipient(name: string): Promise<BearerIdentity> {
    const identity = await recipientHarness.agent.identity.create({
      store     : true,
      didMethod : 'jwk',
      metadata  : { name },
    });
    const portable = await identity.did.export();
    const x25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({ privateKey: portable.privateKeys![0] });
    await recipientHarness.agent.keyManager.importKey({ key: x25519PrivateKey });
    return identity;
  }

  // The recipient's role-path PUBLIC key, derived from its own encryption root by
  // installing the protocol with encryption on its (local) tenant and reading back
  // the injected `$keyAgreement`. This is the value a remote-only node would assert
  // in its enrollment request for the owner to deliver to.
  async function recipientRolePublicKey(recipientDid: string): Promise<PublicKeyJwk> {
    const configure = await recipientHarness.agent.dwn.processRequest({
      author        : recipientDid,
      target        : recipientDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chat },
      encryption    : true,
    });
    expect([202, 409]).toContain(configure.reply.status.code);
    const query = await recipientHarness.agent.dwn.processRequest({
      author        : recipientDid,
      target        : recipientDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: chat.protocol } },
    });
    const definition = query.reply.entries![0].descriptor.definition;
    return getRuleSetAtPath(ROLE_PATH, definition.structure)!.$keyAgreement!.publicKeyJwk as PublicKeyJwk;
  }

  beforeAll(async () => {
    await requireDwnServer();

    ownerHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/remote-only-owner',
    });
    await ownerHarness.clearStorage();
    await ownerHarness.createAgentDid();
    await ownerHarness.agent.vault.initialize({ password: 'remote-only-recipient-delivery-owner' });

    recipientHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/remote-only-recipient',
    });
    await recipientHarness.clearStorage();
    await recipientHarness.createAgentDid();

    alice = await ownerHarness.createIdentity({ name: 'Alice Owner', testDwnUrls });

    // Alice installs the protocol locally + on the anchor, with encryption (this
    // injects Alice's role-path $keyAgreement keys used to SEAL audience keys).
    for (const remote of [false, true]) {
      const req = {
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure as const,
        messageParams : { definition: chat },
        encryption    : true as const,
      };
      const res = remote ? await ownerHarness.agent.dwn.sendRequest(req) : await ownerHarness.agent.dwn.processRequest(req);
      expect([202, 409]).toContain(res.reply.status.code);
    }

    // Registered once; each seedThreadFor pushes Alice's new records to the anchor.
    await ownerHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
  });

  afterAll(async () => {
    try { await ownerHarness.agent.sync.stopSync(); } catch { /* best effort */ }
    try { await recipientHarness.agent.sync.stopSync(); } catch { /* best effort */ }
    await ownerHarness.clearStorage();
    await ownerHarness.closeStorage();
    await recipientHarness.clearStorage();
    await recipientHarness.closeStorage();
  });

  it('delivers to a recipient with a resolvable DWN (resolution fallback path)', async () => {
    // Carol publishes a DWN and installs the protocol there, so the owner can
    // resolve her role-path key by DID resolution — no supplied key needed.
    const carol = await recipientHarness.createIdentity({ name: 'Carol Resolvable', testDwnUrls });
    const carolRemoteConfigure = await recipientHarness.agent.dwn.sendRequest({
      author        : carol.did.uri,
      target        : carol.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chat },
      encryption    : true,
    });
    expect([202, 409]).toContain(carolRemoteConfigure.reply.status.code);

    const { chatRecordId, chatText, roleDelivery } = await seedThreadFor(carol.did.uri);
    expect(roleDelivery?.delivered).toBe(true);
    const { deliveryCount, text } = await recipientReads(carol.did.uri, chatRecordId);

    expect(deliveryCount).toBe(1);
    expect(text).toBe(chatText);
  }, 120_000);

  it('reports a best-effort skip (does not fail the write) for a remote-only did:jwk with no key', async () => {
    const dave = await createRemoteOnlyRecipient('Dave Remote-Only (no key)');

    // No recipientRolePublicKey supplied, and Dave advertises no DWN to resolve,
    // so provisioning cannot build the delivery. Under Design A this is a supported
    // participant state (Dave may not need to decrypt), so the `$role` write still
    // succeeds — but the skipped delivery is surfaced on the response, not silently
    // swallowed and not fatal. A caller that requires delivery supplies the key.
    const { roleDelivery } = await seedThreadFor(dave.did.uri);
    expect(roleDelivery).toBeDefined();
    expect(roleDelivery!.delivered).toBe(false);
    expect(roleDelivery!.recipientDid).toBe(dave.did.uri);
    expect(roleDelivery!.reason).toBeTruthy();

    // With no delivery record on the anchor, Dave has nothing to decrypt with.
    const deliveryQuery = await recipientHarness.agent.dwn.sendRequest({
      author        : dave.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          recipient    : dave.did.uri,
          protocol     : chat.protocol,
          protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
          tags         : { protocol: chat.protocol, rolePath: ROLE_PATH },
        },
      },
    });
    expect(deliveryQuery.reply.status.code).toBe(200);
    expect(deliveryQuery.reply.entries?.length ?? 0).toBe(0);
  }, 120_000);

  it('delivers to a remote-only did:jwk recipient when its role-path key is supplied', async () => {
    const dave = await createRemoteOnlyRecipient('Dave Remote-Only (supplied key)');
    const suppliedKey = await recipientRolePublicKey(dave.did.uri);

    const { chatRecordId, chatText, roleDelivery } = await seedThreadFor(dave.did.uri, { recipientRolePublicKey: suppliedKey });
    expect(roleDelivery?.delivered).toBe(true);
    const { deliveryCount, text } = await recipientReads(dave.did.uri, chatRecordId);

    expect(deliveryCount).toBe(1);
    expect(text).toBe(chatText);
  }, 120_000);

  it('fails loudly (strict) when a supplied recipient key cannot be delivered to', async () => {
    const dave = await createRemoteOnlyRecipient('Dave Remote-Only (bad supplied key)');

    // Supplying a key asserts delivery MUST succeed. A structurally invalid key
    // cannot be wrapped, so provisioning fails — and because a key was supplied,
    // that surfaces as a hard error at write time rather than a best-effort skip.
    const badKey = { kty: 'OKP', crv: 'X25519', x: 'not-a-valid-x25519-public-key' } as unknown as PublicKeyJwk;
    await expect(seedThreadFor(dave.did.uri, { recipientRolePublicKey: badKey }))
      .rejects.toThrow(/supplied recipient key|not be able to decrypt/i);
  }, 120_000);
});
