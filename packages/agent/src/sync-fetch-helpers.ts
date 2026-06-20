import type { DwnInterface } from './types/dwn.js';
import type { PermissionsApi } from './types/permissions.js';
import type { DependencyRef, GenericMessage, ProtocolsConfigureMessage } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, Message } from '@enbox/dwn-sdk-js';

/**
 * Helpers shared by the push (`sync-messages.ts`) and pull (`sync-admit-closure.ts`)
 * dependency-closure fetch paths. These were previously duplicated verbatim in both
 * modules; keep them here so the two paths cannot drift.
 */

/**
 * Resolves the delegate permission grant ID authorizing a sync fetch request, or
 * `undefined` for owner requests (no delegate configured) and when no matching grant
 * exists. Only the expected "no matching grant" case is swallowed; any other error
 * (store/network failure, revocation-check failure, parse error) surfaces so a real
 * resolution failure is not silently treated as "no grant".
 */
export async function resolveDelegatePermissionGrantId(
  deps: { did: string; delegateDid?: string; permissionsApi?: PermissionsApi },
  messageType: DwnInterface,
  protocol: string,
): Promise<string | undefined> {
  if (deps.delegateDid === undefined || deps.permissionsApi === undefined) {
    return undefined;
  }

  try {
    const { grant } = await deps.permissionsApi.getPermissionForRequest({
      connectedDid : deps.did,
      delegateDid  : deps.delegateDid,
      protocol,
      cached       : true,
      messageType,
    });
    return grant.id;
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('No permissions found')) {
      return undefined;
    }
    throw error;
  }
}

/** Stable cache/identity key for a dependency reference. */
export function dependencyKey(ref: DependencyRef): string {
  return JSON.stringify(ref);
}

/** Whether any dependency is known to be unreachable (a terminal closure failure). */
export function hasTerminalDependency(refs: DependencyRef[]): boolean {
  return refs.some(ref => ref.terminal === true);
}

/** Human-readable detail listing the missing dependencies. */
export function missingDependencyDetail(refs: DependencyRef[]): string {
  return refs.map(dependencyKey).join(', ');
}

/** Type guard for a `ProtocolsConfigure` message. */
export function isProtocolsConfigureMessage(message: GenericMessage): message is ProtocolsConfigureMessage {
  return message.descriptor.interface === DwnInterfaceName.Protocols &&
    message.descriptor.method === DwnMethodName.Configure &&
    (message.descriptor as { definition?: unknown }).definition !== undefined;
}

/** Predicate matching a tenant's own configuration of a given protocol. */
export function isTenantProtocolConfig(tenantDid: string, protocol: string): (message: GenericMessage) => message is ProtocolsConfigureMessage {
  return (message: GenericMessage): message is ProtocolsConfigureMessage => {
    if (!isProtocolsConfigureMessage(message)) {
      return false;
    }

    return message.descriptor.definition.protocol === protocol && Message.getAuthor(message) === tenantDid;
  };
}

/** Returns the newest protocol configuration by message timestamp. */
export function newestProtocolConfig(configs: ProtocolsConfigureMessage[]): ProtocolsConfigureMessage | undefined {
  let newest: ProtocolsConfigureMessage | undefined;
  for (const config of configs) {
    if (newest === undefined || config.descriptor.messageTimestamp > newest.descriptor.messageTimestamp) {
      newest = config;
    }
  }
  return newest;
}
