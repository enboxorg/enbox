import type { PermissionGrantEntry } from '../src/types/permissions.js';
import type { GenericMessage, ProgressToken, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { Convert } from '@enbox/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';

const commentsProtocol = 'https://example.com/sync-history-comments';
const threadsProtocol = 'https://example.com/sync-history-threads';

type ProtocolHistoryRequest = {
  granteeDid?: string;
  messageParams?: {
    cursor?: unknown;
    filters?: Array<{
      interface?: string;
      method?: string;
      protocol?: string;
    }>;
    limit?: number;
    permissionGrantIds?: string[];
  };
  messageType?: DwnInterface;
};

type ProtocolHistoryPage = {
  cursor?: ProgressToken;
  drained?: boolean;
  entries?: Array<{ message?: GenericMessage }>;
  status: { code: number; detail: string };
};

describe('Sync scope closure — delegated protocol history', () => {
  let testHarness: PlatformAgentTestHarness;
  let syncEngine: SyncEngineLevel;
  let commentsGrant: PermissionGrantEntry;
  let delegateDid: string;
  let ownerDid: string;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/sync-scope-history-spec',
    });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
    testHarness.agent.sync = syncEngine;
  });

  beforeEach(async () => {
    sinon.restore();
    await syncEngine.clear();
    await testHarness.clearDwnStores();

    const owner = await testHarness.agent.identity.create({
      didMethod : 'jwk',
      metadata  : { name: 'History Owner' },
    });
    const delegate = await testHarness.agent.identity.create({
      didMethod : 'jwk',
      metadata  : { connectedDid: owner.did.uri, name: 'History Delegate' },
    });

    ownerDid = owner.did.uri;
    delegateDid = delegate.did.uri;

    await installProtocol(ownerDid, threadsProtocolDefinition());
    await installProtocol(ownerDid, commentsProtocolWithHistoricalDependency());
    await installProtocol(ownerDid, commentsProtocolWithoutDependency());

    commentsGrant = await storeDelegateMessagesReadGrant(ownerDid, delegateDid, commentsProtocol);
    await storeDelegateMessagesReadGrant(ownerDid, delegateDid, threadsProtocol);
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('queries delegated retained protocol history with real MessagesQuery pagination', async () => {
    // This drives the DWN MessagesQuery cursor/drain path at a small page size; the production validator uses its fixed page size.
    const { definitions: pagedDefinitions, pages } = await queryAllDelegatedProtocolHistoryPages(
      ownerDid,
      delegateDid,
      commentsGrant,
      commentsProtocol,
      1,
    );

    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].drained).toBe(false);
    expect(pages.at(-1)?.drained).toBe(true);
    expect(pagedDefinitions.some(definition => definition.uses?.threads === threadsProtocol)).toBe(true);
    expect(pagedDefinitions.some(definition => definition.uses === undefined)).toBe(true);
  });

  it('rejects delegated sync scope when retained protocol history contains a missing dependency', async () => {
    const processRequestSpy = sinon.spy(testHarness.agent.dwn, 'processRequest');

    await expect(syncEngine.registerIdentity({
      did     : ownerDid,
      options : {
        delegateDid,
        protocols: [commentsProtocol],
      },
    })).rejects.toThrow(`${commentsProtocol} -> ${threadsProtocol}`);

    const commentsHistoryCalls = processRequestSpy.getCalls()
      .map(call => call.args[0] as ProtocolHistoryRequest)
      .filter(request => isProtocolHistoryQuery(request, commentsProtocol));

    expect(commentsHistoryCalls).toHaveLength(1);
    expect(commentsHistoryCalls[0].granteeDid).toBe(delegateDid);
    expect(commentsHistoryCalls[0].messageParams?.permissionGrantIds).toEqual([commentsGrant.grant.id]);
    expect(commentsHistoryCalls[0].messageParams?.cursor).toBeUndefined();
    expect(commentsHistoryCalls[0].messageParams?.limit).toBe(500);
  });

  async function installProtocol(tenantDid: string, definition: ProtocolDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });

    expect(reply.status.code).toBe(202);
  }

  async function storeDelegateMessagesReadGrant(
    ownerDid: string,
    delegateDid: string,
    protocol: string,
  ): Promise<PermissionGrantEntry> {
    const grant = await testHarness.agent.permissions.createGrant({
      author      : ownerDid,
      dateExpires : Time.createOffsetTimestamp({ seconds: 3600 }),
      grantedTo   : delegateDid,
      scope       : {
        interface : DwnInterfaceName.Messages,
        method    : DwnMethodName.Read,
        protocol,
      },
      store: true,
    });

    const { encodedData, ...grantMessage } = grant.message;
    const { reply } = await testHarness.agent.processDwnRequest({
      author      : delegateDid,
      dataStream  : new Blob([Convert.base64Url(encodedData).toUint8Array()]),
      messageType : DwnInterface.RecordsWrite,
      rawMessage  : grantMessage,
      signAsOwner : true,
      target      : delegateDid,
    });

    expect(reply.status.code).toBe(202);
    return grant;
  }

  async function queryAllDelegatedProtocolHistoryPages(
    ownerDid: string,
    delegateDid: string,
    grant: PermissionGrantEntry,
    protocol: string,
    limit: number,
  ): Promise<{
    definitions: ProtocolDefinition[];
    pages: ProtocolHistoryPage[];
  }> {
    const definitions: ProtocolDefinition[] = [];
    const pages: ProtocolHistoryPage[] = [];
    let cursor: ProgressToken | undefined;

    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await queryDelegatedProtocolHistory(ownerDid, delegateDid, grant, protocol, cursor, limit);
      expect(page.status.code).toBe(200);
      expect((page.entries?.length ?? 0) <= limit).toBe(true);
      pages.push(page);
      definitions.push(...protocolDefinitionsFromMessages(page.entries?.map(entry => entry.message)));

      if (page.drained === true) {
        return { definitions, pages };
      }
      expect(page.cursor).toBeDefined();
      cursor = page.cursor;
    }

    throw new Error('expected delegated protocol history query to drain within 10 pages');
  }

  async function queryDelegatedProtocolHistory(
    ownerDid: string,
    delegateDid: string,
    grant: PermissionGrantEntry,
    protocol: string,
    cursor: ProgressToken | undefined,
    limit: number,
  ): Promise<ProtocolHistoryPage> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      granteeDid    : delegateDid,
      target        : ownerDid,
      messageType   : DwnInterface.MessagesQuery,
      messageParams : {
        cursor,
        filters: [{
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Configure,
          protocol,
        }],
        limit,
        permissionGrantIds: [grant.grant.id],
      },
    });

    return reply;
  }
});

