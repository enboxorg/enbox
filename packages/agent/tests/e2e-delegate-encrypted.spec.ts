/**
 * e2e: delegate + encrypted module
 *
 * Verifies the durable grantKey path used by delegate sessions. Connect
 * responses no longer carry decryption keys; delegates hydrate grantKey
 * records from their DWN when a decryptor cache miss occurs.
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { PublicKeyJwk } from '@enbox/crypto';
import type { ModuleDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { createImportedDelegateDid } from './utils/delegate-did.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

import { AudienceDecryptError, createGrantKeyRecordsForGrants, getEncryptionKeyInfo, resolveKeyDecrypter } from '../src/dwn-encryption.js';
import { ContentEncryptionAlgorithm, DataStream, DwnInterfaceName, DwnMethodName, Encoder, EncryptionModule, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

const encryptedNoteModule: ModuleDefinition = {
  published : true,
  module    : 'https://module.xyz/e2e-delegate-encrypted-notes',
  types     : {
    note: {
      schema             : 'https://schemas.xyz/note',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: { note: {} },
};

const multiTypeModule: ModuleDefinition = {
  published : true,
  module    : 'https://module.xyz/e2e-delegate-multi-type',
  types     : {
    note: {
      schema             : 'https://schemas.xyz/note',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
    comment: {
      schema             : 'https://schemas.xyz/comment',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: { note: {}, comment: {} },
};

async function queryRawEntry(
  harness: PlatformAgentTestHarness,
  authorDid: string,
  module: string,
): Promise<RecordsWriteMessage | undefined> {
  const { reply } = await harness.agent.processDwnRequest({
    author        : authorDid,
    target        : authorDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : { filter: { module } },
  });
  return reply.entries?.[0] as RecordsWriteMessage | undefined;
}

async function applyDataEncodedRecord(
  harness: PlatformAgentTestHarness,
  tenantDid: string,
  record: RecordsWriteMessage & { encodedData: string },
): Promise<void> {
  const { encodedData, ...rawMessage } = record;
  const applyReply = await harness.agent.dwn.processRawMessage(
    tenantDid,
    rawMessage as any,
    { dataStream: DataStream.fromBytes(Encoder.base64UrlToBytes(encodedData)) },
  );

  expect([202, 409]).toContain(applyReply.status.code);
}

async function copyModuleToHarness(
  source: PlatformAgentTestHarness,
  destination: PlatformAgentTestHarness,
  tenantDid: string,
  module: string,
): Promise<void> {
  const { reply } = await source.agent.processDwnRequest({
    author        : tenantDid,
    target        : tenantDid,
    messageType   : DwnInterface.ModulesQuery,
    messageParams : { filter: { module } },
  });
  const applyReply = await destination.agent.dwn.processRawMessage(
    tenantDid,
    reply.entries![0] as any,
  );
  expect(applyReply.status.code).toBe(202);
}

async function copyRecordToHarness(
  source: PlatformAgentTestHarness,
  destination: PlatformAgentTestHarness,
  tenantDid: string,
  recordId: string,
): Promise<void> {
  const { reply } = await source.agent.processDwnRequest({
    author        : tenantDid,
    target        : tenantDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId } },
  });
  expect(reply.status.code).toBe(200);
  expect(reply.entry?.recordsWrite).toBeDefined();
  expect(reply.entry?.data).toBeDefined();

  const dataBytes = await DataStream.toBytes(reply.entry!.data!);
  const applyReply = await destination.agent.dwn.processRawMessage(
    tenantDid,
    reply.entry!.recordsWrite as any,
    { dataStream: DataStream.fromBytes(dataBytes) },
  );
  expect(applyReply.status.code).toBe(202);
}

/** Decrypts one raw RecordsRead entry through the application data boundary. */
async function readApplicationText(
  harness: PlatformAgentTestHarness,
  author: string,
  target: string,
  entry: { data: ReadableStream<Uint8Array>; recordsWrite: RecordsWriteMessage },
  granteeDid?: string,
): Promise<string> {
  const decrypted = await harness.agent.dwn.decryptRecordData({
    author,
    dataStream   : entry.data,
    granteeDid,
    recordsWrite : entry.recordsWrite,
    target,
  });
  return new TextDecoder().decode(await DataStream.toBytes(decrypted));
}

