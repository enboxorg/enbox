/**
 * e2e: delegate + encrypted protocol
 *
 * Verifies the durable grantKey path used by delegate sessions. Connect
 * responses no longer carry decryption keys; delegates hydrate grantKey
 * records from their DWN when a decryptor cache miss occurs.
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { PublicKeyJwk } from '@enbox/crypto';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { createImportedDelegateDid } from './utils/delegate-did.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

import { AudienceDecryptError, createGrantKeyRecordsForGrants, getEncryptionKeyInfo, resolveKeyDecrypter } from '../src/dwn-encryption.js';
import { ContentEncryptionAlgorithm, DataStream, DwnInterfaceName, DwnMethodName, Encoder, EncryptionProtocol, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

const encryptedNoteProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-delegate-encrypted-notes',
  types     : {
    note: {
      schema             : 'https://schemas.xyz/note',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: { note: {} },
};

const multiTypeProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-delegate-multi-type',
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
  protocol: string,
): Promise<RecordsWriteMessage | undefined> {
  const { reply } = await harness.agent.processDwnRequest({
    author        : authorDid,
    target        : authorDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : { filter: { protocol } },
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

async function copyProtocolToHarness(
  source: PlatformAgentTestHarness,
  destination: PlatformAgentTestHarness,
  tenantDid: string,
  protocol: string,
): Promise<void> {
  const { reply } = await source.agent.processDwnRequest({
    author        : tenantDid,
    target        : tenantDid,
    messageType   : DwnInterface.ProtocolsQuery,
    messageParams : { filter: { protocol } },
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

async function installProtocol(
  harness: PlatformAgentTestHarness,
  tenantDid: string,
  definition: ProtocolDefinition,
): Promise<void> {
  const { reply } = await harness.agent.processDwnRequest({
    author        : tenantDid,
    target        : tenantDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition },
    encryption    : true,
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
  protocol: string;
  protocolPath?: string;
}): Promise<{ grant: any; grantId: string; grantKeyRecords: Array<RecordsWriteMessage & { encodedData: string }> }> {
  const readGrant = await params.walletHarness.agent.permissions.createGrant({
    author      : params.walletDid,
    dateExpires : '2040-06-25T16:09:16.693356Z',
    delegated   : true,
    grantedTo   : params.delegateDid,
    scope       : {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
      protocol  : params.protocol,
      ...(params.protocolPath === undefined ? {} : { protocolPath: params.protocolPath }),
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
  expect(grantKeyRecords[0].descriptor.protocol).toBe(EncryptionProtocol.uri);
  expect(grantKeyRecords[0].descriptor.protocolPath).toBe(EncryptionProtocol.grantKeyPath);
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

describe('e2e: delegate + encrypted protocol', () => {
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

  it('should inject $keyAgreement keys when installing an encrypted protocol', async () => {
    await installProtocol(walletHarness, walletIdentity.did.uri, encryptedNoteProtocol);

    const { reply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
    });

    const installedDefinition = (reply.entries![0] as any).descriptor.definition;
    expect(installedDefinition.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
    expect(installedDefinition.structure.note.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
  });

  it('should produce encrypted protocolPath records for encrypted protocol types', async () => {
    await installProtocol(walletHarness, walletIdentity.did.uri, encryptedNoteProtocol);

    const { reply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : encryptedNoteProtocol.protocol,
        protocolPath : 'note',
        schema       : 'https://schemas.xyz/note',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode('This is a secret delegate note'),
      },
      encryption: true,
    });
    expect(reply.status.code).toBe(202);

    const rawEntry = await queryRawEntry(
      walletHarness,
      walletIdentity.did.uri,
      encryptedNoteProtocol.protocol,
    );
    expect(rawEntry?.encryption?.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
    expect(rawEntry?.encryption?.keyEncryption).toHaveLength(1);
    expect(rawEntry!.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
  });

  it('should hydrate delivered keys from durable grantKey records on cache miss and fail closed after revocation', async () => {
    await installProtocol(walletHarness, walletIdentity.did.uri, encryptedNoteProtocol);

    const noteData = 'Secret note from durable grantKey';
    const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : encryptedNoteProtocol.protocol,
        protocolPath : 'note',
        schema       : 'https://schemas.xyz/note',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode(noteData),
      },
      encryption: true,
    });

    const { delegateDid, delegateX25519PrivateKey } = await createImportedDelegateDid(delegateHarness);
    const { grant, grantId } = await createReadGrantAndGrantKey({
      delegateDid,
      delegateHarness,
      delegateX25519PrivateKey,
      protocol  : encryptedNoteProtocol.protocol,
      walletDid : walletIdentity.did.uri,
      walletHarness,
    });

    await copyProtocolToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, encryptedNoteProtocol.protocol);
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
    await installProtocol(walletHarness, walletIdentity.did.uri, encryptedNoteProtocol);

    const noteData = 'Secret note from wrapped durable grantKey';
    const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : encryptedNoteProtocol.protocol,
        protocolPath : 'note',
        schema       : 'https://schemas.xyz/note',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode(noteData),
      },
      encryption: true,
    });

    const { delegateDid } = await createImportedDelegateDid(delegateHarness);
    const delegateRootPublicKey = (await getEncryptionKeyInfo(delegateHarness.agent, delegateDid)).publicKeyJwk;
    const { grantId, grantKeyRecords } = await createReadGrantAndGrantKey({
      delegateDid,
      delegateHarness,
      delegateRootPublicKey,
      protocol  : encryptedNoteProtocol.protocol,
      walletDid : walletIdentity.did.uri,
      walletHarness,
    });

    expect(grantKeyRecords[0].encryption).toBeUndefined();

    await copyProtocolToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, encryptedNoteProtocol.protocol);
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

  it('should hydrate protocolPath-scoped durable grantKeys without owner KMS fallback', async () => {
    await installProtocol(walletHarness, walletIdentity.did.uri, multiTypeProtocol);

    const noteData = 'Secret path-scoped note from durable grantKey';
    const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : multiTypeProtocol.protocol,
        protocolPath : 'note',
        schema       : 'https://schemas.xyz/note',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode(noteData),
      },
      encryption: true,
    });

    const { delegateDid, delegateX25519PrivateKey } = await createImportedDelegateDid(delegateHarness);
    const { grantId } = await createReadGrantAndGrantKey({
      delegateDid,
      delegateHarness,
      delegateX25519PrivateKey,
      protocol     : multiTypeProtocol.protocol,
      protocolPath : 'note',
      walletDid    : walletIdentity.did.uri,
      walletHarness,
    });

    await copyProtocolToHarness(walletHarness, delegateHarness, walletIdentity.did.uri, multiTypeProtocol.protocol);
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
    await installProtocol(walletHarness, walletIdentity.did.uri, encryptedNoteProtocol);

    const noteData = 'Owner secret note';
    const { reply: writeReply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : encryptedNoteProtocol.protocol,
        protocolPath : 'note',
        schema       : 'https://schemas.xyz/note',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode(noteData),
      },
      encryption: true,
    });
    expect(writeReply.status.code).toBe(202);

    const { reply: readReply } = await walletHarness.agent.processDwnRequest({
      author        : walletIdentity.did.uri,
      target        : walletIdentity.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
    });

    expect(readReply.status.code).toBe(200);
    expect(await readApplicationText(
      walletHarness,
      walletIdentity.did.uri,
      walletIdentity.did.uri,
      readReply.entry!,
    )).toBe(noteData);
    expect((await queryRawEntry(walletHarness, walletIdentity.did.uri, encryptedNoteProtocol.protocol))?.encryption).toBeDefined();
  });

  it('should treat definitions with and without $keyAgreement as logically equal', async () => {
    const { definitionsEqual } = await import('../../api/src/typed-enbox.js');

    const installedDefinition = JSON.parse(JSON.stringify(encryptedNoteProtocol));
    installedDefinition.structure.note.$keyAgreement = {
      publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'fake-key' },
    };

    expect(definitionsEqual(installedDefinition, encryptedNoteProtocol)).toBe(true);

    const differentDefinition = JSON.parse(JSON.stringify(encryptedNoteProtocol));
    differentDefinition.types.note.schema = 'https://different-schema.xyz';
    expect(definitionsEqual(differentDefinition, encryptedNoteProtocol)).toBe(false);
  });
});