function isProtocolHistoryQuery(request: ProtocolHistoryRequest, protocol: string): boolean {
  const filter = request.messageParams?.filters?.[0];
  return request.messageType === DwnInterface.MessagesQuery &&
    filter?.interface === DwnInterfaceName.Protocols &&
    filter.method === DwnMethodName.Configure &&
    filter.protocol === protocol;
}

function threadsProtocolDefinition(): ProtocolDefinition {
  return {
    protocol  : threadsProtocol,
    published : true,
    types     : {
      participant : { schema: `${threadsProtocol}/schemas/participant`, dataFormats: ['application/json'] },
      thread      : { schema: `${threadsProtocol}/schemas/thread`, dataFormats: ['application/json'] },
    },
    structure: {
      thread: {
        $actions    : [{ who: 'anyone', can: ['create', 'read'] }],
        participant : {
          $role    : true,
          $actions : [
            { who: 'anyone', can: ['read'] },
            { who: 'author', of: 'thread', can: ['create'] },
          ],
        },
      },
    },
  };
}

function commentsProtocolWithHistoricalDependency(): ProtocolDefinition {
  return {
    protocol  : commentsProtocol,
    published : true,
    uses      : { threads: threadsProtocol },
    types     : {
      comment: { schema: `${commentsProtocol}/schemas/comment-v0`, dataFormats: ['application/json'] },
    },
    structure: {
      thread: {
        $ref    : 'threads:thread',
        comment : {
          $actions: [
            { who: 'anyone', can: ['create'] },
            { role: 'threads:thread/participant', can: ['read'] },
          ],
        },
      },
    },
  };
}

function protocolDefinitionsFromMessages(messages: Array<GenericMessage | undefined> | undefined): ProtocolDefinition[] {
  const definitions: ProtocolDefinition[] = [];
  for (const message of messages ?? []) {
    const definition = (message?.descriptor as { definition?: unknown } | undefined)?.definition;
    if (typeof definition === 'object' && definition !== null && typeof (definition as { protocol?: unknown }).protocol === 'string') {
      definitions.push(definition as ProtocolDefinition);
    }
  }
  return definitions;
}

function commentsProtocolWithoutDependency(): ProtocolDefinition {
  return {
    protocol  : commentsProtocol,
    published : true,
    types     : {
      comment: { schema: `${commentsProtocol}/schemas/comment-current`, dataFormats: ['application/json'] },
    },
    structure: {
      comment: {
        $actions: [{ who: 'anyone', can: ['create', 'read'] }],
      },
    },
  };
}
