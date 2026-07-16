/**
 * E2E: Live sync push + pull convergence.
 *
 * Creates an agent, writes a record locally, and verifies it appears on
 * the remote DWN via live sync push. Then writes directly to the remote
 * and verifies the live pull subscription applies the record locally.
 * Proves the full pipeline:
 *   local write -> EventLog -> live push subscription -> remote DWN
 *   remote DWN -> live pull subscription -> local DWN
 *
 * Requires: DWN server running on localhost:3000 (or TEST_DWN_URL),
 *           Pkarr relay on localhost:7527 (or DID_DHT_GATEWAY_URI).
 */
import type { SyncEngineLevel } from '../../src/sync-engine-level.js';
import type { GenericMessage, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, DwnInterfaceName, DwnMethodName, Message } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../../src/test-harness.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';

const testDwnUrls = [testDwnUrl];
const largeDataSize = DwnConstant.maxDataSizeAllowedToBeEncoded + 1_000;

type PushEchoProbe = {
  localApplyCount: (messageCid: string) => number;
  remoteMessagesReadCount: (messageCid: string) => number;
  restore: () => void;
};

type ObservableSyncEngine = {
  _activeLinks: Map<string, { pull: { contiguousAppliedToken?: { messageCid?: string; position?: string } } }>;
  _recentlyPushedCids: Map<string, number>;
};

const chatProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://e2e-convergence.xyz/chat',
  types     : {
    message: {
      schema      : 'https://e2e-convergence.xyz/schemas/message',
      dataFormats : ['text/plain'],
    },
  },
  structure: { message: {} },
};

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('E2E: live sync convergence', () => {
  beforeAll(async () => {
    await requireDwnServer();
  });

  let harness: PlatformAgentTestHarness;
  let aliceDid: string;
  let recordId: string;

  function installPushEchoProbe(): PushEchoProbe {
    const remoteReads = new Map<string, number>();
    const localApplies = new Map<string, number>();
    const rpc = harness.agent.rpc;
    const localDwn = harness.agent.dwn;
    const originalSendDwnRequest = rpc.sendDwnRequest;
    const originalApplyReplicatedMessage = localDwn.applyReplicatedMessage;

    rpc.sendDwnRequest = async (
      request: Parameters<typeof originalSendDwnRequest>[0],
    ): Promise<Awaited<ReturnType<typeof originalSendDwnRequest>>> => {
      const descriptor = (request.message as GenericMessage).descriptor as
        GenericMessage['descriptor'] & { messageCid?: string };
      if (
        descriptor.interface === DwnInterfaceName.Messages &&
        descriptor.method === DwnMethodName.Read &&
        descriptor.messageCid !== undefined
      ) {
        remoteReads.set(descriptor.messageCid, (remoteReads.get(descriptor.messageCid) ?? 0) + 1);
      }
      return originalSendDwnRequest.call(rpc, request);
    };

    localDwn.applyReplicatedMessage = async (
      ...args: Parameters<typeof originalApplyReplicatedMessage>
    ): Promise<Awaited<ReturnType<typeof originalApplyReplicatedMessage>>> => {
      const messageCid = await Message.getCid(args[1] as GenericMessage);
      localApplies.set(messageCid, (localApplies.get(messageCid) ?? 0) + 1);
      return originalApplyReplicatedMessage.call(localDwn, ...args);
    };

    return {
      localApplyCount         : (messageCid): number => localApplies.get(messageCid) ?? 0,
      remoteMessagesReadCount : (messageCid): number => remoteReads.get(messageCid) ?? 0,
      restore                 : (): void => {
        rpc.sendDwnRequest = originalSendDwnRequest;
        localDwn.applyReplicatedMessage = originalApplyReplicatedMessage;
      },
    };
  }

  function pullCheckpointPosition(): string | undefined {
    const syncEngine = harness.agent.sync as SyncEngineLevel;
    const observable = syncEngine as unknown as ObservableSyncEngine;
    return [...observable._activeLinks.values()][0]?.pull.contiguousAppliedToken?.position;
  }

  async function expectPushEchoSuppressed(
    messageCid: string,
    previousPullPosition: string | undefined,
    probe: PushEchoProbe,
  ): Promise<void> {
    const syncEngine = harness.agent.sync as SyncEngineLevel;
    const observable = syncEngine as unknown as ObservableSyncEngine;
    await waitFor(() => {
      const token = [...observable._activeLinks.values()][0]?.pull.contiguousAppliedToken;
      return token?.messageCid === messageCid && token.position !== previousPullPosition;
    }, 10_000, 100);

    expect([...observable._recentlyPushedCids.keys()].some((key): boolean => key.startsWith(`${messageCid}|`))).toBe(true);
    expect(probe.remoteMessagesReadCount(messageCid)).toBe(0);
    expect(probe.localApplyCount(messageCid)).toBe(0);
  }

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-convergence',
    });
    await harness.createAgentDid();

    const alice = await harness.createIdentity({
      name: 'E2E-Convergence-Alice',
      testDwnUrls,
    });
    aliceDid = alice.did.uri;

    // Install protocol locally and on remote.
    await harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
    });
    await harness.agent.dwn.sendRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
    });

    // Register for sync and start live mode.
    await harness.agent.sync.registerIdentity({
      did     : aliceDid,
      options : { protocols: [chatProtocol.protocol] },
    });
    await harness.agent.sync.startSync({ mode: 'live', interval: '30s' });
    expect(harness.agent.sync.hasActiveSubscriptions).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await harness?.agent.sync.stopSync();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('should push a local record without reading or applying its remote subscription echo', async () => {
    const probe = installPushEchoProbe();
    const previousPullPosition = pullCheckpointPosition();
    try {
      // Write a record locally.
      const dataBytes = Convert.string('e2e convergence test').toUint8Array();
      const writeResult = await harness.agent.dwn.processRequest({
        author        : aliceDid,
        target        : aliceDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'message',
          schema       : chatProtocol.types.message.schema,
          dataFormat   : 'text/plain',
        },
        dataStream: new Blob([dataBytes]),
      });
      expect(writeResult.reply.status.code).toBe(202);
      recordId = writeResult.message!.recordId;
      const messageCid = await Message.getCid(writeResult.message!);

      await waitFor(async () => {
        const remoteResult = await harness.agent.dwn.sendRequest({
          author        : aliceDid,
          target        : aliceDid,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: { protocol: chatProtocol.protocol, recordId },
          },
        });
        return remoteResult.reply.status.code === 200 && (remoteResult.reply.entries?.length ?? 0) > 0;
      }, 10_000);
      await expectPushEchoSuppressed(messageCid, previousPullPosition, probe);
    } finally {
      probe.restore();
    }
  }, 20_000);

  it('should pull a remote-only record to local via live sync', async () => {
    const pullTestData = Convert.string('pull convergence test').toUint8Array();
    const remoteWrite = await harness.agent.dwn.sendRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'message',
        schema       : chatProtocol.types.message.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([pullTestData]),
    });
    expect(remoteWrite.reply.status.code).toBe(202);
    const pullRecordId = remoteWrite.message!.recordId;

    const beforePull = await harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: chatProtocol.protocol, recordId: pullRecordId },
      },
    });
    expect(beforePull.reply.entries?.length ?? 0).toBe(0);

    await waitFor(async () => {
      const afterPull = await harness.agent.dwn.processRequest({
        author        : aliceDid,
        target        : aliceDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: { protocol: chatProtocol.protocol, recordId: pullRecordId },
        },
      });
      return afterPull.reply.status.code === 200 && afterPull.reply.entries?.length === 1;
    }, 10_000);
  }, 20_000);

  it('should push a large local record without reading or applying its remote subscription echo', async () => {
    const probe = installPushEchoProbe();
    const previousPullPosition = pullCheckpointPosition();
    try {
      const dataBytes = largePayloadBytes(0x61);
      const writeResult = await harness.agent.dwn.processRequest({
        author        : aliceDid,
        target        : aliceDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'message',
          schema       : chatProtocol.types.message.schema,
          dataFormat   : 'text/plain',
        },
        dataStream: new Blob([dataBytes]),
      });
      expect(writeResult.reply.status.code).toBe(202);

      await expectLargeRecordData('remote', writeResult.message!.recordId, dataBytes);
      await expectPushEchoSuppressed(await Message.getCid(writeResult.message!), previousPullPosition, probe);
    } finally {
      probe.restore();
    }
  }, 30_000);

  it('should pull a large remote-only record to local via live sync', async () => {
    const dataBytes = largePayloadBytes(0x62);
    const remoteWrite = await harness.agent.dwn.sendRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'message',
        schema       : chatProtocol.types.message.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([dataBytes]),
    });
    expect(remoteWrite.reply.status.code).toBe(202);

    await expectLargeRecordData('local', remoteWrite.message!.recordId, dataBytes);
  }, 30_000);

  it('should report healthy sync with zero failed messages', async () => {
    const health = await harness.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
  });

  function largePayloadBytes(fill: number): Uint8Array {
    return new Uint8Array(largeDataSize).fill(fill);
  }

  async function expectLargeRecordData(
    location: 'local' | 'remote',
    recordId: string,
    expectedBytes: Uint8Array,
  ): Promise<void> {
    await waitFor(async () => {
      const record = await readRecordData(location, recordId);
      return record !== undefined &&
        record.dataSize === expectedBytes.byteLength &&
        bytesEqual(record.dataBytes, expectedBytes);
    }, 15_000);

    const record = await readRecordData(location, recordId);
    expect(record).toBeDefined();
    expect(record!.dataSize).toBe(expectedBytes.byteLength);
    expect(record!.dataBytes.byteLength).toBe(expectedBytes.byteLength);
    expect(bytesEqual(record!.dataBytes, expectedBytes)).toBe(true);
  }

  async function readRecordData(
    location: 'local' | 'remote',
    recordId: string,
  ): Promise<{ dataBytes: Uint8Array; dataSize: number } | undefined> {
    const request = {
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    };
    const { reply } = location === 'local'
      ? await harness.agent.dwn.processRequest(request)
      : await harness.agent.dwn.sendRequest(request);

    if (reply.status.code !== 200 || reply.entry?.data === undefined) {
      return undefined;
    }

    const dataSize = reply.entry.recordsWrite?.descriptor.dataSize;
    if (typeof dataSize !== 'number') {
      return undefined;
    }

    return {
      dataBytes: await DataStream.toBytes(reply.entry.data),
      dataSize,
    };
  }

  function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) {
      return false;
    }

    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
});