async function installModule(
  harness: PlatformAgentTestHarness,
  tenantDid: string,
  definition: ModuleDefinition,
): Promise<void> {
  const { reply } = await harness.agent.processDwnRequest({
    author        : tenantDid,
    target        : tenantDid,
    messageType   : DwnInterface.ModulesConfigure,
    messageParams : { definition },
  });
  expect(reply.status.code).toBe(202);
}

async function createReadGrantAndGrantKey(params: {
  walletHarness: PlatformAgentTestHarness;
  delegateHarness: PlatformAgentTestHarness;
  walletDid: string;
  delegateDid: string;
  delegateRootPublicKey?: PublicKeyJwk;
  delegateX25519PrivateKey?: any;
  module: string;
  modulePath?: string;
}): Promise<{ grant: any; grantId: string; grantKeyRecords: Array<RecordsWriteMessage & { encodedData: string }> }> {
  const readGrant = await params.walletHarness.agent.permissions.createGrant({
    author      : params.walletDid,
    dateExpires : '2040-06-25T16:09:16.693356Z',
    delegated   : true,
    grantedTo   : params.delegateDid,
    scope       : {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
      module    : params.module,
      ...(params.modulePath === undefined ? {} : { modulePath: params.modulePath }),
    },
    store: true,
  });

  await applyDataEncodedRecord(
    params.delegateHarness,
    params.walletDid,
    readGrant.message as RecordsWriteMessage & { encodedData: string },
  );

  if ((params.delegateX25519PrivateKey === undefined) === (params.delegateRootPublicKey === undefined)) {
    throw new Error('test helper requires exactly one delegate key input.');
  }

  const grantKeyRecords = await createGrantKeyRecordsForGrants({
    agent      : params.walletHarness.agent,
    ownerDid   : params.walletDid,
    granteeDid : params.delegateDid,
    ...(params.delegateX25519PrivateKey !== undefined
      ? { granteeRootPrivateKey: params.delegateX25519PrivateKey }
      : { granteeRootPublicKey: params.delegateRootPublicKey }),
    grantMessages: [readGrant.message as any],
  });
  expect(grantKeyRecords).toHaveLength(1);
  expect(grantKeyRecords[0].descriptor.module).toBe(EncryptionModule.uri);
  expect(grantKeyRecords[0].descriptor.modulePath).toBe(
    params.delegateX25519PrivateKey === undefined
      ? EncryptionModule.wrappedGrantKeyPath
      : EncryptionModule.grantKeyPath,
  );
  expect(grantKeyRecords[0].descriptor.recipient).toBe(params.delegateDid);
  await applyDataEncodedRecord(
    params.delegateHarness,
    params.walletDid,
    grantKeyRecords[0] as RecordsWriteMessage & { encodedData: string },
  );

  return {
    grant           : readGrant.grant,
    grantId         : readGrant.grant.id,
    grantKeyRecords : grantKeyRecords as Array<RecordsWriteMessage & { encodedData: string }>,
  };
}

