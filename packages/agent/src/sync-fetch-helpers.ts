import type { DwnInterface } from './types/dwn.js';
import type { PermissionsApi } from './types/permissions.js';
import type { DependencyRef, GenericMessage, ProtocolsConfigureMessage } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, EncryptionProtocol, Message } from '@enbox/dwn-sdk-js';

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

/** Predicate matching the exact Encryption Protocol record named by a dependency ref. */
export function matchesEncryptionProtocolDependency(
  message: GenericMessage | undefined,
  ref: Extract<DependencyRef, { type: 'EncryptionProtocol' }>,
): boolean {
  if (message === undefined || message.descriptor.interface !== DwnInterfaceName.Records) {
    return false;
  }

  const descriptor = message.descriptor as Record<string, unknown>;
  if (descriptor.protocol !== EncryptionProtocol.uri || descriptor.protocolPath !== ref.protocolPath) {
    return false;
  }

  if (ref.recipient !== undefined && descriptor.recipient !== ref.recipient) {
    return false;
  }

  const tags = descriptor.tags;
  if (!isRecordObject(tags)) {
    return ref.tags === undefined;
  }

  for (const [key, value] of Object.entries(ref.tags ?? {})) {
    if (tags[key] !== value) {
      return false;
    }
  }

  return true;
}

/** Predicate matching the exact source-protocol encryption control record named by a dependency ref. */
export function matchesEncryptionControlDependency(
  message: GenericMessage | undefined,
  ref: Extract<DependencyRef, { type: 'EncryptionControl' }>,
): boolean {
  if (message === undefined || message.descriptor.interface !== DwnInterfaceName.Records) {
    return false;
  }

  const descriptor = message.descriptor as Record<string, unknown>;
  if (descriptor.protocol !== ref.protocol || descriptor.protocolPath !== ref.protocolPath) {
    return false;
  }

  if (ref.recipient !== undefined && descriptor.recipient !== ref.recipient) {
    return false;
  }

  const tags = descriptor.tags;
  if (!isRecordObject(tags)) {
    return ref.tags === undefined;
  }

  for (const [key, value] of Object.entries(ref.tags ?? {})) {
    if (tags[key] !== value) {
      return false;
    }
  }

  return true;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
