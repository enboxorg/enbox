import type { ModulesConfigureMessage, ResolvedModuleGraph } from '@enbox/dwn-sdk-js';

import type { DwnDataEncodedRecordsWriteMessage } from './types/dwn.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { RoleReplicationSupportBatch } from './sync-role-replication-support.js';
import type { FollowedModuleScope, FollowedSyncSource } from './followed-sync-source.js';

import { DwnInterface } from './types/dwn.js';
import { orderMessagesForAdmission } from './sync-admission-order.js';
import { DwnError, DwnInterfaceName, DwnMethodName, preloadModuleDefinitions, resolveModuleGraph, resolveModuleRoleScope } from '@enbox/dwn-sdk-js';
import { queryLocalMessageFeed, queryRemoteMessageFeed } from './sync-messages.js';

/** Matches RecordsReadReplicationSupport's MAX_SUPPORT_MODULE_CONFIGS bound. */
const MAX_FOLLOWED_MODULE_CONFIGS = 64;

/** Confirmed missing metadata, permissions, or consumer policy; retain the desired selection for later recovery. */
export class FollowedModuleUnavailableError extends Error {
  public constructor(detail: string) {
    super(`Followed module scope is unavailable: ${detail}`);
    this.name = 'FollowedModuleUnavailableError';
  }
}

export type PreparedFollowedModule = {
  module: string;
  scope: FollowedModuleScope;
  configurations: ModulesConfigureMessage[];
  graph: ResolvedModuleGraph;
};

/** Resolve an accepted module from verified root support and its exact local or hosted metadata. */
export async function prepareFollowedModule(params: {
  agent: EnboxPlatformAgent;
  delegateDid?: string;
  module: string;
  permissionsApi: PermissionsApi;
  rootBatch: RoleReplicationSupportBatch;
  source: FollowedSyncSource;
  shouldContinue: () => boolean;
  isLocal?: boolean;
}): Promise<PreparedFollowedModule> {
  const { agent, delegateDid, module, rootBatch, source, shouldContinue } = params;
  const messages = new Map<string, ModulesConfigureMessage>();
  for (const entry of rootBatch.dependencies) {
    if (entry.message.descriptor.interface === DwnInterfaceName.Modules &&
        entry.message.descriptor.method === DwnMethodName.Configure && entry.isLatestBaseState === true) {
      const message = entry.message as ModulesConfigureMessage;
      messages.set(message.descriptor.definition.module, message);
    }
  }
  const visitedUris = new Set<string>();
  const fetchDefinition = async (uri: string): Promise<ModulesConfigureMessage['descriptor']['definition']> => {
    if (!shouldContinue()) {throw new Error('prepareFollowedModule: followed module preparation was cancelled');}
    if (!visitedUris.has(uri)) {
      if (visitedUris.size >= MAX_FOLLOWED_MODULE_CONFIGS) {
        throw new FollowedModuleUnavailableError(
          `module '${module}' exceeds the ${MAX_FOLLOWED_MODULE_CONFIGS}-module dependency limit.`,
        );
      }
      visitedUris.add(uri);
    }
    const known = messages.get(uri);
    if (known !== undefined) {return known.descriptor.definition;}
    // This intentionally requests only public metadata. An actor-to-delegate
    // grant is never repurposed as owner authority over a foreign tenant.
    const request = {
      author        : delegateDid ?? source.actorDid,
      target        : source.sourceDid,
      messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module: uri } },
    } as const;
    const { reply } = params.isLocal === true
      ? await agent.dwn.processRequest(request)
      : await agent.dwn.sendRequest({ ...request, remoteEndpoint: source.remoteEndpoint });
    if (reply.status.code !== 200) {
      if (reply.status.code >= 400 && reply.status.code < 500) {
        throw new FollowedModuleUnavailableError(`module '${uri}' metadata was denied (${reply.status.code}).`);
      }
      throw new Error(`prepareFollowedModule: followed consumer module query failed (${reply.status.code}): ${reply.status.detail}`);
    }
    const entries = reply.entries ?? [];
    if (entries.length !== 1 || entries[0].descriptor.definition.published !== true) {
      throw new FollowedModuleUnavailableError(`module '${uri}' has no unique public owner configuration.`);
    }
    // AgentDwnApi verifies the owner's signature and requested URI before returning.
    messages.set(uri, entries[0]);
    return entries[0].descriptor.definition;
  };
  const definition = await fetchDefinition(module);
  let definitions: ReadonlyMap<string, ModulesConfigureMessage['descriptor']['definition']>;
  try {
    definitions = await preloadModuleDefinitions(definition, fetchDefinition);
  } catch (error: unknown) {
    if (error instanceof DwnError) {
      throw new FollowedModuleUnavailableError(error.message);
    }
    throw error;
  }
  let scope: FollowedModuleScope;
  let graph: ResolvedModuleGraph;
  try {
    graph = resolveModuleGraph(definition, uri => definitions.get(uri));
    const rootRole = rootBatch.resolvedGraph.resolveInvokedRole(source.modules[source.rootModule]!.moduleRole);
    const resolved = resolveModuleRoleScope(graph, rootRole);
    scope = {
      moduleRole  : resolved.moduleRole,
      contextPath : resolved.contextPath,
      modulePaths : resolved.readablePaths,
    };
  } catch (error: unknown) {
    throw new FollowedModuleUnavailableError(error instanceof Error ? error.message : String(error));
  }

  // A real root is proven by its RecordsRead support. A virtual consumer needs
  // its own path grants and feed proof, even when that feed contains no records.
  if (module !== source.rootModule) {await verifyConsumerScope(params, scope);}

  const configurations = orderMessagesForAdmission(
    [...definitions.keys()].map(uri => ({ message: messages.get(uri)! })),
  ).map(entry => entry.message);
  return { configurations, module, scope, graph };
}

