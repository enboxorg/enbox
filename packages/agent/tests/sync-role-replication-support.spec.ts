import type { BearerDid } from '@enbox/dids';
import type { MessageSigner, RecordsReadReplicationSupportEntry } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { beforeAll, describe, expect, it } from 'bun:test';
import {
  DataStream,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  Message,
  ProtocolsConfigure,
  RecordsRead,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';
import { DidJwk, UniversalResolver } from '@enbox/dids';

import {
  FollowedSourceNotReadyError,
  readRoleReplicationSupport,
} from '../src/sync-role-replication-support.js';

const PROTOCOL = 'https://example.com/notebooks';
const ROLE_PATH = 'notebook/viewer';

describe('readRoleReplicationSupport', () => {
  let actor: BearerDid;
  let actorSigner: MessageSigner;
  let owner: BearerDid;
  let ownerSigner: MessageSigner;
  let resolver: UniversalResolver;

  beforeAll(async () => {
    [actor, owner] = await Promise.all([DidJwk.create(), DidJwk.create()]);
    [actorSigner, ownerSigner] = await Promise.all([signerForDid(actor), signerForDid(owner)]);
    resolver = new UniversalResolver({ didResolvers: [DidJwk] });
  });

  it('returns only an exact signed context closure and resolves its role record ID', async () => {
    const fixture = await createFixture();
    const result = await readFixture(fixture);

    expect(result.roleRecordId).toBe(fixture.role.message.recordId);
    expect(result.root.message).toEqual(fixture.root.message);
    expect(result.dependencies.map(entry => entry.message)).toEqual([
      fixture.configure.message,
      fixture.role.message,
    ]);
  });

  it('accepts historical protocol configurations alongside exactly one current version', async () => {
    const fixture = await createFixture();
    const current = await ProtocolsConfigure.create({
      definition : { protocol: PROTOCOL, published: true, structure: {}, types: {} },
      signer     : ownerSigner,
    });
    fixture.support[0].isLatestBaseState = false;
    fixture.support.splice(1, 0, {
      isLatestBaseState : true,
      message           : current.message,
      messageCid        : await Message.getCid(current.message),
      protocol          : PROTOCOL,
    });

    const result = await readFixture(fixture);

    expect(result.dependencies.map(entry => entry.message)).toEqual([
      fixture.configure.message,
      current.message,
      fixture.role.message,
    ]);
  });

  it('rejects a support response that identifies multiple current protocol configurations', async () => {
    const fixture = await createFixture();
    const extra = await ProtocolsConfigure.create({
      definition : { protocol: PROTOCOL, published: true, structure: {}, types: {} },
      signer     : ownerSigner,
    });
    fixture.support.splice(1, 0, {
      isLatestBaseState : true,
      message           : extra.message,
      messageCid        : await Message.getCid(extra.message),
      protocol          : PROTOCOL,
    });

    await expect(readFixture(fixture)).rejects.toThrow('exactly one current protocol configuration');
  });

  it('accepts exact compound-context ancestry while binding the role at its parent context', async () => {
    const fixture = await createFixture();
    const contextRoot = fixture.root;
    const pageData = new TextEncoder().encode('page');
    const page = await RecordsWrite.create({
      data            : pageData,
      dataFormat      : 'text/plain',
      parentContextId : contextRoot.message.contextId,
      protocol        : PROTOCOL,
      protocolPath    : 'notebook/page',
      signer          : ownerSigner,
    });
    fixture.root = page;
    fixture.rootData = pageData;
    fixture.read = await RecordsRead.create({
      filter: {
        contextId    : page.message.contextId,
        protocol     : PROTOCOL,
        protocolPath : 'notebook/page',
        recordId     : page.message.recordId,
      },
      includeReplicationSupport : true,
      protocolRole              : ROLE_PATH,
      signer                    : actorSigner,
    });
    fixture.support.splice(1, 0, {
      isLatestBaseState : false,
      message           : contextRoot.message,
      messageCid        : await Message.getCid(contextRoot.message),
      protocol          : PROTOCOL,
    });

    const result = await readRoleReplicationSupport({
      actorDid       : actor.uri,
      agent          : responseAgent(fixture) as any,
      contextId      : page.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolPath   : 'notebook/page',
      protocolRole   : ROLE_PATH,
      recordId       : page.message.recordId,
      sourceDid      : owner.uri,
    });

    expect(result.dependencies.map(entry => entry.message)).toEqual([
      fixture.configure.message,
      contextRoot.message,
      fixture.role.message,
    ]);
  });

  it('rejects an unrelated support record before local admission', async () => {
    const fixture = await createFixture();
    const unrelated = await RecordsWrite.create({
      data         : new TextEncoder().encode('unrelated'),
      dataFormat   : 'text/plain',
      protocol     : PROTOCOL,
      protocolPath : 'other',
      signer       : ownerSigner,
    });
    fixture.support.push(await supportEntry(unrelated, true));

    await expect(readFixture(fixture)).rejects.toThrow('unrelated entry');
  });

  it('rejects oversized inline support data before decoding it', async () => {
    const fixture = await createFixture();
    fixture.support[1].encodedData = 'A'.repeat(9);

    await expect(readFixture(fixture)).rejects.toThrow('inline data exceeds its declared bound');
  });

  it('reports a valid role as not ready when its current audience key has no delivery', async () => {
    const fixture = await createFixture();
    const audience = await RecordsWrite.create({
      data         : new TextEncoder().encode('audience'),
      dataFormat   : 'application/json',
      protocol     : PROTOCOL,
      protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      signer       : ownerSigner,
      tags         : {
        contextId : fixture.root.message.contextId,
        keyId     : 'audience-key',
        protocol  : PROTOCOL,
        rolePath  : ROLE_PATH,
      },
    });
    fixture.support.push(await supportEntry(audience, true));

    await expect(readFixture(fixture)).rejects.toBeInstanceOf(FollowedSourceNotReadyError);
  });

  it('requires a current audience delivery for a deliverable role even when the root is unencrypted', async () => {
    const fixture = await createFixture();
    const publicKeyJwk = {
      crv : 'X25519',
      kty : 'OKP',
      x   : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    } as const;
    const configure = await ProtocolsConfigure.create({
      definition: {
        $keyAgreement : { publicKeyJwk },
        protocol      : PROTOCOL,
        published     : true,
        structure     : {
          notebook: {
            $keyAgreement : { publicKeyJwk },
            viewer        : {
              $keyAgreement : { publicKeyJwk },
              $role         : true,
            },
          },
        },
        types: {
          notebook : { dataFormats: ['text/plain'] },
          viewer   : { dataFormats: ['text/plain'], encryptionRequired: true },
        },
      },
      signer: ownerSigner,
    });
    fixture.configure = configure;
    fixture.support[0] = {
      isLatestBaseState : true,
      message           : configure.message,
      messageCid        : await Message.getCid(configure.message),
      protocol          : PROTOCOL,
    };

    await expect(readFixture(fixture)).rejects.toBeInstanceOf(FollowedSourceNotReadyError);
  });

  async function createFixture(): Promise<{
    configure: ProtocolsConfigure;
    read: RecordsRead;
    role: RecordsWrite;
    roleData: Uint8Array;
    root: RecordsWrite;
    rootData: Uint8Array;
    support: RecordsReadReplicationSupportEntry[];
  }> {
    const rootData = new TextEncoder().encode('notebook');
    const root = await RecordsWrite.create({
      data         : rootData,
      dataFormat   : 'text/plain',
      protocol     : PROTOCOL,
      protocolPath : 'notebook',
      signer       : ownerSigner,
    });
    const roleData = new TextEncoder().encode('viewer');
    const role = await RecordsWrite.create({
      data            : roleData,
      dataFormat      : 'text/plain',
      parentContextId : root.message.contextId,
      protocol        : PROTOCOL,
      protocolPath    : ROLE_PATH,
      recipient       : actor.uri,
      signer          : ownerSigner,
    });
    const configure = await ProtocolsConfigure.create({
      definition : { protocol: PROTOCOL, published: true, structure: {}, types: {} },
      signer     : ownerSigner,
    });
    const read = await RecordsRead.create({
      filter: {
        contextId    : root.message.contextId,
        protocol     : PROTOCOL,
        protocolPath : 'notebook',
        recordId     : root.message.recordId,
      },
      includeReplicationSupport : true,
      protocolRole              : ROLE_PATH,
      signer                    : actorSigner,
    });
    return {
      configure,
      read,
      role,
      roleData,
      root,
      rootData,
      support: [
        {
          isLatestBaseState : true,
          message           : configure.message,
          messageCid        : await Message.getCid(configure.message),
          protocol          : PROTOCOL,
        },
        await supportEntry(role, true, roleData),
      ],
    };
  }

  async function readFixture(
    fixture: Awaited<ReturnType<typeof createFixture>>,
  ): ReturnType<typeof readRoleReplicationSupport> {
    return readRoleReplicationSupport({
      actorDid       : actor.uri,
      agent          : responseAgent(fixture) as any,
      contextId      : fixture.root.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolPath   : 'notebook',
      protocolRole   : ROLE_PATH,
      recordId       : fixture.root.message.recordId,
      sourceDid      : owner.uri,
    });
  }

  function responseAgent(fixture: Awaited<ReturnType<typeof createFixture>>): object {
    return {
      did : resolver,
      dwn : { processRequest: sinon.stub().resolves({ message: fixture.read.message }) },
      rpc : {
        sendDwnRequest: sinon.stub().resolves({
          entry: {
            data         : DataStream.fromBytes(fixture.rootData),
            recordsWrite : fixture.root.message,
          },
          roleRecordId : fixture.role.message.recordId,
          status       : { code: 200 },
          support      : fixture.support,
        }),
      },
    };
  }
});

async function signerForDid(did: BearerDid): Promise<MessageSigner> {
  const signer = await did.getSigner();
  return {
    algorithm : signer.algorithm,
    keyId     : signer.keyId,
    sign      : async (content: Uint8Array): Promise<Uint8Array> => signer.sign({ data: content }),
  };
}

async function supportEntry(
  record: RecordsWrite,
  isLatestBaseState: boolean,
  data = new TextEncoder().encode('audience'),
): Promise<RecordsReadReplicationSupportEntry> {
  return {
    encodedData : Encoder.bytesToBase64Url(data),
    isLatestBaseState,
    message     : record.message,
    messageCid  : await Message.getCid(record.message),
  };
}
