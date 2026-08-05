import type { BearerDid } from '@enbox/dids';
import type {
  DwnEncryption,
  MessageSigner,
  RecordsDeleteMessage,
  RecordsReadMessage,
  RecordsReadReplicationSupportEntry,
  RecordsWriteMessage,
  SourceRoleAudienceKeyEncryption,
} from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { beforeAll, describe, expect, it } from 'bun:test';
import {
  ContentEncryptionAlgorithm,
  DataStream,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  KeyAgreementAlgorithm,
  Message,
  ProtocolsConfigure,
  RecordsDelete,
  RecordsRead,
  RecordsWrite,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';
import { DidJwk, UniversalResolver } from '@enbox/dids';

import {
  FollowedSourceNotReadyError,
  FollowedSourceRoleAbsentError,
  readFollowedRoleState,
  readRoleReplicationSupport,
} from '../src/sync-role-replication-support.js';

const PROTOCOL = 'https://example.com/notebooks';
const ROLE_PATH = 'notebook/viewer';

describe('readRoleReplicationSupport', () => {
  let actor: BearerDid;
  let actorSigner: MessageSigner;
  let owner: BearerDid;
  let ownerSigner: MessageSigner;
  let peer: BearerDid;
  let peerSigner: MessageSigner;
  let resolver: UniversalResolver;

  beforeAll(async () => {
    [actor, owner, peer] = await Promise.all([DidJwk.create(), DidJwk.create(), DidJwk.create()]);
    [actorSigner, ownerSigner, peerSigner] = await Promise.all([
      signerForDid(actor),
      signerForDid(owner),
      signerForDid(peer),
    ]);
    resolver = new UniversalResolver({ didResolvers: [DidJwk] });
  });

  it('returns only an exact signed context closure and resolves its role record ID', async () => {
    const fixture = await createFixture();
    const result = await readFixture(fixture);

    expect(result.roleRecordId).toBe(fixture.role.message.recordId);
    expect(result.protocolDefinition).toEqual(fixture.configure.message.descriptor.definition);
    expect(result.root.message).toEqual(fixture.root.message);
    expect(result.dependencies.map(entry => entry.message)).toEqual([
      fixture.configure.message,
      fixture.role.message,
    ]);
  });

  it('represents an updated role initial write as an ordinary support entry', async () => {
    const fixture = await createFixture();
    const initialRole = fixture.role;
    const updatedData = new TextEncoder().encode('updated viewer');
    fixture.role = await RecordsWrite.createFrom({
      data                : updatedData,
      recordsWriteMessage : initialRole.message,
      signer              : ownerSigner,
    });
    fixture.support[1].isLatestBaseState = false;
    delete fixture.support[1].encodedData;
    fixture.support.push(await supportEntry(fixture.role, true, updatedData));

    const result = await readFixture(fixture);

    expect(result.dependencies.map(entry => entry.message)).toEqual([
      fixture.configure.message,
      initialRole.message,
      fixture.role.message,
    ]);
    expect(result.dependencies.slice(1).map(entry => entry.bufferedData)).toEqual([
      undefined,
      updatedData,
    ]);
  });

  it('accepts one ancestry-only role proof for a record authored by another member', async () => {
    const fixture = await createFixture();
    const { authorRole, contextRoot } = await addPeerAuthoredPage(fixture);
    const authorRoleEntry = await supportEntry(authorRole, false);
    delete authorRoleEntry.encodedData;
    fixture.support.push(authorRoleEntry);

    const result = await readFixture(fixture);

    expect(result.dependencies.map(({ message }) => message)).toEqual([
      fixture.configure.message,
      contextRoot.message,
      fixture.role.message,
      authorRole.message,
    ]);
    expect(result.dependencies.at(-1)?.bufferedData).toBeUndefined();
  });

  it('rejects duplicate record-author role proofs', async () => {
    const fixture = await createFixture();
    const { authorRole } = await addPeerAuthoredPage(fixture);
    const proof = await supportEntry(authorRole, false);
    delete proof.encodedData;
    fixture.support.push(proof, structuredClone(proof));

    await expect(readFixture(fixture)).rejects.toThrow('invalid record-author role assignment');
  });

  it('requires the author proof carried by an updated root initial write', async () => {
    const fixture = await createFixture();
    const { authorRole } = await addPeerAuthoredPage(fixture);
    fixture.rootInitialWrite = fixture.root;
    fixture.rootData = new TextEncoder().encode('updated by requester');
    fixture.root = await RecordsWrite.createFrom({
      data                : fixture.rootData,
      protocolRole        : ROLE_PATH,
      recordsWriteMessage : fixture.root.message,
      signer              : actorSigner,
    });
    const proof = await supportEntry(authorRole, false);
    delete proof.encodedData;
    fixture.support.push(proof);
    const expectedRootCid = await Message.getCid(fixture.root.message);
    const agent = responseAgent(fixture) as any;

    const result = await readFixture(fixture, agent, fixture.root.message);

    expect(result.dependencies.some(({ message }) => message === fixture.rootInitialWrite?.message)).toBe(true);
    expect(result.dependencies.some(({ message }) => message === authorRole.message)).toBe(true);
    expect(result.rootCid).toBe(expectedRootCid);
  });

  it('accepts a verified role-authored delete root without requesting record data', async () => {
    const keyId = 'D'.repeat(43);
    const fixture = await createFixture({
      encryption: {
        algorithm            : ContentEncryptionAlgorithm.A256CTR,
        initializationVector : Encoder.bytesToBase64Url(new Uint8Array(16)),
        keyEncryption        : [roleAudienceEncryption(ROLE_PATH, keyId)],
      },
    });
    const audience = await controlRecord({
      contextId    : fixture.root.message.contextId,
      keyId,
      protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      rolePath     : ROLE_PATH,
    });
    fixture.support.push(await supportEntry(audience, true));
    const deleterRole = await RecordsWrite.create({
      data            : new TextEncoder().encode('peer viewer'),
      dataFormat      : 'text/plain',
      parentContextId : fixture.root.message.contextId,
      protocol        : PROTOCOL,
      protocolPath    : ROLE_PATH,
      recipient       : peer.uri,
      signer          : ownerSigner,
    });
    const proof = await supportEntry(deleterRole, false);
    delete proof.encodedData;
    fixture.support.push(proof);
    const deletedInitialWrite = structuredClone(fixture.root.message);
    delete deletedInitialWrite.encodedData;
    const recordsDelete = await RecordsDelete.create({
      protocolRole : ROLE_PATH,
      recordId     : fixture.root.message.recordId,
      signer       : peerSigner,
    });
    const agent = responseAgent(fixture) as any;
    agent.rpc.sendDwnRequest.callsFake(() => Promise.resolve({
      entry: {
        initialWrite  : deletedInitialWrite,
        recordsDelete : recordsDelete.message,
      },
      roleRecordId : fixture.role.message.recordId,
      status       : { code: 404 },
      support      : fixture.support,
    }));

    const result = await readFixture(fixture, agent, recordsDelete.message);

    expect(agent.rpc.sendDwnRequest.callCount).toBe(1);
    expect(result.root.message).toEqual(recordsDelete.message);
    expect(result.root.dataStream).toBeUndefined();
    expect(result.dependencies.some(({ message }) => message === deletedInitialWrite)).toBe(true);
    expect(result.dependencies.some(({ message }) => message === deleterRole.message)).toBe(true);

    agent.rpc.sendDwnRequest.resolves({ status: { code: 404 } });
    await expect(readFixture(fixture, agent, recordsDelete.message))
      .rejects.toThrow('did not contain a readable root record');
  });

  it('splits support metadata over WebSocket from record data over HTTP', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    agent.rpc.getServerInfo = sinon.stub().resolves({ webSocketSupport: true });
    agent.dwn.processRequest.callsFake(async ({ messageParams }: any) => ({
      message: (await RecordsRead.create({ ...messageParams, signer: actorSigner })).message,
    }));
    agent.rpc.sendDwnRequest.callsFake(({ dwnUrl }: { dwnUrl: string }) => Promise.resolve({
      entry: {
        ...(dwnUrl.startsWith('http') ? { data: DataStream.fromBytes(fixture.rootData) } : {}),
        recordsWrite: fixture.root.message,
      },
      roleRecordId : fixture.role.message.recordId,
      status       : { code: 200 },
      support      : fixture.support,
    }));

    await readFixture(fixture, agent);

    expect(agent.rpc.sendDwnRequest.firstCall.args[0].dwnUrl).toBe('wss://owner.example.com/');
    expect(agent.rpc.sendDwnRequest.firstCall.args[0].message.descriptor.includeReplicationSupport).toBe(true);
    expect(agent.rpc.sendDwnRequest.secondCall.args[0].dwnUrl).toBe('https://owner.example.com');
    expect(agent.rpc.sendDwnRequest.secondCall.args[0].message.descriptor.includeReplicationSupport).toBe(false);
  });

  it('splits support metadata and record data on HTTP-only servers', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    agent.rpc.getServerInfo = sinon.stub().resolves({ webSocketSupport: false });
    agent.dwn.processRequest.callsFake(async ({ messageParams }: any) => ({
      message: (await RecordsRead.create({ ...messageParams, signer: actorSigner })).message,
    }));
    agent.rpc.sendDwnRequest.callsFake(({ message }: { message: { descriptor: { includeReplicationSupport?: boolean } } }) =>
      Promise.resolve({
        entry: {
          ...(message.descriptor.includeReplicationSupport === true
            ? {}
            : { data: DataStream.fromBytes(fixture.rootData) }),
          recordsWrite: fixture.root.message,
        },
        roleRecordId : fixture.role.message.recordId,
        status       : { code: 200 },
        support      : fixture.support,
      }));

    await readFixture(fixture, agent);

    expect(agent.rpc.sendDwnRequest.callCount).toBe(2);
    expect(agent.rpc.sendDwnRequest.getCalls().map(call => call.args[0].dwnUrl)).toEqual([
      'https://owner.example.com',
      'https://owner.example.com',
    ]);
    expect(agent.rpc.sendDwnRequest.firstCall.args[0].message.descriptor.includeReplicationSupport).toBe(true);
    expect(agent.rpc.sendDwnRequest.secondCall.args[0].message.descriptor.includeReplicationSupport).toBe(false);
  });

  it('cancels the HTTP record body when the WebSocket support request fails', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    const cancel = sinon.spy();
    const data = new ReadableStream<Uint8Array>({ cancel });
    agent.rpc.getServerInfo = sinon.stub().resolves({ webSocketSupport: true });
    agent.rpc.sendDwnRequest.callsFake(({ dwnUrl }: { dwnUrl: string }) => {
      if (dwnUrl.startsWith('ws')) {
        return Promise.reject(new Error('WebSocket request failed'));
      }
      return Promise.resolve({ entry: { data }, status: { code: 200 } });
    });

    await expect(readFixture(fixture, agent)).rejects.toThrow('WebSocket request failed');
    expect(cancel.calledOnce).toBe(true);
  });

  it('cancels the HTTP record body when the support reply cannot accept it', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    const cancel = sinon.spy();
    const data = new ReadableStream<Uint8Array>({ cancel });
    agent.rpc.getServerInfo = sinon.stub().resolves({ webSocketSupport: true });
    agent.rpc.sendDwnRequest.callsFake(({ dwnUrl }: { dwnUrl: string }) => Promise.resolve(
      dwnUrl.startsWith('ws')
        ? { status: { code: 200 } }
        : { entry: { data }, status: { code: 200 } }
    ));

    await expect(readFixture(fixture, agent)).rejects.toThrow(
      'did not contain a readable root record'
    );
    expect(cancel.calledOnce).toBe(true);
  });

  it('cancels the HTTP record body when support validation fails', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    const cancel = sinon.spy();
    const data = new ReadableStream<Uint8Array>({ cancel });
    agent.rpc.getServerInfo = sinon.stub().resolves({ webSocketSupport: true });
    agent.dwn.processRequest.callsFake(async ({ messageParams }: any) => ({
      message: (await RecordsRead.create({ ...messageParams, signer: actorSigner })).message,
    }));
    agent.rpc.sendDwnRequest.callsFake(({ dwnUrl }: { dwnUrl: string }) => Promise.resolve(
      dwnUrl.startsWith('ws')
        ? {
          entry        : { recordsWrite: fixture.root.message },
          roleRecordId : 'unrelated-role',
          status       : { code: 200 },
          support      : fixture.support,
        }
        : { entry: { data }, status: { code: 200 } }
    ));

    await expect(readFixture(fixture, agent)).rejects.toThrow('not bound to exactly one signed active assignment');
    expect(cancel.calledOnce).toBe(true);
  });

  it('types only a verified 401 matching-role response as definite absence', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    agent.rpc.sendDwnRequest.resolves({
      status: {
        code   : 401,
        detail : 'ProtocolAuthorizationMatchingRoleRecordNotFound: no matching role record',
      },
    });

    await expect(readRoleReplicationSupport({
      actorDid       : actor.uri,
      agent,
      contextId      : fixture.root.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolPath   : 'notebook',
      protocolRole   : ROLE_PATH,
      sourceDid      : owner.uri,
    })).rejects.toBeInstanceOf(FollowedSourceRoleAbsentError);

    agent.rpc.sendDwnRequest.resolves({
      status: {
        code   : 500,
        detail : 'ProtocolAuthorizationMatchingRoleRecordNotFound: misleading server failure',
      },
    });
    await expect(readRoleReplicationSupport({
      actorDid       : actor.uri,
      agent,
      contextId      : fixture.root.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolPath   : 'notebook',
      protocolRole   : ROLE_PATH,
      sourceDid      : owner.uri,
    })).rejects.not.toBeInstanceOf(FollowedSourceRoleAbsentError);
  });

  it('reads the exact active state of a previously accepted role', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    agent.dwn.processRequest.callsFake(async ({ messageParams }: any) => ({
      message: (await RecordsRead.create({ ...messageParams, signer: actorSigner })).message,
    }));
    agent.rpc.sendDwnRequest.resolves({
      entry: {
        data         : DataStream.fromBytes(fixture.roleData),
        recordsWrite : fixture.role.message,
      },
      status: { code: 200, detail: 'OK' },
    });

    await expect(readFollowedRoleState({
      actorDid       : actor.uri,
      agent,
      contextId      : fixture.root.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolRole   : ROLE_PATH,
      roleRecordId   : fixture.role.message.recordId,
      sourceDid      : owner.uri,
    })).resolves.toEqual({ kind: 'active' });
  });

  it('returns a verified tombstone for a deleted accepted role', async () => {
    const fixture = await createFixture();
    const deleted = await RecordsDelete.create({
      recordId : fixture.role.message.recordId,
      signer   : ownerSigner,
    });
    const agent = responseAgent(fixture) as any;
    agent.dwn.processRequest.callsFake(async ({ messageParams }: any) => ({
      message: (await RecordsRead.create({ ...messageParams, signer: actorSigner })).message,
    }));
    agent.rpc.sendDwnRequest.resolves({
      entry: {
        initialWrite  : fixture.role.message,
        recordsDelete : deleted.message,
      },
      status: { code: 404, detail: 'Not Found' },
    });

    await expect(readFollowedRoleState({
      actorDid       : actor.uri,
      agent,
      contextId      : fixture.root.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolRole   : ROLE_PATH,
      roleRecordId   : fixture.role.message.recordId,
      sourceDid      : owner.uri,
    })).resolves.toEqual({ kind: 'absent', tombstone: deleted.message });
  });

  it('does not treat an endpoint without a role tombstone as durable absence', async () => {
    const fixture = await createFixture();
    const agent = responseAgent(fixture) as any;
    agent.dwn.processRequest.callsFake(async ({ messageParams }: any) => ({
      message: (await RecordsRead.create({ ...messageParams, signer: actorSigner })).message,
    }));
    agent.rpc.sendDwnRequest.resolves({ status: { code: 404, detail: 'Not Found' } });

    await expect(readFollowedRoleState({
      actorDid       : actor.uri,
      agent,
      contextId      : fixture.root.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolRole   : ROLE_PATH,
      roleRecordId   : fixture.role.message.recordId,
      sourceDid      : owner.uri,
    })).rejects.toBeInstanceOf(FollowedSourceNotReadyError);
  });

  it('accepts historical protocol configurations alongside exactly one current version', async () => {
    const fixture = await createFixture();
    const current = await ProtocolsConfigure.create({
      definition : { protocol: PROTOCOL, published: false, structure: {}, types: {} },
      signer     : ownerSigner,
    });
    fixture.support[0].isLatestBaseState = false;
    fixture.support.splice(1, 0, {
      isLatestBaseState : true,
      message           : current.message,
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
    });

    const result = await readRoleReplicationSupport({
      actorDid       : actor.uri,
      agent          : responseAgent(fixture) as any,
      contextId      : page.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolPath   : fixture.root.message.descriptor.protocolPath!,
      protocolRole   : ROLE_PATH,
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

  it('accepts every audience referenced by a multi-role root and only the invoked-role delivery', async () => {
    const viewerKeyId = 'A'.repeat(43);
    const editorKeyId = 'B'.repeat(43);
    const fixture = await createFixture({
      encryption: {
        algorithm            : ContentEncryptionAlgorithm.A256CTR,
        initializationVector : Encoder.bytesToBase64Url(new Uint8Array(16)),
        keyEncryption        : [
          roleAudienceEncryption(ROLE_PATH, viewerKeyId),
          roleAudienceEncryption('notebook/editor', editorKeyId),
        ],
      },
    });
    const viewerAudience = await controlRecord({
      contextId    : fixture.root.message.contextId,
      keyId        : viewerKeyId,
      protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      rolePath     : ROLE_PATH,
    });
    const editorAudience = await controlRecord({
      contextId    : fixture.root.message.contextId,
      keyId        : editorKeyId,
      protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      rolePath     : 'notebook/editor',
    });
    const viewerDelivery = await controlRecord({
      contextId    : fixture.root.message.contextId,
      keyId        : viewerKeyId,
      protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
      recipient    : actor.uri,
      rolePath     : ROLE_PATH,
    });
    fixture.support.push(
      await supportEntry(viewerAudience, true),
      await supportEntry(editorAudience, true),
      await supportEntry(viewerDelivery, true),
    );

    const result = await readFixture(fixture);

    expect(result.dependencies.map(entry => entry.message)).toEqual([
      fixture.configure.message,
      fixture.role.message,
      viewerAudience.message,
      editorAudience.message,
      viewerDelivery.message,
    ]);
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
    };

    await expect(readFixture(fixture)).rejects.toBeInstanceOf(FollowedSourceNotReadyError);
  });

  async function addPeerAuthoredPage(
    fixture: Awaited<ReturnType<typeof createFixture>>,
  ): Promise<{ authorRole: RecordsWrite; contextRoot: RecordsWrite }> {
    const contextRoot = fixture.root;
    const authorRole = await RecordsWrite.create({
      data            : new TextEncoder().encode('peer viewer'),
      dataFormat      : 'text/plain',
      parentContextId : contextRoot.message.contextId,
      protocol        : PROTOCOL,
      protocolPath    : ROLE_PATH,
      recipient       : peer.uri,
      signer          : ownerSigner,
    });
    fixture.rootData = new TextEncoder().encode('peer page');
    fixture.root = await RecordsWrite.create({
      data            : fixture.rootData,
      dataFormat      : 'text/plain',
      parentContextId : contextRoot.message.contextId,
      protocol        : PROTOCOL,
      protocolPath    : 'notebook/page',
      protocolRole    : ROLE_PATH,
      signer          : peerSigner,
    });
    fixture.read = await RecordsRead.create({
      filter: {
        contextId    : fixture.root.message.contextId,
        protocol     : PROTOCOL,
        protocolPath : 'notebook/page',
        recordId     : fixture.root.message.recordId,
      },
      includeReplicationSupport : true,
      protocolRole              : ROLE_PATH,
      signer                    : actorSigner,
    });
    fixture.support.splice(1, 0, { isLatestBaseState: false, message: contextRoot.message });
    return { authorRole, contextRoot };
  }

  async function createFixture(options: {
    encryption?: DwnEncryption;
  } = {}): Promise<{
    configure: ProtocolsConfigure;
    read: RecordsRead;
    role: RecordsWrite;
    roleData: Uint8Array;
    root: RecordsWrite;
    rootInitialWrite: RecordsWrite | undefined;
    rootData: Uint8Array;
    support: RecordsReadReplicationSupportEntry[];
  }> {
    const rootData = new TextEncoder().encode('notebook');
    const root = await RecordsWrite.create({
      data         : rootData,
      dataFormat   : 'text/plain',
      encryption   : options.encryption,
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
      rootInitialWrite : undefined as RecordsWrite | undefined,
      rootData,
      support          : [
        {
          isLatestBaseState : true,
          message           : configure.message,
        },
        await supportEntry(role, true, roleData),
      ],
    };
  }

  async function readFixture(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    agent: any = responseAgent(fixture),
    expectedRoot?: RecordsDeleteMessage | RecordsWriteMessage,
  ): ReturnType<typeof readRoleReplicationSupport> {
    return readRoleReplicationSupport({
      actorDid       : actor.uri,
      agent,
      contextId      : fixture.root.message.contextId,
      dwnUrl         : 'https://owner.example.com',
      expectedRoot,
      permissionsApi : { getPermissionForRequest: sinon.stub() } as any,
      protocol       : PROTOCOL,
      protocolPath   : fixture.root.message.descriptor.protocolPath!,
      protocolRole   : ROLE_PATH,
      sourceDid      : owner.uri,
    });
  }

  function responseAgent(fixture: Awaited<ReturnType<typeof createFixture>>): object {
    return {
      did : resolver,
      dwn : {
        processRequest: sinon.stub().callsFake(async ({ messageParams }: any) => ({
          message: (await RecordsRead.create({ ...messageParams, signer: actorSigner })).message,
        })),
      },
      rpc: {
        sendDwnRequest: sinon.stub().callsFake(({ message }: { message: RecordsReadMessage }) => Promise.resolve({
          entry: {
            ...(message.descriptor.includeReplicationSupport === true
              ? {}
              : { data: DataStream.fromBytes(fixture.rootData) }),
            ...(fixture.rootInitialWrite === undefined
              ? {}
              : { initialWrite: fixture.rootInitialWrite.message }),
            recordsWrite: fixture.root.message,
          },
          roleRecordId : fixture.role.message.recordId,
          status       : { code: 200 },
          support      : fixture.support,
        })),
      },
    };
  }

  async function controlRecord(input: {
    contextId: string;
    keyId: string;
    protocolPath: string;
    recipient?: string;
    rolePath: string;
  }): Promise<RecordsWrite> {
    return RecordsWrite.create({
      data         : new TextEncoder().encode('audience'),
      dataFormat   : 'application/json',
      protocol     : PROTOCOL,
      protocolPath : input.protocolPath,
      recipient    : input.recipient,
      signer       : ownerSigner,
      tags         : {
        contextId : input.contextId,
        keyId     : input.keyId,
        protocol  : PROTOCOL,
        rolePath  : input.rolePath,
      },
    });
  }
});

function roleAudienceEncryption(
  rolePath: string,
  keyId: string,
): SourceRoleAudienceKeyEncryption {
  return {
    algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
    derivationScheme   : ROLE_AUDIENCE_DERIVATION_SCHEME,
    encryptedKey       : 'AA',
    ephemeralPublicKey : {
      crv : 'X25519',
      kty : 'OKP',
      x   : 'A'.repeat(43),
    },
    keyId,
    protocol: PROTOCOL,
    rolePath,
  };
}

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
  };
}
