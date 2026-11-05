import type { PermissionGrantEntry } from '../src/types/permissions.js';
import type { ModuleDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Encoder, ENCRYPTION_CONTROL_AUDIENCE_PATH, Jws, KeyDerivationScheme, Message } from '@enbox/dwn-sdk-js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { createGrantKeyRecordsForGrants, getEncryptionKeyInfo } from '../src/dwn-encryption.js';

const provider: ModuleDefinition = {
  module    : 'https://example.com/audience-mint/provider', published : true,
  types     : { member: {} }, structure : { member: { $role: true } },
};
const consumer: ModuleDefinition = {
  module    : 'https://example.com/audience-mint/consumer', published : true,
  uses      : { membership: provider.module }, types     : { note: { dataFormats: ['text/plain'], encryptionRequired: true } },
  structure : { note: { $actions: [{ role: 'membership:member', can: ['read'] }] } },
};

describe('fresh composed role audience authority', () => {
  let owner: PlatformAgentTestHarness;
  let delegate: PlatformAgentTestHarness;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    [owner, delegate] = await Promise.all(['owner', 'delegate'].map(async name => PlatformAgentTestHarness.setup({
      agentClass: TestAgent, agentStores: 'memory', testDataLocation: `__TESTDATA__/audience-mint-${name}`,
    })));
  });

  beforeEach(async () => {
    for (const harness of [owner, delegate]) {
      await harness.clearStorage();
      await harness.createAgentDid({ publish: false });
    }
    alice = owner.agent.agentDid.uri;
    bob = delegate.agent.agentDid.uri;
    for (const harness of [owner, delegate]) {
      for (const peer of [owner, delegate]) {
        const resolution = {
          didDocument: peer.agent.agentDid.document, didDocumentMetadata: peer.agent.agentDid.metadata, didResolutionMetadata: {},
        };
        await harness.didResolverCache.set(peer.agent.agentDid.uri, resolution);
        await harness.agent.did.cacheResolution(peer.agent.agentDid.uri, resolution);
      }
    }
    // Separate key managers share only the real multi-tenant DWN transport.
    delegate.agent.dwn = new AgentDwnApi({ agent: delegate.agent, dwn: owner.agent.dwn.node });
  });
  afterAll(async () => {
    await delegate.closeStorage();
    await owner.closeStorage();
  });

  async function install(definition: ModuleDefinition): Promise<ModuleDefinition> {
    const result = await owner.agent.processDwnRequest({
      author: alice, target: alice, messageType: DwnInterface.ModulesConfigure, messageParams: { definition },
    });
    expect(result.reply.status.code).toBe(202);
    return result.message!.descriptor.definition;
  }

  async function grant(module: string, method: 'Read' | 'Write', modulePath?: string, author = alice): Promise<PermissionGrantEntry> {
    const result = await owner.agent.permissions.createGrant({
      author, grantedTo   : bob, delegated   : true, store       : true, dateExpires : '2999-01-01T00:00:00.000000Z',
      scope       : { interface: 'Records', method, module, ...(modulePath === undefined ? {} : { modulePath }) },
    });
    const { encodedData, ...message } = result.message;
    const imported = await delegate.agent.processDwnRequest({
      author      : bob, target      : bob, messageType : DwnInterface.RecordsWrite, rawMessage  : message, signAsOwner : true,
      dataStream  : new Blob([Encoder.base64UrlToBytes(encodedData) as BlobPart]),
    });
    expect(imported.reply.status.code).toBe(202);
    return result;
  }

  async function deliverSealCoverage(permission: PermissionGrantEntry, definition: ModuleDefinition): Promise<void> {
    const key = await getEncryptionKeyInfo(delegate.agent, bob);
    const records = await createGrantKeyRecordsForGrants({
      agent                : owner.agent, ownerDid             : alice, granteeDid           : bob, granteeRootPublicKey : key.publicKeyJwk,
      grantMessages        : [permission.message], moduleDefinitions    : [definition],
    });
    expect(records.length).toBeGreaterThan(0);
  }

  async function audiences(module: string): Promise<RecordsWriteMessage[]> {
    const result = await owner.agent.processDwnRequest({
      author        : alice, target        : alice, messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { module, modulePath: ENCRYPTION_CONTROL_AUDIENCE_PATH } },
    });
    expect(result.reply.status.code).toBe(200);
    return result.reply.entries ?? [];
  }

  it.each(['inline', 'reference'] as const)('selects provider authority instead of the consumer %s write grant', async mode => {
    const installedProvider = await install(provider);
    await install(consumer);
    const consumerWrite = await grant(consumer.module, 'Write');
    // Read authority provides seal material but does not authorize audience creation.
    const providerRead = await grant(provider.module, 'Read', 'member');
    await deliverSealCoverage(providerRead, installedProvider);
    const write = (): ReturnType<typeof delegate.agent.processDwnRequest<DwnInterface.RecordsWrite>> => delegate.agent.processDwnRequest({
      author        : alice, target        : alice, granteeDid    : bob, messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module            : consumer.module, modulePath        : 'note', dataFormat        : 'text/plain',
        permissionGrantId : consumerWrite.grant.id, moduleRole        : 'membership:member',
        ...(mode === 'inline' ? { delegatedGrant: consumerWrite.message } : {}),
      },
      dataStream: new Blob(['provider-authorized audience']),
    });

    await expect(write()).rejects.toThrow('No matching permission grant');
    expect(await audiences(provider.module)).toHaveLength(0);

    const providerWrite = await grant(provider.module, 'Write', 'member');
    const written = await write();
    expect(written.reply.status.code).toBe(202);
    const controls = await audiences(provider.module);
    expect(controls).toHaveLength(1);
    expect(controls[0].authorization.authorDelegatedGrant!.recordId).toBe(providerWrite.grant.id);
    const payload = Jws.decodePlainObjectPayload(controls[0].authorization.signature);
    expect(payload.permissionGrantId).toBeUndefined();
    expect(payload.moduleRole).toBeUndefined();
    const plaintext = await owner.agent.dwn.decryptRecordData({
      author: alice, target: alice, recordsWrite: written.message!, dataStream: written.data!.stream(),
    });
    expect(Encoder.bytesToString(await DataStream.toBytes(plaintext))).toBe('provider-authorized audience');
  });

  it('reuses an accepted public audience without requesting provider write authority', async () => {
    await install(provider);
    await install(consumer);
    const initial = await owner.agent.processDwnRequest({
      author        : alice, target        : alice, messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: consumer.module, modulePath: 'note', dataFormat: 'text/plain' }, dataStream    : new Blob(['owner note']),
    });
    expect(initial.reply.status.code).toBe(202);
    const consumerWrite = await grant(consumer.module, 'Write');
    const result = await delegate.agent.processDwnRequest({
      author        : alice, target        : alice, granteeDid    : bob, messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: consumer.module, modulePath: 'note', dataFormat: 'text/plain', delegatedGrant: consumerWrite.message },
      dataStream    : new Blob(['delegate note']),
    });
    expect(result.reply.status.code).toBe(202);
    expect(await audiences(provider.module)).toHaveLength(1);
  });

  it('does not resolve an irrelevant consumer role when provider delegated authority is used', async () => {
    const installedProvider = await install(provider);
    await install(consumer);
    const consumerWrite = await grant(consumer.module, 'Write');
    const providerRead = await grant(provider.module, 'Read', 'member');
    await deliverSealCoverage(providerRead, installedProvider);
    const providerWrite = await grant(provider.module, 'Write', 'member');

    const written = await delegate.agent.processDwnRequest({
      author        : alice, target        : alice, granteeDid    : bob, messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module         : consumer.module, modulePath     : 'note', dataFormat     : 'text/plain',
        delegatedGrant : consumerWrite.message, moduleRole     : 'unknown:issuer',
      },
      dataStream: new Blob(['grant-authorized note']),
    });
    expect(written.reply.status.code).toBe(202);
    const controls = await audiences(provider.module);
    expect(controls).toHaveLength(1);
    expect(controls[0].authorization.authorDelegatedGrant!.recordId).toBe(providerWrite.grant.id);
    expect(Jws.decodePlainObjectPayload(controls[0].authorization.signature).moduleRole).toBeUndefined();
  });

  it('selects a direct provider grant before an issuer role the signer does not hold', async () => {
    const issuerProvider: ModuleDefinition = {
      ...provider,
      types     : { issuer: {}, reader: {} },
      structure : {
        issuer : { $role: true },
        reader : { $role: true, $actions: [{ role: 'issuer', can: ['create'] }] },
      },
    };
    const issuerConsumer: ModuleDefinition = {
      ...consumer,
      uses      : { a: provider.module },
      structure : { note: { $actions: [{ role: 'a:issuer', can: ['create'] }, { role: 'a:reader', can: ['read'] }] } },
    };
    await install(issuerProvider);
    await install(issuerConsumer);
    // The wallet holds the owner seal key and Bob's signer, but Bob has no issuer role record.
    await owner.agent.did.import({ portableDid: await delegate.agent.agentDid.export(), tenant: alice });
    const consumerWrite = await grant(consumer.module, 'Write');
    const providerWrite = await grant(provider.module, 'Write', 'reader');

    const written = await owner.agent.processDwnRequest({
      author        : bob, target        : alice, messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module            : consumer.module, modulePath        : 'note', dataFormat        : 'text/plain',
        permissionGrantId : consumerWrite.grant.id, moduleRole        : 'a:issuer',
      },
      dataStream: new Blob(['direct grant-authorized note']),
    });
    expect(written.reply.status.code).toBe(202);
    const controls = await audiences(provider.module);
    expect(controls).toHaveLength(1);
    expect(Message.getAuthor(controls[0])).toBe(bob);
    expect(controls[0].authorization.authorDelegatedGrant).toBeUndefined();
    const payload = Jws.decodePlainObjectPayload(controls[0].authorization.signature);
    expect(payload.permissionGrantId).toBe(providerWrite.grant.id);
    expect(payload.moduleRole).toBeUndefined();
    expect(Jws.decodePlainObjectPayload(written.message!.authorization.signature).permissionGrantId).toBe(consumerWrite.grant.id);
  });

  it('requires source-tenant administration instead of a foreign consumer author provider grant', async () => {
    const installedProvider = await install(provider);
    const publicCreate = structuredClone(consumer);
    publicCreate.structure.note.$actions!.push({ who: 'anyone', can: ['create'] });
    await install(publicCreate);
    const member = await owner.agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Foreign Consumer Author' } });
    const consumerWrite = await grant(consumer.module, 'Write', undefined, member.did.uri);
    await grant(provider.module, 'Write', 'member', member.did.uri);
    const providerRead = await grant(provider.module, 'Read', 'member');
    await deliverSealCoverage(providerRead, installedProvider);
    const write = (): ReturnType<typeof delegate.agent.processDwnRequest<DwnInterface.RecordsWrite>> => delegate.agent.processDwnRequest({
      author        : member.did.uri, target        : alice, granteeDid    : bob, messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: consumer.module, modulePath: 'note', dataFormat: 'text/plain', delegatedGrant: consumerWrite.message },
      dataStream    : new Blob(['foreign consumer author']),
    });

    await expect(write()).rejects.toThrow('No matching permission grant');
    expect(await audiences(provider.module)).toHaveLength(0);
    const sourceAuthority = await grant(provider.module, 'Write', 'member');
    const written = await write();
    expect(written.reply.status.code).toBe(202);
    expect(Message.getAuthor(written.message!)).toBe(member.did.uri);
    const controls = await audiences(provider.module);
    expect(controls).toHaveLength(1);
    expect(Message.getAuthor(controls[0])).toBe(alice);
    expect(controls[0].authorization.authorDelegatedGrant!.recordId).toBe(sourceAuthority.grant.id);
  });

  it('translates a nondelegate issuer role into the provider namespace without a grant', async () => {
    const issuerProvider: ModuleDefinition = {
      ...provider,
      types     : { issuer: {}, reader: {} },
      structure : {
        issuer : { $role: true },
        reader : { $role: true, $actions: [{ role: 'issuer', can: ['create'] }] },
      },
    };
    const issuerConsumer: ModuleDefinition = {
      ...consumer,
      uses      : { a: provider.module },
      structure : { note: { $actions: [{ role: 'a:issuer', can: ['create'] }, { role: 'a:reader', can: ['read'] }] } },
    };
    await install(issuerProvider);
    await install(issuerConsumer);
    // This wallet explicitly controls Alice's seal key and Bob's signing key;
    // role authorization alone does not supply the required owner seal custody.
    await owner.agent.did.import({ portableDid: await delegate.agent.agentDid.export(), tenant: alice });
    const bobDeriver = await owner.agent.dwn.getEncryptionKeyDeriver(bob);
    const issuerRoleKey = await bobDeriver.derivePublicKey([KeyDerivationScheme.ModulePath, provider.module, 'issuer']);
    const assignment = await owner.agent.processDwnRequest({
      author                 : alice,
      target                 : alice,
      messageType            : DwnInterface.RecordsWrite,
      recipientRolePublicKey : issuerRoleKey,
      messageParams          : {
        module: provider.module, modulePath: 'issuer', recipient: bob, dataFormat: 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(assignment.reply.status.code).toBe(202);
    expect((await audiences(provider.module)).some(record => record.descriptor.tags!.rolePath === 'reader')).toBe(false);

    const written = await owner.agent.processDwnRequest({
      author        : bob, target        : alice, messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: consumer.module, modulePath: 'note', dataFormat: 'text/plain', moduleRole: 'a:issuer' },
      dataStream    : new Blob(['issuer-authorized audience']),
    });
    expect(written.reply.status.code).toBe(202);
    const readerAudiences = (await audiences(provider.module)).filter(record => record.descriptor.tags!.rolePath === 'reader');
    expect(readerAudiences).toHaveLength(1);
    const control = readerAudiences[0];
    expect(Message.getAuthor(control)).toBe(bob);
    expect(control.authorization.authorDelegatedGrant).toBeUndefined();
    const payload = Jws.decodePlainObjectPayload(control.authorization.signature);
    expect(payload.moduleRole).toBe('issuer');
    expect(payload.permissionGrantId).toBeUndefined();
    expect(Jws.decodePlainObjectPayload(written.message!.authorization.signature).moduleRole).toBe('a:issuer');
  });

  it.each(['inline', 'reference'] as const)('preserves native pending-parent initialization with %s role-write authority', async mode => {
    const definition: ModuleDefinition = {
      module    : 'https://example.com/audience-mint/native', published : true,
      types     : { note: { dataFormats: ['text/plain'], encryptionRequired: true }, member: {} },
      structure : { note: { $actions: [{ role: 'note/member', can: ['read'] }], member: { $role: true } } },
    };
    const installed = await install(definition);
    const writeGrant = await grant(definition.module, 'Write', 'note');
    await deliverSealCoverage(writeGrant, installed);
    const result = await delegate.agent.processDwnRequest({
      author        : alice, target        : alice, granteeDid    : bob, messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module: definition.module, modulePath: 'note', dataFormat: 'text/plain',
        ...(mode === 'inline' ? { delegatedGrant: writeGrant.message } : { permissionGrantId: writeGrant.grant.id }),
      },
      dataStream: new Blob(['pending context']),
    });
    expect(result.reply.status.code).toBe(202);
    const controls = await audiences(definition.module);
    expect(controls).toHaveLength(1);
    expect(controls[0].descriptor.tags!.contextId).toBe(result.message!.contextId);
    expect(controls[0].authorization.authorDelegatedGrant!.recordId).toBe(writeGrant.grant.id);
  });
});
