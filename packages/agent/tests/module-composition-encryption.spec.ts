import type { ModuleDefinition, ModuleRuleSet, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, Encoder, ROLE_AUDIENCE_DERIVATION_SCHEME } from '@enbox/dwn-sdk-js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { createGrantKeyRecordsForGrants, getEncryptionKeyInfo } from '../src/dwn-encryption.js';

const core: ModuleDefinition = {
  module    : 'https://example.com/composition/membership',
  published : true,
  types     : {
    workspace : { dataFormats: ['application/json'], encryptionRequired: false },
    member    : { dataFormats: ['application/json'], encryptionRequired: false },
  },
  structure: {
    workspace: {
      $actions : [{ who: 'anyone', can: ['read'] }],
      member   : {
        $role    : true,
        $actions : [{ who: 'recipient', of: 'workspace/member', can: ['read'] }],
      },
    },
  },
};

const documents: ModuleDefinition = {
  module    : 'https://example.com/composition/documents',
  published : true,
  uses      : { membership: core.module },
  types     : { document: { dataFormats: ['application/json'], encryptionRequired: true } },
  structure : {
    workspace: {
      $ref     : 'membership:workspace',
      document : { $actions: [{ role: 'membership:workspace/member', can: ['create', 'read'] }] },
    },
  },
};

const comments: ModuleDefinition = {
  module    : 'https://example.com/composition/comments',
  published : true,
  uses      : { documents: documents.module, membership: core.module },
  types     : { comment: { dataFormats: ['application/json'], encryptionRequired: true } },
  structure : {
    document: {
      $ref    : 'documents:workspace/document',
      comment : { $actions: [{ role: 'membership:workspace/member', can: ['create', 'read'] }] },
    },
  },
};