describe('e2e: delegate + encrypted module', () => {
  let walletHarness: PlatformAgentTestHarness;
  let delegateHarness: PlatformAgentTestHarness;
  let walletIdentity: BearerIdentity;

  beforeAll(async () => {
    walletHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-delegate-encrypted-wallet',
    });

    delegateHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-delegate-encrypted-delegate',
    });
  });

  afterAll(async () => {
    await walletHarness.clearStorage();
    await walletHarness.closeStorage();
    await delegateHarness.clearStorage();
    await delegateHarness.closeStorage();
  });

  beforeEach(async () => {
    await walletHarness.clearStorage();
    await walletHarness.createAgentDid();
    await delegateHarness.clearStorage();
    await delegateHarness.createAgentDid();

    walletIdentity = await walletHarness.createIdentity({
      name        : 'Alice',
      testDwnUrls : [testDwnUrl],
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should inject $keyAgreement keys when installing an encrypted module', async () => {
    await installModule(walletHarness, walletIdentity.did.uri, encryptedNoteModule);

    const { reply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module: encryptedNoteModule.module } },
    });

    const installedDefinition = (reply.entries![0] as any).descriptor.definition;
    expect(installedDefinition.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
    expect(installedDefinition.structure.note.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
  });

  it('should produce encrypted modulePath records for encrypted module types', async () => {
    await installModule(walletHarness, walletIdentity.did.uri, encryptedNoteModule);

    const { reply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : encryptedNoteModule.module,
        modulePath : 'note',
        schema     : 'https://schemas.xyz/note',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode('This is a secret delegate note'),
      },
    });
    expect(reply.status.code).toBe(202);

    const rawEntry = await queryRawEntry(
      walletHarness,
      walletIdentity.did.uri,
      encryptedNoteModule.module,
    );
    expect(rawEntry?.encryption?.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
    expect(rawEntry?.encryption?.keyEncryption).toHaveLength(1);
    expect(rawEntry!.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ModulePath);
  });

  it('should hydrate delivered keys from durable grantKey records on cache miss and fail closed after revocation', async () => {
    await installModule(walletHarness, walletIdentity.did.uri, encryptedNoteModule);

    const noteData = 'Secret note from durable grantKey';
    const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : encryptedNoteModule.module,
        modulePath : 'note',
        schema     : 'https://schemas.xyz/note',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode(noteData),
      },
    });

    const { delegateDid, delegateX25519PrivateKey } = await createImportedDelegateDid(delegateHarness);
    const { grant, grantId } = await createReadGrantAndGrantKey({
      delegateDid,
      delegateHarness,
      delegateX25519PrivateKey,
      module    : encryptedNoteModule.module,
      walletDid : walletIdentity.did.uri,
      walletHarness,
    });

    await copyModuleToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, encryptedNoteModule.module);
    await copyRecordToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, (noteWrite as RecordsWriteMessage).recordId);

    delegateHarness.agent.dwn.clearDelegateDecryptionKeys(delegateDid);
    expect(await delegateHarness.agent.did.get({ didUri: walletIdentity.did.uri })).toBeUndefined();

    const { reply } = await delegateHarness.agent.processDwnRequest({
      author        : delegateDid,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter            : { recordId: (noteWrite as RecordsWriteMessage).recordId },
        permissionGrantId : grantId,
      },
      granteeDid: delegateDid,
    });

    expect(reply.status.code).toBe(200);
    expect(await readApplicationText(
      delegateHarness,
      delegateDid,
      walletIdentity.did.uri,
      reply.entry!,
      delegateDid,
    )).toBe(noteData);

    const revocation = await walletHarness.agent.permissions.createRevocation({
      author : walletIdentity.did.uri,
      grant,
      store  : true,
    });
    await applyDataEncodedRecord(
      delegateHarness,
      walletIdentity.did.uri,
      revocation.message as RecordsWriteMessage & { encodedData: string },
    );

    const delegateDecryptionKeyCache = {
      get : sinon.stub().returns(undefined),
      set : sinon.stub(),
    };
    let caught: unknown;
    try {
      await resolveKeyDecrypter({
        agent        : delegateHarness.agent,
        authorDid    : delegateDid,
        delegateDecryptionKeyCache,
        granteeDid   : delegateDid,
        recordsWrite : noteWrite as RecordsWriteMessage,
        targetDid    : walletIdentity.did.uri,
      });
    } catch (error) {
      caught = error;
    }
    // The failure is typed: the revoked grantKey is no longer logger-swallowed — it
    // surfaces as error data on the AudienceDecryptError detail.
    expect(caught).toBeInstanceOf(AudienceDecryptError);
    const decryptError = caught as AudienceDecryptError;
    expect(decryptError.cause).toBe('unknown');
    expect(decryptError.message).toContain('no delivered decryption key covers encrypted record');
    expect(decryptError.detail).toContain('Skipped grantKey');
    expect(decryptError.detail).toContain('revoked permission grant');
    expect(delegateDecryptionKeyCache.set.called).toBe(false);
  });

  it('should hydrate wrapped durable grantKeys for a pre-supplied delegate DID', async () => {
    await installModule(walletHarness, walletIdentity.did.uri, encryptedNoteModule);

    const noteData = 'Secret note from wrapped durable grantKey';
    const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : encryptedNoteModule.module,
        modulePath : 'note',
        schema     : 'https://schemas.xyz/note',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode(noteData),
      },
    });

    const { delegateDid } = await createImportedDelegateDid(delegateHarness);
    const delegateRootPublicKey = (await getEncryptionKeyInfo(delegateHarness.agent, delegateDid)).publicKeyJwk;
    const { grantId, grantKeyRecords } = await createReadGrantAndGrantKey({
      delegateDid,
      delegateHarness,
      delegateRootPublicKey,
      module    : encryptedNoteModule.module,
      walletDid : walletIdentity.did.uri,
      walletHarness,
    });

    expect(grantKeyRecords[0].encryption).toBeUndefined();

    await copyModuleToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, encryptedNoteModule.module);
    await copyRecordToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, (noteWrite as RecordsWriteMessage).recordId);

    delegateHarness.agent.dwn.clearDelegateDecryptionKeys(delegateDid);

    const { reply } = await delegateHarness.agent.processDwnRequest({
      author        : delegateDid,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter            : { recordId: (noteWrite as RecordsWriteMessage).recordId },
        permissionGrantId : grantId,
      },
      granteeDid: delegateDid,
    });

    expect(reply.status.code).toBe(200);
    expect(await readApplicationText(
      delegateHarness,
      delegateDid,
      walletIdentity.did.uri,
      reply.entry!,
      delegateDid,
    )).toBe(noteData);
  });

  it('should hydrate modulePath-scoped durable grantKeys without owner KMS fallback', async () => {
    await installModule(walletHarness, walletIdentity.did.uri, multiTypeModule);

    const noteData = 'Secret path-scoped note from durable grantKey';
    const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : multiTypeModule.module,
        modulePath : 'note',
        schema     : 'https://schemas.xyz/note',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode(noteData),
      },
    });

    const { delegateDid, delegateX25519PrivateKey } = await createImportedDelegateDid(delegateHarness);
    const { grantId } = await createReadGrantAndGrantKey({
      delegateDid,
      delegateHarness,
      delegateX25519PrivateKey,
      module     : multiTypeModule.module,
      modulePath : 'note',
      walletDid  : walletIdentity.did.uri,
      walletHarness,
    });

    await copyModuleToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, multiTypeModule.module);
    await copyRecordToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, (noteWrite as RecordsWriteMessage).recordId);

    const { reply } = await delegateHarness.agent.processDwnRequest({
      author        : delegateDid,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter            : { recordId: (noteWrite as RecordsWriteMessage).recordId },
        permissionGrantId : grantId,
      },
      granteeDid: delegateDid,
    });

    expect(reply.status.code).toBe(200);
    expect(await readApplicationText(
      delegateHarness,
      delegateDid,
      walletIdentity.did.uri,
      reply.entry!,
      delegateDid,
    )).toBe(noteData);
  });

  it('should install, write, and read encrypted records as owner', async () => {
    await installModule(walletHarness, walletIdentity.did.uri, encryptedNoteModule);

    const noteData = 'Owner secret note';
    const { reply: writeReply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : encryptedNoteModule.module,
        modulePath : 'note',
        schema     : 'https://schemas.xyz/note',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode(noteData),
      },
    });
    expect(writeReply.status.code).toBe(202);

    const { reply: readReply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { module: encryptedNoteModule.module } },
    });

    expect(readReply.status.code).toBe(200);
    expect(await readApplicationText(
      walletHarness,
      walletIdentity.did.uri,
      walletIdentity.did.uri,
      readReply.entry!,
    )).toBe(noteData);
    expect((await queryRawEntry(walletHarness, walletIdentity.did.uri, encryptedNoteModule.module))?.encryption).toBeDefined();
  });
});
