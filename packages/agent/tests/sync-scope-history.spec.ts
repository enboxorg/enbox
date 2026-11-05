import type { PermissionGrantEntry } from '../src/types/permissions.js';
import type { GenericMessage, ModuleDefinition, ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { Convert } from '@enbox/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';

const commentsModule = 'https://example.com/sync-history-comments';
const threadsModule = 'https://example.com/sync-history-threads';

type ModuleHistoryRequest = {
  granteeDid?: string;
  messageParams?: {
    cursor?: unknown;
    filters?: Array<{
      interface?: string;
      method?: string;
      module?: string;
    }>;
    limit?: number;
    permissionGrantIds?: string[];
  };
  messageType?: DwnInterface;
};

type ModuleHistoryPage = {
  cursor?: ProgressToken;
  drained?: boolean;
  entries?: Array<{ message?: GenericMessage }>;
  status: { code: number; detail: string };
};

describe('Sync scope closure — delegated module history', () => {
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

    await installModule(ownerDid, threadsModuleDefinition());
    await installModule(ownerDid, commentsModuleWithHistoricalDependency());
    await installModule(ownerDid, commentsModuleWithoutDependency());

    commentsGrant = await storeDelegateMessagesReadGrant(ownerDid, delegateDid, commentsModule);
    await storeDelegateMessagesReadGrant(ownerDid, delegateDid, threadsModule);
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('queries delegated retained module history with real MessagesQuery pagination', async () => {
    // This drives the DWN MessagesQuery cursor/drain path at a small page size; the production validator uses its fixed page size.
    const { definitions: pagedDefinitions, pages } = await queryAllDelegatedModuleHistoryPages(
      ownerDid,
      delegateDid,
      commentsGrant,
      commentsModule,
      1,
    );

    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].drained).toBe(false);
    expect(pages.at(-1)?.drained).toBe(true);
    expect(pagedDefinitions.some(definition => definition.uses?.threads === threadsModule)).toBe(true);
    expect(pagedDefinitions.some(definition => definition.uses === undefined)).toBe(true);
  });

  it('rejects delegated sync scope when retained module history contains a missing dependency', async () => {
    const processRequestSpy = sinon.spy(testHarness.agent.dwn, 'processRequest');

    await expect(syncEngine.setIdentityOptions({
      did     : ownerDid,
      options : {
        delegateDid,
        modules: [commentsModule],
      },
    })).rejects.toThrow(`${commentsModule} -> ${threadsModule}`);

    const commentsHistoryCalls = processRequestSpy.getCalls()
      .map(call => call.args[0] as ModuleHistoryRequest)
      .filter(request => isModuleHistoryQuery(request, commentsModule));

    expect(commentsHistoryCalls).toHaveLength(1);
    expect(commentsHistoryCalls[0].granteeDid).toBe(delegateDid);
    expect(commentsHistoryCalls[0].messageParams?.permissionGrantIds).toEqual([commentsGrant.grant.id]);
    expect(commentsHistoryCalls[0].messageParams?.cursor).toBeUndefined();
    expect(commentsHistoryCalls[0].messageParams?.limit).toBe(500);
  });

  async function installModule(tenantDid: string, definition: ModuleDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ModulesConfigure,
      messageParams : { definition },
    });

    expect(reply.status.code).toBe(202);
  }

  async function storeDelegateMessagesReadGrant(
    ownerDid: string,
    delegateDid: string,
    module: string,
  ): Promise<PermissionGrantEntry> {
    const grant = await testHarness.agent.permissions.createGrant({
      author      : ownerDid,
      dateExpires : Time.createOffsetTimestamp({ seconds: 3600 }),
      grantedTo   : delegateDid,
      scope       : {
        interface : DwnInterfaceName.Messages,
        method    : DwnMethodName.Read,
        module,
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

  async function queryAllDelegatedModuleHistoryPages(
    ownerDid: string,
    delegateDid: string,
    grant: PermissionGrantEntry,
    module: string,
    limit: number,
  ): Promise<{
    definitions: ModuleDefinition[];
    pages: ModuleHistoryPage[];
  }> {
    const definitions: ModuleDefinition[] = [];
    const pages: ModuleHistoryPage[] = [];
    let cursor: ProgressToken | undefined;

    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await queryDelegatedModuleHistory(ownerDid, delegateDid, grant, module, cursor, limit);
      expect(page.status.code).toBe(200);
      expect((page.entries?.length ?? 0) <= limit).toBe(true);
      pages.push(page);
      definitions.push(...moduleDefinitionsFromMessages(page.entries?.map(entry => entry.message)));

      if (page.drained === true) {
        return { definitions, pages };
      }
      expect(page.cursor).toBeDefined();
      cursor = page.cursor;
    }

    throw new Error('expected delegated module history query to drain within 10 pages');
  }

  async function queryDelegatedModuleHistory(
    ownerDid: string,
    delegateDid: string,
    grant: PermissionGrantEntry,
    module: string,
    cursor: ProgressToken | undefined,
    limit: number,
  ): Promise<ModuleHistoryPage> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      granteeDid    : delegateDid,
      target        : ownerDid,
      messageType   : DwnInterface.MessagesQuery,
      messageParams : {
        cursor,
        filters: [{
          interface : DwnInterfaceName.Modules,
          method    : DwnMethodName.Configure,
          module,
        }],
        limit,
        permissionGrantIds: [grant.grant.id],
      },
    });

    return reply;
  }
});

function isModuleHistoryQuery(request: ModuleHistoryRequest, module: string): boolean {
  const filter = request.messageParams?.filters?.[0];
  return request.messageType === DwnInterface.MessagesQuery &&
    filter?.interface === DwnInterfaceName.Modules &&
    filter.method === DwnMethodName.Configure &&
    filter.module === module;
}

function threadsModuleDefinition(): ModuleDefinition {
  return {
    module    : threadsModule,
    published : true,
    types     : {
      participant : { schema: `${threadsModule}/schemas/participant`, dataFormats: ['application/json'] },
      thread      : { schema: `${threadsModule}/schemas/thread`, dataFormats: ['application/json'] },
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

function commentsModuleWithHistoricalDependency(): ModuleDefinition {
  return {
    module    : commentsModule,
    published : true,
    uses      : { threads: threadsModule },
    types     : {
      comment: { schema: `${commentsModule}/schemas/comment-v0`, dataFormats: ['application/json'] },
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

function moduleDefinitionsFromMessages(messages: Array<GenericMessage | undefined> | undefined): ModuleDefinition[] {
  const definitions: ModuleDefinition[] = [];
  for (const message of messages ?? []) {
    const definition = (message?.descriptor as { definition?: unknown } | undefined)?.definition;
    if (typeof definition === 'object' && definition !== null && typeof (definition as { module?: unknown }).module === 'string') {
      definitions.push(definition as ModuleDefinition);
    }
  }
  return definitions;
}

function commentsModuleWithoutDependency(): ModuleDefinition {
  return {
    module    : commentsModule,
    published : true,
    types     : {
      comment: { schema: `${commentsModule}/schemas/comment-current`, dataFormats: ['application/json'] },
    },
    structure: {
      comment: {
        $actions: [{ who: 'anyone', can: ['create', 'read'] }],
      },
    },
  };
}