describe('Agent encrypted module composition', () => {
  let owner: PlatformAgentTestHarness;
  let member: PlatformAgentTestHarness;
  let delegate: PlatformAgentTestHarness;

  beforeAll(async () => {
    [owner, member, delegate] = await Promise.all(['owner', 'member', 'delegate'].map(async name => {
      const harness = await PlatformAgentTestHarness.setup({
        agentClass       : TestAgent,
        agentStores      : 'memory',
        testDataLocation : `__TESTDATA__/module-composition-${name}`,
      });
      await harness.clearStorage();
      await harness.createAgentDid({ publish: false });
      return harness;
    }));
    for (const harness of [owner, member, delegate]) {
      for (const peer of [owner, member, delegate]) {
        await harness.didResolverCache.set(peer.agent.agentDid.uri, {
          didDocument           : peer.agent.agentDid.document,
          didDocumentMetadata   : peer.agent.agentDid.metadata,
          didResolutionMetadata : {},
        });
        await harness.agent.did.cacheResolution(peer.agent.agentDid.uri, {
          didDocument           : peer.agent.agentDid.document,
          didDocumentMetadata   : peer.agent.agentDid.metadata,
          didResolutionMetadata : {},
        });
      }
    }
    // Distinct agents retain separate private-key custody while issuing real signed
    // operations against the same multi-tenant DWN, without a transport stub.
    member.agent.dwn = new AgentDwnApi({ agent: member.agent, dwn: owner.agent.dwn.node });
    delegate.agent.dwn = new AgentDwnApi({ agent: delegate.agent, dwn: owner.agent.dwn.node });
  });

  afterAll(async () => {
    for (const harness of [delegate, member, owner]) {
      await harness.closeStorage();
    }
  });

  it('binds an extension-owned role to the physical context of a deep attachment', async () => {
    const alice = owner.agent.agentDid.uri;
    const bob = member.agent.agentDid.uri;
    const extension: ModuleDefinition = {
      module    : 'https://example.com/composition/local-audience',
      published : true,
      uses      : { documents: documents.module },
      types     : {
        member : { dataFormats: ['application/json'] },
        note   : { dataFormats: ['application/json'], encryptionRequired: true },
      },
      structure: {
        document: {
          $ref   : 'documents:workspace/document',
          member : { $role: true, $actions: [{ who: 'recipient', of: 'document/member', can: ['read'] }] },
          note   : { $actions: [{ role: 'document/member', can: ['read'] }] },
        },
      },
    };
    for (const harness of [owner, member]) {
      const did = harness.agent.agentDid.uri;
      for (const definition of [core, documents, extension]) {
        const result = await harness.agent.dwn.processRequest({
          author: did, target: did, messageType: DwnInterface.ModulesConfigure, messageParams: { definition },
        });
        expect(result.reply.status.code).toBe(202);
      }
    }
    const create = async (module: string, modulePath: string, parentContextId?: string): Promise<RecordsWriteMessage> => {
      const result = await owner.agent.dwn.processRequest({
        author        : alice, target        : alice, messageType   : DwnInterface.RecordsWrite,
        messageParams : { module, modulePath, parentContextId, dataFormat: 'application/json' },
        dataStream    : new Blob(['{"value":"deep context"}']),
      });
      expect(result.reply.status.code).toBe(202);
      return result.message!;
    };
    const workspace = await create(core.module, 'workspace');
    const document = await create(documents.module, 'workspace/document', workspace.contextId);
    const installed = await member.agent.dwn.processRequest({
      author: bob, target: bob, messageType: DwnInterface.ModulesQuery, messageParams: { filter: { module: extension.module } },
    });
    const memberRule = installed.reply.entries![0].descriptor.definition.structure.document.member as ModuleRuleSet;
    const assignment = await owner.agent.dwn.processRequest({
      author                 : alice, target                 : alice, messageType            : DwnInterface.RecordsWrite,
      recipientRolePublicKey : memberRule.$keyAgreement!.publicKeyJwk,
      messageParams          : {
        module          : extension.module, modulePath      : 'document/member', parentContextId : document.contextId,
        recipient       : bob, dataFormat      : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(assignment.reply.status.code).toBe(202);
    expect(assignment.audienceKeyDelivery?.delivered).toBe(true);
    const note = await create(extension.module, 'document/note', document.contextId);
    const read = await member.agent.dwn.processRequest({
      author        : bob, target        : alice, messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: note.recordId }, moduleRole: 'document/member' },
    });
    expect(read.reply.status.code).toBe(200);
    const plaintext = await member.agent.dwn.decryptRecordData({
      author: bob, target: alice, recordsWrite: note, moduleRole: 'document/member', dataStream: read.reply.entry!.data!,
    });
    expect(Encoder.bytesToString(await DataStream.toBytes(plaintext))).toBe('{"value":"deep context"}');
  });

  it('replays a member-authored encrypted extension and hydrates delegates only through approved provider grants', async () => {
    const alice = owner.agent.agentDid.uri;
    const bob = member.agent.agentDid.uri;
    const carol = delegate.agent.agentDid.uri;
    for (const definition of [core, documents, comments]) {
      const { reply } = await owner.agent.dwn.processRequest({
        author: alice, target: alice, messageType: DwnInterface.ModulesConfigure, messageParams: { definition },
      });
      expect(reply.status.code).toBe(202);
    }
    const memberInstall = await member.agent.dwn.processRequest({
      author: bob, target: bob, messageType: DwnInterface.ModulesConfigure, messageParams: { definition: core },
    });
    expect(memberInstall.reply.status.code).toBe(202);
    const memberDefinition = await member.agent.dwn.processRequest({
      author: bob, target: bob, messageType: DwnInterface.ModulesQuery, messageParams: { filter: { module: core.module } },
    });
    const installedCore = memberDefinition.reply.entries![0].descriptor.definition;
    const recipientRolePublicKey = (installedCore.structure.workspace.member as ModuleRuleSet).$keyAgreement!.publicKeyJwk;
    expect(recipientRolePublicKey).toBeDefined();

    const workspace = await owner.agent.dwn.processRequest({
      author        : alice, target        : alice, messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: core.module, modulePath: 'workspace', dataFormat: 'application/json' },
      dataStream    : new Blob(['{"title":"Shared workspace"}']),
    });
    expect(workspace.reply.status.code).toBe(202);
    const assignment = await owner.agent.dwn.processRequest({
      author        : alice, target        : alice, messageType   : DwnInterface.RecordsWrite, recipientRolePublicKey,
      messageParams : {
        module          : core.module, modulePath      : 'workspace/member', parentContextId : workspace.message!.contextId,
        recipient       : bob, dataFormat      : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(assignment.reply.status.code).toBe(202);
    expect(assignment.audienceKeyDelivery?.delivered).toBe(true);

    const document = await owner.agent.dwn.processRequest({
      author        : alice, target        : alice, messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module          : documents.module, modulePath      : 'workspace/document', parentContextId : workspace.message!.contextId,
        dataFormat      : 'application/json',
      },
      dataStream: new Blob(['{"title":"Launch"}']),
    });
    expect(document.reply.status.code).toBe(202);
    const plaintext = '{"text":"foreign audience, physical ancestry"}';
    const role = 'membership:workspace/member';
    const comment = await member.agent.dwn.processRequest({
      author        : bob, target        : alice, messageType   : DwnInterface.RecordsWrite,
      store         : false,
      messageParams : {
        module          : comments.module, modulePath      : 'document/comment', parentContextId : document.message!.contextId,
        dataFormat      : 'application/json', moduleRole      : role,
      },
      dataStream: new Blob([plaintext]),
    });
    expect(comment.reply.status.code).toBe(202);
    const written = comment.message as RecordsWriteMessage;
    expect(written.contextId?.split('/')).toHaveLength(3);
    expect(written.encryption!.keyEncryption.some(entry =>
      entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
      'rolePath' in entry && entry.module === core.module && entry.rolePath === 'workspace/member'
    )).toBe(true);
    // All definitions, parent records and audience controls are available locally.
    // Prepare the signed ciphertext without publishing, then replay it unchanged.
    expect(await owner.agent.dwn.applyReplicatedMessage(alice, written, {
      dataStream: comment.data!.stream(),
    })).toMatchObject({ kind: 'Applied' });
    expect(await owner.agent.dwn.applyReplicatedMessage(alice, written, {
      dataStream: comment.data!.stream(),
    })).toEqual({ kind: 'Duplicate', materialized: true });

    const ownerPlaintext = await owner.agent.dwn.decryptRecordData({
      author: alice, target: alice, recordsWrite: written, dataStream: comment.data!.stream(),
    });
    expect(Encoder.bytesToString(await DataStream.toBytes(ownerPlaintext))).toBe(plaintext);

    const read = await member.agent.dwn.processRequest({
      author        : bob, target        : alice, messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: written.recordId }, moduleRole: role },
    });
    expect(read.reply.status.code).toBe(200);
    const ciphertext = await DataStream.toBytes(read.reply.entry!.data!);
    const decoded = await member.agent.dwn.decryptRecordData({
      author: bob, target: alice, recordsWrite: written, moduleRole: role, dataStream: DataStream.fromBytes(ciphertext),
    });
    expect(Encoder.bytesToString(await DataStream.toBytes(decoded))).toBe(plaintext);

    const consumerGrant = await member.agent.permissions.createGrant({
      author      : bob, grantedTo   : carol, delegated   : true, store       : true, dateExpires : '2999-01-01T00:00:00.000000Z',
      scope       : { interface: 'Records', method: 'Read', module: comments.module },
    });
    const delegatedRead = await delegate.agent.dwn.processRequest({
      author        : bob, target        : alice, granteeDid    : carol, messageType   : DwnInterface.RecordsRead,
      messageParams : { delegatedGrant: consumerGrant.message, filter: { recordId: written.recordId }, moduleRole: role },
    });
    expect(delegatedRead.reply.status.code).toBe(200);
    const delegatedCiphertext = await DataStream.toBytes(delegatedRead.reply.entry!.data!);
    await expect(delegate.agent.dwn.decryptRecordData({
      author         : bob, target         : alice, granteeDid     : carol, delegatedGrant : consumerGrant.message,
      recordsWrite   : written, moduleRole     : role, dataStream     : DataStream.fromBytes(delegatedCiphertext),
    })).rejects.toThrow();

    const providerGrant = await member.agent.permissions.createGrant({
      author      : bob, grantedTo   : carol, delegated   : true, store       : true, dateExpires : '2999-01-01T00:00:00.000000Z',
      scope       : { interface: 'Records', method: 'Read', module: core.module },
    });
    for (const grant of [consumerGrant, providerGrant]) {
      const { encodedData, ...message } = grant.message;
      const imported = await delegate.agent.dwn.processRequest({
        author      : carol,
        target      : carol,
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : message,
        signAsOwner : true,
        dataStream  : new Blob([Encoder.base64UrlToBytes(encodedData) as BlobPart]),
      });
      expect(imported.reply.status.code).toBe(202);
    }
    const delegateKey = await getEncryptionKeyInfo(delegate.agent, carol);
    await createGrantKeyRecordsForGrants({
      agent                : member.agent, ownerDid             : bob, granteeDid           : carol, granteeRootPublicKey : delegateKey.publicKeyJwk,
      grantMessages        : [providerGrant.message], moduleDefinitions    : [installedCore],
    });
    await delegate.agent.permissions.clear();
    const delegatedPlaintext = await delegate.agent.dwn.decryptRecordData({
      author         : bob, target         : alice, granteeDid     : carol, delegatedGrant : consumerGrant.message,
      recordsWrite   : written, moduleRole     : role, dataStream     : DataStream.fromBytes(delegatedCiphertext),
    });
    expect(Encoder.bytesToString(await DataStream.toBytes(delegatedPlaintext))).toBe(plaintext);
  });
});
