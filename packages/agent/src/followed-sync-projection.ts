import type { ModulesConfigureMessage, ResolvedModuleGraph } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { RoleReplicationSupportBatch } from './sync-role-replication-support.js';
import type { FollowedSyncProjection, FollowedSyncSource } from './followed-sync-source.js';

import { DwnInterface } from './types/dwn.js';
import { DwnInterfaceName, DwnMethodName, preloadModuleDefinitions, resolveModuleGraph, resolveModuleRoleProjection } from '@enbox/dwn-sdk-js';
import { queryLocalMessageFeed, queryRemoteMessageFeed } from './sync-messages.js';

/** Confirmed missing metadata, permissions, or consumer policy; retain the desired selection for later recovery. */
export class FollowedSyncProjectionUnavailableError extends Error {
  public constructor(detail: string) {
    super(`Followed consumer projection is unavailable: ${detail}`);
    this.name = 'FollowedSyncProjectionUnavailableError';
  }
}

export type PreparedFollowedSyncProjection = {
  projection: FollowedSyncProjection;
  configurations: ModulesConfigureMessage[];
  graph: ResolvedModuleGraph;
};

/** Verify an explicitly selected public consumer at the root's accepted endpoint, including an empty feed. */
export async function prepareFollowedSyncProjection(params: {
  agent: EnboxPlatformAgent;
  delegateDid?: string;
  module: string;
  permissionsApi: PermissionsApi;
  rootBatch: RoleReplicationSupportBatch;
  source: FollowedSyncSource;
  shouldContinue: () => boolean;
  local?: boolean;
}): Promise<PreparedFollowedSyncProjection> {
  const { agent, delegateDid, module, permissionsApi, rootBatch, source, shouldContinue } = params;
  const messages = new Map<string, ModulesConfigureMessage>();
  for (const entry of rootBatch.dependencies) {
    if (entry.message.descriptor.interface === DwnInterfaceName.Modules &&
        entry.message.descriptor.method === DwnMethodName.Configure && entry.isLatestBaseState === true) {
      const message = entry.message as ModulesConfigureMessage;
      messages.set(message.descriptor.definition.module, message);
    }
  }
  const fetchDefinition = async (uri: string): Promise<ModulesConfigureMessage['descriptor']['definition']> => {
    if (!shouldContinue()) {throw new Error('followed projection preparation was cancelled');}
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
    const { reply } = params.local === true
      ? await agent.dwn.processRequest(request)
      : await agent.dwn.sendRequest({ ...request, remoteEndpoint: source.remoteEndpoint });
    if (reply.status.code !== 200) {
      if (reply.status.code >= 400 && reply.status.code < 500) {
        throw new FollowedSyncProjectionUnavailableError(`module '${uri}' metadata was denied (${reply.status.code}).`);
      }
      throw new Error(`Followed consumer module query failed (${reply.status.code}): ${reply.status.detail}`);
    }
    const entries = reply.entries ?? [];
    if (entries.length !== 1 || entries[0].descriptor.definition.published !== true) {
      throw new FollowedSyncProjectionUnavailableError(`module '${uri}' has no unique public owner configuration.`);
    }
    // AgentDwnApi verifies the owner's signature and requested URI before returning.
    messages.set(uri, entries[0]);
    return entries[0].descriptor.definition;
  };
  const definition = await fetchDefinition(module);
  const definitions = await preloadModuleDefinitions(definition, fetchDefinition);
  let projection: FollowedSyncProjection;
  let graph: ResolvedModuleGraph;
  try {
    graph = resolveModuleGraph(definition, uri => definitions.get(uri));
    const rootRole = rootBatch.resolvedGraph.resolveInvokedRole(source.moduleRole);
    const resolved = resolveModuleRoleProjection(graph, rootRole);
    projection = {
      module,
      moduleRole     : resolved.moduleRole,
      attachmentPath : resolved.attachmentPath,
      modulePaths    : resolved.readablePaths,
    };
  } catch (error: unknown) {
    throw new FollowedSyncProjectionUnavailableError(error instanceof Error ? error.message : String(error));
  }

  const grant = await resolveFollowedProjectionGrant({ source, projection, delegateDid, permissionsApi });
  if (!shouldContinue()) {throw new Error('followed projection preparation was cancelled');}
  const feed = {
    did            : source.sourceDid,
    authorDid      : source.actorDid,
    delegateDid,
    delegatedGrant : grant?.message,
    dwnUrl         : source.remoteEndpoint,
    moduleRole     : projection.moduleRole,
    agent,
    cidsOnly       : true,
    limit          : 1,
    filters        : projection.modulePaths.map(modulePath => ({
      interface       : DwnInterfaceName.Records,
      module,
      modulePath,
      contextIdPrefix : source.contextId,
    })),
  };
  const reply = params.local === true ? await queryLocalMessageFeed(feed) : await queryRemoteMessageFeed(feed);
  if (reply.status.code !== 200 || reply.roleRecordId !== source.id) {
    if (reply.status.code >= 500) {throw new Error(`Followed consumer feed failed (${reply.status.code}).`);}
    throw new FollowedSyncProjectionUnavailableError(`module '${module}' did not prove the accepted root role.`);
  }

  const configurations: ModulesConfigureMessage[] = [];
  const visited = new Set<string>();
  const append = (uri: string): void => {
    if (visited.has(uri)) {return;}
    visited.add(uri);
    const message = messages.get(uri)!;
    for (const target of Object.values(message.descriptor.definition.uses ?? {})) {append(target);}
    configurations.push(message);
  };
  append(module);
  return { configurations, projection, graph };
}

/** Check each selected consumer path and its feed without borrowing grants from the root module. */
export async function resolveFollowedProjectionGrant({ source, projection, delegateDid, permissionsApi }: {
  source: FollowedSyncSource;
  projection: FollowedSyncProjection;
  delegateDid?: string;
  permissionsApi: PermissionsApi;
}): Promise<Awaited<ReturnType<PermissionsApi['getPermissionForRequest']>> | undefined> {
  if (delegateDid === undefined) {return undefined;}
  for (const modulePath of projection.modulePaths) {
    await permissionsApi.getPermissionForRequest({ // NOSONAR: S9382 — stop at the first unapproved concrete consumer path.
      connectedDid : source.actorDid,
      delegateDid,
      delegate     : true,
      forceRefresh : true,
      messageType  : DwnInterface.RecordsRead,
      module       : projection.module,
      modulePath,
      contextId    : source.contextId,
    });
  }
  return permissionsApi.getPermissionForRequest({
    connectedDid : source.actorDid,
    delegateDid,
    delegate     : true,
    forceRefresh : true,
    messageType  : DwnInterface.MessagesQuery,
    module       : projection.module,
  });
}
