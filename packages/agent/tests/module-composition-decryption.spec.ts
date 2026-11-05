import type { PermissionGrantEntry } from '../src/types/permissions.js';
import type { ModuleDefinition, ModuleRuleSet, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { AgentDwnApi } from '../src/dwn-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { createGrantKeyRecordsForGrants, getEncryptionKeyInfo } from '../src/dwn-encryption.js';
import { DataStream, DwnInterfaceName, DwnMethodName, Encoder, ENCRYPTION_CONTROL_DELIVERY_PATH, ROLE_AUDIENCE_DERIVATION_SCHEME } from '@enbox/dwn-sdk-js';

const membership: ModuleDefinition = {
  module    : 'https://example.com/review/membership',
  published : true,
  types     : { workspace: {}, member: {} },
  structure : {
    workspace: {
      member: { $role: true, $actions: [{ who: 'recipient', of: 'workspace/member', can: ['read'] }] },
    },
  },
};

const messages: ModuleDefinition = {
  module    : 'https://example.com/review/messages',
  published : true,
  uses      : { first: membership.module },
  types     : { reader: {}, message: { dataFormats: ['application/json'], encryptionRequired: true } },
  structure : {
    workspace: {
      $ref    : 'first:workspace',
      reader  : { $role: true, $actions: [{ who: 'recipient', of: 'workspace/reader', can: ['read'] }] },
      message : {
        $actions: [
          { role: 'first:workspace/member', can: ['read'] },
          { role: 'workspace/reader', can: ['create', 'read'] },
        ],
      },
    },
  },
};

const plaintext = '{"text":"separate control and role grants"}';
let nextFixture = 0;
let harnesses: PlatformAgentTestHarness[] = [];

async function fixture(): Promise<{
  owner: PlatformAgentTestHarness;
  member: PlatformAgentTestHarness;
  delegate: PlatformAgentTestHarness;
  alice: string;
  bob: string;
  app: string;
  workspace: RecordsWriteMessage;
  record: RecordsWriteMessage;
  ciphertext: Uint8Array;
  memberDefinition: ModuleDefinition;
}> {
  const fixtureId = nextFixture++;
  const peers = await Promise.all(['owner', 'member', 'delegate'].map(async (name): Promise<PlatformAgentTestHarness> => {
    const harness = await PlatformAgentTestHarness.setup({
      agentClass: TestAgent, agentStores: 'memory', testDataLocation: `__TESTDATA__/review-decryption-${fixtureId}-${name}`,
    });
    harnesses.push(harness);
    await harness.clearStorage();
    await harness.createAgentDid({ publish: false });
    return harness;
  }));
  const [owner, member, delegate] = peers;
  for (const harness of peers) {
    for (const peer of peers) {
      const resolution = {
        didDocument: peer.agent.agentDid.document, didDocumentMetadata: peer.agent.agentDid.metadata, didResolutionMetadata: {},
      };
      await harness.didResolverCache.set(peer.agent.agentDid.uri, resolution);
      await harness.agent.did.cacheResolution(peer.agent.agentDid.uri, resolution);
    }
  }
  // Share only the real node, never signing keys or private-key caches.
  member.agent.dwn = new AgentDwnApi({ agent: member.agent, dwn: owner.agent.dwn.node });
  delegate.agent.dwn = new AgentDwnApi({ agent: delegate.agent, dwn: owner.agent.dwn.node });
  const alice = owner.agent.agentDid.uri;
  const bob = member.agent.agentDid.uri;
  const app = delegate.agent.agentDid.uri;
  const installed = new Map<string, ModuleDefinition>();
  for (const harness of [owner, member]) {
    const did = harness.agent.agentDid.uri;
    for (const definition of [membership, messages]) {
      const result = await harness.agent.dwn.processRequest({
        author: did, target: did, messageType: DwnInterface.ModulesConfigure, messageParams: { definition },
      });
      expect(result.reply.status.code).toBe(202);
      if (harness === member) {
        installed.set(definition.module, result.message!.descriptor.definition);
      }
    }
  }
  const root = await owner.agent.dwn.processRequest({
    author        : alice, target        : alice, messageType   : DwnInterface.RecordsWrite,
    messageParams : { module: membership.module, modulePath: 'workspace', dataFormat: 'application/json' }, dataStream    : new Blob(['{}']),
  });
  expect(root.reply.status.code).toBe(202);
  const workspace = root.message!;
  for (const [module, type] of [[membership.module, 'member'], [messages.module, 'reader']]) {
    const definition = installed.get(module)!;
    const role = definition.structure.workspace[type] as ModuleRuleSet;
    const assignment = await owner.agent.dwn.processRequest({
      author                 : alice, target                 : alice, messageType            : DwnInterface.RecordsWrite,
      recipientRolePublicKey : role.$keyAgreement!.publicKeyJwk,
      messageParams          : { module, modulePath: `workspace/${type}`, recipient: bob, parentContextId: workspace.contextId, dataFormat: 'application/json' },
      dataStream             : new Blob(['{}']),
    });
    expect(assignment.reply.status.code).toBe(202);
    expect(assignment.audienceKeyDelivery?.delivered).toBe(true);
  }
  const write = await owner.agent.dwn.processRequest({
    author        : alice, target        : alice, messageType   : DwnInterface.RecordsWrite,
    messageParams : { module: messages.module, modulePath: 'workspace/message', parentContextId: workspace.contextId, dataFormat: 'application/json' },
    dataStream    : new Blob([plaintext]),
  });
  expect(write.reply.status.code).toBe(202);
  return {
    owner, member, delegate, alice, bob, app, workspace,
    record           : write.message!,
    ciphertext       : new Uint8Array(await write.data!.arrayBuffer()),
    memberDefinition : installed.get(messages.module)!,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function grant(f: Fixture, scope: { modulePath?: string; contextId?: string } = {}, deliverKey = false): Promise<PermissionGrantEntry> {
  const entry = await f.member.agent.permissions.createGrant({
    author      : f.bob, grantedTo   : f.app, delegated   : true, store       : true, dateExpires : '2999-01-01T00:00:00.000000Z',
    scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, module: messages.module, ...scope },
  });
  const { encodedData, ...message } = entry.message;
  const imported = await f.delegate.agent.dwn.processRequest({
    author      : f.app, target      : f.app, messageType : DwnInterface.RecordsWrite, rawMessage  : message, signAsOwner : true,
    dataStream  : new Blob([Encoder.base64UrlToBytes(encodedData) as BlobPart]),
  });
  expect(imported.reply.status.code).toBe(202);
  if (deliverKey) {
    const key = await getEncryptionKeyInfo(f.delegate.agent, f.app);
    await createGrantKeyRecordsForGrants({
      agent                : f.member.agent, ownerDid             : f.bob, granteeDid           : f.app, granteeRootPublicKey : key.publicKeyJwk,
      grantMessages        : [entry.message], moduleDefinitions    : [f.memberDefinition],
    });
  }
  await f.delegate.agent.permissions.clear();
  return entry;
}

async function decrypt(f: Fixture, readGrant: PermissionGrantEntry, moduleRole?: string): Promise<string> {
  const result = await f.delegate.agent.dwn.decryptRecordData({
    author         : f.bob, target         : f.alice, granteeDid     : f.app, delegatedGrant : readGrant.message,
    recordsWrite   : f.record, moduleRole, dataStream     : DataStream.fromBytes(f.ciphertext),
  });
  return Encoder.bytesToString(await DataStream.toBytes(result));
}

describe('Composed audience decryption authority', () => {
  afterEach(async () => {
    sinon.restore();
    for (const harness of harnesses.reverse()) {
      await harness.closeStorage();
    }
    harnesses = [];
  });

  it('tries the second authorized role after the first provider grant is unavailable', async () => {
    const f = await fixture();
    const authorized = await grant(f, {}, true);
    const routes = f.record.encryption!.keyEncryption.filter(entry => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME);
    expect(routes.map(entry => entry.module)).toEqual([membership.module, messages.module]);
    const requests = sinon.spy(f.delegate.agent.permissions, 'getPermissionForRequest');
    expect(await decrypt(f, authorized)).toBe(plaintext);
    expect(requests.getCalls().some(call =>
      call.args[0].module === membership.module && call.args[0].messageType === DwnInterface.RecordsRead
    )).toBe(true);
  });

  for (const kind of ['path', 'record context'] as const) {
    it(`replaces a ${kind}-scoped data grant with an approved grant covering the role`, async () => {
      const f = await fixture();
      const dataGrant = await grant(f, kind === 'path' ? { modulePath: 'workspace/message' } : { contextId: f.record.contextId });
      const roleGrant = await grant(f, { modulePath: 'workspace/reader' }, true);
      const requests = sinon.spy(f.delegate.agent, 'processDwnRequest');
      expect(await decrypt(f, dataGrant, 'workspace/reader')).toBe(plaintext);
      const reads = requests.getCalls().map(call => call.args[0]).filter(request => request.messageType === DwnInterface.RecordsQuery);
      const delivery = reads.find(request => request.messageParams?.filter?.modulePath === ENCRYPTION_CONTROL_DELIVERY_PATH);
      const role = reads.find(request => request.messageParams?.filter?.modulePath === 'workspace/reader');
      expect(delivery?.messageParams?.delegatedGrant?.recordId).toBe(roleGrant.message.recordId);
      expect(role?.messageParams?.delegatedGrant?.recordId).toBe(roleGrant.message.recordId);
    });
  }

  it('keeps context-bound key custody unsupported and selects an approved role-path grant', async () => {
    const f = await fixture();
    const contextGrant = await grant(f, { contextId: f.workspace.contextId });
    const roleGrant = await grant(f, { modulePath: 'workspace/reader' }, true);
    const requests = sinon.spy(f.delegate.agent, 'processDwnRequest');
    expect(await decrypt(f, contextGrant, 'workspace/reader')).toBe(plaintext);
    const reads = requests.getCalls().map(call => call.args[0]).filter(request => request.messageType === DwnInterface.RecordsQuery);
    expect(reads.find(request => request.messageParams?.filter?.modulePath === 'workspace/reader')?.messageParams?.delegatedGrant?.recordId)
      .toBe(roleGrant.message.recordId);
    const delivery = reads.find(request => request.messageParams?.filter?.modulePath === ENCRYPTION_CONTROL_DELIVERY_PATH);
    expect(delivery?.messageParams?.delegatedGrant?.recordId).toBe(roleGrant.message.recordId);
  });

  it('does not expand a data-only grant into permission to verify a role', async () => {
    const f = await fixture();
    const dataGrant = await grant(f, { modulePath: 'workspace/message' }, true);
    await expect(decrypt(f, dataGrant, 'workspace/reader')).rejects.toThrow();
  });
});