/** Prove consumer-specific delegated coverage and the root role on its exact feed. */
async function verifyConsumerScope(params: Parameters<typeof prepareFollowedModule>[0], scope: FollowedModuleScope): Promise<void> {
  const { source, module, delegateDid, permissionsApi, agent, shouldContinue, isLocal } = params;
  let delegatedGrant: DwnDataEncodedRecordsWriteMessage | undefined;
  if (delegateDid !== undefined) {
    let needsCatalogRefresh = true;
    for (const modulePath of scope.modulePaths) {
      await permissionsApi.getPermissionForRequest({ // NOSONAR: S9382 — stop at the first unapproved concrete consumer path.
        connectedDid : source.actorDid, delegateDid, delegate     : true, forceRefresh : needsCatalogRefresh,
        messageType  : DwnInterface.RecordsRead, module, modulePath, contextId    : source.contextId,
      });
      needsCatalogRefresh = false;
    }
    delegatedGrant = (await permissionsApi.getPermissionForRequest({
      connectedDid : source.actorDid, delegateDid, delegate     : true, forceRefresh : needsCatalogRefresh,
      messageType  : DwnInterface.MessagesQuery, module,
    })).message;
  }
  if (!shouldContinue()) {throw new Error('prepareFollowedModule: followed module preparation was cancelled');}
  const feed = {
    did        : source.sourceDid, authorDid  : source.actorDid, delegateDid, delegatedGrant,
    dwnUrl     : source.remoteEndpoint, moduleRole : scope.moduleRole, agent, cidsOnly   : true, limit      : 1,
    filters    : scope.modulePaths.map(modulePath => ({
      interface: DwnInterfaceName.Records, module, modulePath, contextIdPrefix: source.contextId,
    })),
  };
  const reply = isLocal === true ? await queryLocalMessageFeed(feed) : await queryRemoteMessageFeed(feed);
  if (reply.status.code !== 200 || reply.roleRecordId !== source.id) {
    if (reply.status.code >= 500) {throw new Error(`prepareFollowedModule: followed consumer feed failed (${reply.status.code}).`);}
    throw new FollowedModuleUnavailableError(`module '${module}' did not prove the accepted root role.`);
  }
}
