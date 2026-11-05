import type { ModuleDefinition, ResolvedModuleGraph } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';

import { preloadModuleDefinitions, resolveModuleGraph } from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { processDwnRequestWithRemoteFallback } from './dwn-read-through.js';
import { resolveDelegatePermissionGrantId } from './delegate-permission-grant.js';

/** Resolve installed definitions using the caller's actual signer and each provider's query authority. */
export async function loadAgentModuleGraph(params: {
  agent: EnboxPlatformAgent;
  authorDid: string;
  granteeDid?: string;
  module: string;
  targetDid: string;
}): Promise<ResolvedModuleGraph> {
  const signerDid = params.granteeDid ?? params.authorDid;
  const fetchDefinition = async (module: string): Promise<ModuleDefinition | undefined> => {
    const permissionGrantId = await resolveDelegatePermissionGrantId({
      did            : params.targetDid,
      delegateDid    : signerDid === params.targetDid ? undefined : signerDid,
      permissionsApi : params.agent.permissions,
    }, DwnInterface.ModulesQuery, module);
    const { reply } = await processDwnRequestWithRemoteFallback({
      process : params.agent.processDwnRequest.bind(params.agent),
      send    : params.agent.sendDwnRequest.bind(params.agent),
    }, {
      author        : signerDid,
      target        : params.targetDid,
      messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module }, permissionGrantId },
    }, response => response.status.code === 200 && (response.entries?.length ?? 0) > 0);
    if (reply.status.code !== 200) {
      throw new Error(`Unable to read module '${module}' for '${params.targetDid}': ${reply.status.detail}`);
    }
    return reply.entries?.[0]?.descriptor.definition;
  };

  const definition = await fetchDefinition(params.module);
  if (definition === undefined) {
    throw new Error(`Module '${params.module}' is not installed for '${params.targetDid}'.`);
  }
  const definitions = await preloadModuleDefinitions(definition, fetchDefinition);
  return resolveModuleGraph(definition, module => definitions.get(module));
}
