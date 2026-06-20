import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnErrorCode, Encoder, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { admitClosure } from '../src/sync-admit-closure.js';
import { DwnInterface } from '../src/types/dwn.js';
import { KeyDeliveryProtocolDefinition } from '../src/store-data-protocols.js';

describe('admitClosure', () => {
  afterEach(() => {
    sinon.restore();
  });

  function createMockAgent(): any {
    return {
      agentDid          : 'did:example:agent',
      processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Read' } } }),
      dwn               : {
        isRemoteMode           : true,
        processRequest         : sinon.stub().resolves({ message: { descriptor: { interface: 'Records', method: 'Query' } } }),
        applyReplicatedMessage : sinon.stub(),
      },
      rpc: {
        sendDwnRequest: sinon.stub(),
      },
    };
  }

  function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new Blob([bytes]).stream();
  }

  async function readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(value);
        totalLength += value.length;
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  it('fetches a missing initial write and retries the root in dependency order', async () => {
    const protocol = 'https://example.com/protocol';
    const initial = await TestDataGenerator.generateRecordsWrite({ protocol });
    const update = await TestDataGenerator.generateFromRecordsWrite({
      author        : initial.author,
      existingWrite : initial.recordsWrite,
    });
    const rootCid = await Message.getCid(update.message);
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status  : { code: 200 },
      entries : [{ ...initial.message }],
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'InitialWrite', recordId: initial.message.recordId, protocol }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: update.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [await Message.getCid(initial.message), rootCid] });
    expect(agent.dwn.applyReplicatedMessage.callCount).toBe(3);
    expect(agent.dwn.applyReplicatedMessage.secondCall.args[1]).toEqual(initial.message);
    expect(agent.dwn.applyReplicatedMessage.thirdCall.args[1]).toEqual(update.message);
  });

  it('splits RecordsQuery initialWrite hints into separately admissible entries', async () => {
    const protocol = 'https://example.com/protocol';
    const parent = await TestDataGenerator.generateRecordsWrite({ protocol });
    const parentUpdate = await TestDataGenerator.generateFromRecordsWrite({
      author        : parent.author,
      existingWrite : parent.recordsWrite,
    });
    const child = await TestDataGenerator.generateRecordsWrite({
      author          : parent.author,
      protocol,
      protocolPath    : 'testRecord',
      parentContextId : parent.message.contextId,
    });
    const rootCid = await Message.getCid(child.message);
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status  : { code: 200 },
      entries : [{
        ...parentUpdate.message,
        encodedData  : Encoder.bytesToBase64Url(parentUpdate.dataBytes),
        initialWrite : parent.message,
      }],
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'Parent', recordId: parent.message.recordId, protocol }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' })
      .onCall(3).resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: child.message }],
    });

    expect(outcome.kind).toBe('admitted');
    expect(agent.dwn.applyReplicatedMessage.callCount).toBe(4);
    expect(agent.dwn.applyReplicatedMessage.secondCall.args[1]).toEqual(parent.message);

    const appliedParentUpdate = agent.dwn.applyReplicatedMessage.thirdCall.args[1];
    expect(appliedParentUpdate.recordId).toBe(parent.message.recordId);
    expect('initialWrite' in appliedParentUpdate).toBe(false);
    expect('encodedData' in appliedParentUpdate).toBe(false);
    expect(agent.dwn.applyReplicatedMessage.getCall(3).args[1]).toEqual(child.message);
  });

  it('defers when the root message cannot be fetched', async () => {
    const agent = createMockAgent();
    agent.rpc.sendDwnRequest.resolves({ status: { code: 404 } });

    const outcome = await admitClosure('missing-cid', {
      did    : 'did:example:alice',
      dwnUrl : 'https://dwn.example.com',
      agent,
    });

    expect(outcome).toEqual({ kind: 'deferred', rootCid: 'missing-cid', detail: 'root message not available' });
    expect(agent.dwn.applyReplicatedMessage.called).toBe(false);
  });

  it('fails terminal dependencies without retrying', async () => {
    const root = await TestDataGenerator.generateRecordsWrite();
    const rootCid = await Message.getCid(root.message);
    const agent = createMockAgent();

    agent.dwn.applyReplicatedMessage.resolves({
      kind    : 'Incomplete',
      missing : [{
        type     : 'Protocol',
        protocol : 'https://example.com/protocol',
        terminal : true,
      }],
    });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: root.message }],
    });

    expect(outcome).toEqual({
      kind   : 'failed',
      rootCid,
      reason : 'terminal',
      detail : JSON.stringify({ type: 'Protocol', protocol: 'https://example.com/protocol', terminal: true }),
    });
    expect(agent.rpc.sendDwnRequest.called).toBe(false);
  });

  it('returns invalid outcomes without recording dependency retries', async () => {
    const root = await TestDataGenerator.generateRecordsWrite();
    const rootCid = await Message.getCid(root.message);
    const agent = createMockAgent();

    agent.dwn.applyReplicatedMessage.resolves({
      kind   : 'Invalid',
      reason : `${DwnErrorCode.RecordsWriteGetInitialWriteNotFound}: malformed as invalid`,
    });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: root.message }],
    });

    expect(outcome).toEqual({
      kind   : 'failed',
      rootCid,
      reason : 'invalid',
      detail : `${DwnErrorCode.RecordsWriteGetInitialWriteNotFound}: malformed as invalid`,
    });
    expect(agent.rpc.sendDwnRequest.called).toBe(false);
  });

  it('fetches dependencies by message CID', async () => {
    const root = await TestDataGenerator.generateRecordsWrite();
    const dependency = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const rootCid = await Message.getCid(root.message);
    const dependencyCid = await Message.getCid(dependency.message);
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status : { code: 200 },
      entry  : {
        message : dependency.message,
        data    : streamFromBytes(dependency.dataBytes!),
      },
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'Grant', permissionGrantId: 'grant-1', messageCid: dependencyCid }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did                : 'did:example:alice',
      dwnUrl             : 'https://dwn.example.com',
      agent,
      permissionGrantIds : ['messages-read-grant'],
      prefetched         : [{ message: root.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [dependencyCid, rootCid] });
    expect(agent.processDwnRequest.firstCall.args[0].messageParams).toEqual({
      messageCid         : dependencyCid,
      permissionGrantIds : ['messages-read-grant'],
    });
    expect(agent.dwn.applyReplicatedMessage.secondCall.args[2].dataStream).toBeDefined();
  });

  it('fetches role records with a delegated query grant', async () => {
    const protocol = 'https://example.com/protocol';
    const root = await TestDataGenerator.generateRecordsWrite({ protocol });
    const role = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath : 'thread/member',
      recipient    : 'did:example:bob',
    });
    const rootCid = await Message.getCid(root.message);
    const roleCid = await Message.getCid(role.message);
    const agent = createMockAgent();
    const permissionsApi = {
      getPermissionForRequest: sinon.stub().resolves({ grant: { id: 'records-query-grant' } }),
    };

    agent.rpc.sendDwnRequest.resolves({
      status  : { code: 200 },
      entries : [role.message],
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{
          type          : 'Role',
          contextPrefix : 'thread-context',
          protocol,
          protocolPath  : 'thread/member',
          recipient     : 'did:example:bob',
        }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did         : 'did:example:alice',
      dwnUrl      : 'https://dwn.example.com',
      delegateDid : 'did:example:delegate',
      agent,
      permissionsApi,
      prefetched  : [{ message: root.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [roleCid, rootCid] });
    expect(permissionsApi.getPermissionForRequest.firstCall.args[0]).toEqual({
      cached       : true,
      connectedDid : 'did:example:alice',
      delegateDid  : 'did:example:delegate',
      messageType  : DwnInterface.RecordsQuery,
      protocol,
    });
    expect(agent.dwn.processRequest.firstCall.args[0]).toMatchObject({
      author        : 'did:example:delegate',
      granteeDid    : 'did:example:delegate',
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          contextId    : 'thread-context',
          protocol,
          protocolPath : 'thread/member',
          recipient    : 'did:example:bob',
        },
        permissionGrantId: 'records-query-grant',
      },
    });
  });

  it('fetches role records without a grant when no matching delegate grant exists', async () => {
    const protocol = 'https://example.com/protocol';
    const root = await TestDataGenerator.generateRecordsWrite({ protocol });
    const role = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath : 'thread/member',
      recipient    : 'did:example:bob',
    });
    const rootCid = await Message.getCid(root.message);
    const roleCid = await Message.getCid(role.message);
    const agent = createMockAgent();
    const permissionsApi = {
      getPermissionForRequest: sinon.stub().rejects(
        new Error(`CachedPermissions: No permissions found for RecordsQuery: ${protocol}`)
      ),
    };

    agent.rpc.sendDwnRequest.resolves({
      status  : { code: 200 },
      entries : [role.message],
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{
          type          : 'Role',
          contextPrefix : 'thread-context',
          protocol,
          protocolPath  : 'thread/member',
          recipient     : 'did:example:bob',
        }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did         : 'did:example:alice',
      dwnUrl      : 'https://dwn.example.com',
      delegateDid : 'did:example:delegate',
      agent,
      permissionsApi,
      prefetched  : [{ message: root.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [roleCid, rootCid] });
    const queryCall = agent.dwn.processRequest.firstCall.args[0];
    expect(queryCall.author).toBe('did:example:delegate');
    expect(queryCall.granteeDid).toBeUndefined();
    expect(queryCall.messageParams.permissionGrantId).toBeUndefined();
  });

  it('surfaces an unexpected grant-lookup error instead of treating it as no grant', async () => {
    const protocol = 'https://example.com/protocol';
    const root = await TestDataGenerator.generateRecordsWrite({ protocol });
    const rootCid = await Message.getCid(root.message);
    const agent = createMockAgent();
    const permissionsApi = {
      getPermissionForRequest: sinon.stub().rejects(
        new Error('PermissionsApi: Failed to fetch grants: 500 boom')
      ),
    };

    agent.dwn.applyReplicatedMessage.onFirstCall().resolves({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'thread-context',
        protocol,
        protocolPath  : 'thread/member',
        recipient     : 'did:example:bob',
      }],
    });

    await expect(admitClosure(rootCid, {
      did         : 'did:example:alice',
      dwnUrl      : 'https://dwn.example.com',
      delegateDid : 'did:example:delegate',
      agent,
      permissionsApi,
      prefetched  : [{ message: root.message }],
    })).rejects.toThrow('Failed to fetch grants');
  });

  it('admits dependency chains deeper than the historical eight-pass budget', async () => {
    const chain = await Promise.all(
      Array.from({ length: 10 }, () => TestDataGenerator.generateRecordsWrite())
    );
    const cids = await Promise.all(chain.map(entry => Message.getCid(entry.message)));
    const rootIndex = chain.length - 1;
    const rootCid = cids[rootIndex];
    const agent = createMockAgent();
    const appliedCids = new Set<string>();

    agent.rpc.sendDwnRequest.callsFake(async () => {
      const messageCid = agent.processDwnRequest.lastCall.args[0].messageParams.messageCid;
      const index = cids.indexOf(messageCid);
      return {
        status : { code: 200 },
        entry  : { message: chain[index].message },
      };
    });

    agent.dwn.applyReplicatedMessage.callsFake(async (_tenant: string, message: any) => {
      const cid = await Message.getCid(message);
      const index = cids.indexOf(cid);
      if (appliedCids.has(cid)) {
        return { kind: 'Duplicate' };
      }

      if (index > 0 && !appliedCids.has(cids[index - 1])) {
        return {
          kind    : 'Incomplete',
          missing : [{
            type              : 'Grant',
            messageCid        : cids[index - 1],
            permissionGrantId : `grant-${index - 1}`,
          }],
        };
      }

      appliedCids.add(cid);
      return { kind: 'Applied' };
    });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: chain[rootIndex].message }],
    });

    expect(outcome.kind).toBe('admitted');
    expect(appliedCids).toEqual(new Set(cids));
  });

  it('fetches cross-protocol record references by record ID and protocol', async () => {
    const protocol = 'https://example.com/protocol';
    const referencedProtocol = 'https://example.com/referenced-protocol';
    const root = await TestDataGenerator.generateRecordsWrite({ protocol });
    const referenced = await TestDataGenerator.generateRecordsWrite({ protocol: referencedProtocol });
    const rootCid = await Message.getCid(root.message);
    const referencedCid = await Message.getCid(referenced.message);
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status  : { code: 200 },
      entries : [referenced.message],
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{
          type     : 'CrossProtocolRef',
          protocol : referencedProtocol,
          recordId : referenced.message.recordId,
        }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: root.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [referencedCid, rootCid] });
    expect(agent.dwn.processRequest.firstCall.args[0]).toMatchObject({
      author        : 'did:example:alice',
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol : referencedProtocol,
          recordId : referenced.message.recordId,
        },
      },
    });
    expect(agent.dwn.applyReplicatedMessage.secondCall.args[1]).toEqual(referenced.message);
  });

  it('fetches key-delivery context-key records for encrypted dependency admission', async () => {
    const protocol = 'https://example.com/protocol';
    const contextId = 'root-context';
    const root = await TestDataGenerator.generateRecordsWrite({ protocol });
    const contextKey = await TestDataGenerator.generateRecordsWrite({
      protocol     : KeyDeliveryProtocolDefinition.protocol,
      protocolPath : 'contextKey',
      recipient    : 'did:example:delegate',
      tags         : { protocol, contextId },
    });
    const rootCid = await Message.getCid(root.message);
    const contextKeyCid = await Message.getCid(contextKey.message);
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status  : { code: 200 },
      entries : [contextKey.message],
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'KeyDelivery', protocol, contextId }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did         : 'did:example:alice',
      dwnUrl      : 'https://dwn.example.com',
      delegateDid : 'did:example:delegate',
      agent,
      prefetched  : [{ message: root.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [contextKeyCid, rootCid] });
    expect(agent.dwn.processRequest.firstCall.args[0]).toMatchObject({
      author        : 'did:example:delegate',
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          tags         : { protocol, contextId },
        },
      },
    });
    expect(agent.dwn.applyReplicatedMessage.secondCall.args[1]).toEqual(contextKey.message);
  });

  it('fetches record data with RecordsRead and retries with the data stream', async () => {
    const protocol = 'https://example.com/protocol';
    const root = await TestDataGenerator.generateRecordsWrite({ protocol });
    const dataRecord = await TestDataGenerator.generateRecordsWrite({
      data: new Uint8Array([4, 5, 6]),
      protocol,
    });
    const rootCid = await Message.getCid(root.message);
    const dataRecordCid = await Message.getCid(dataRecord.message);
    const dataCid = dataRecord.message.descriptor.dataCid;
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status : { code: 200 },
      entry  : {
        recordsWrite : dataRecord.message,
        data         : streamFromBytes(dataRecord.dataBytes!),
      },
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'RecordData', recordId: dataRecord.message.recordId, dataCid, protocol }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: root.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [dataRecordCid, rootCid] });
    expect(agent.dwn.processRequest.firstCall.args[0]).toMatchObject({
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter: { recordId: dataRecord.message.recordId },
      },
    });
    expect(agent.dwn.applyReplicatedMessage.secondCall.args[2].dataStream).toBeDefined();
  });

  it('fails admission when a record data dependency exceeds descriptor dataSize', async () => {
    const protocol = 'https://example.com/protocol';
    const root = await TestDataGenerator.generateRecordsWrite({ protocol });
    const dataRecord = await TestDataGenerator.generateRecordsWrite({
      data: new Uint8Array([4]),
      protocol,
    });
    const rootCid = await Message.getCid(root.message);
    const dataCid = dataRecord.message.descriptor.dataCid;
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status : { code: 200 },
      entry  : {
        recordsWrite : dataRecord.message,
        data         : streamFromBytes(new Uint8Array([4, 5])),
      },
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'RecordData', recordId: dataRecord.message.recordId, dataCid, protocol }],
      })
      .onSecondCall().callsFake(async (
        _tenant: string,
        _message: unknown,
        options: { dataStream?: ReadableStream<Uint8Array> },
      ): Promise<{ kind: 'Applied' }> => {
        await readStreamBytes(options.dataStream!);
        return { kind: 'Applied' };
      });

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: root.message }],
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') {
      throw new Error('expected admission to fail');
    }
    expect(outcome.rootCid).toBe(rootCid);
    expect(outcome.reason).toBe('invalid');
    expect(outcome.detail).toContain('RecordsWrite data exceeded descriptor dataSize');
    expect(agent.dwn.applyReplicatedMessage.callCount).toBe(2);
  });

  it('does not admit a source-latest RecordsWrite when its data is unavailable', async () => {
    const recordsWrite = await TestDataGenerator.generateRecordsWrite({
      data     : new Uint8Array([1, 2, 3]),
      protocol : 'https://example.com/protocol',
    });
    const rootCid = await Message.getCid(recordsWrite.message);
    const agent = createMockAgent();

    const outcome = await admitClosure(rootCid, {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{
        message           : recordsWrite.message,
        isLatestBaseState : true,
      }],
    });

    expect(outcome).toEqual({
      kind    : 'failed',
      rootCid : rootCid,
      reason  : 'terminal',
      detail  : 'latest records write data is unavailable',
    });
    expect(agent.dwn.applyReplicatedMessage.called).toBe(false);
  });

  it('fetches the newest tenant protocol config', async () => {
    const protocol = 'https://example.com/protocol';
    const definition = {
      protocol,
      published : true,
      types     : {
        post: { schema: 'https://example.com/post', dataFormats: ['text/plain'] },
      },
      structure: { post: {} },
    };
    const older = await TestDataGenerator.generateProtocolsConfigure({ protocolDefinition: definition });
    const newer = await TestDataGenerator.generateProtocolsConfigure({
      author             : older.author,
      protocolDefinition : definition,
    });
    older.message.descriptor.messageTimestamp = '2024-01-01T00:00:00.000000Z';
    newer.message.descriptor.messageTimestamp = '2024-01-02T00:00:00.000000Z';

    const root = await TestDataGenerator.generateRecordsWrite({
      author: older.author,
      protocol,
    });
    const rootCid = await Message.getCid(root.message);
    const newerCid = await Message.getCid(newer.message);
    const agent = createMockAgent();

    agent.rpc.sendDwnRequest.resolves({
      status  : { code: 200 },
      entries : [older.message, newer.message],
    });
    agent.dwn.applyReplicatedMessage
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'Protocol', protocol }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });

    const outcome = await admitClosure(rootCid, {
      did        : older.author.did,
      dwnUrl     : 'https://dwn.example.com',
      agent,
      prefetched : [{ message: root.message }],
    });

    expect(outcome).toEqual({ kind: 'admitted', appliedCids: [newerCid, rootCid] });
    expect(agent.dwn.processRequest.firstCall.args[0]).toMatchObject({
      author        : older.author.did,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : {
        filter: { protocol },
      },
    });
    expect(agent.dwn.applyReplicatedMessage.secondCall.args[1]).toEqual(newer.message);
  });
});
