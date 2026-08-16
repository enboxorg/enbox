import type { DependencyRef, GenericMessage, ProtocolsConfigureMessage } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, Message } from '@enbox/dwn-sdk-js';

/**
 * Helpers used by the push (`sync-messages.ts`) and pull (`sync-admit-closure.ts`)
 * dependency-closure fetch paths. These were previously duplicated verbatim in both
 * modules; keep them here so the two paths cannot drift.
 */

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
function isProtocolsConfigureMessage(message: GenericMessage): message is ProtocolsConfigureMessage {
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

/** Predicate matching the exact source-protocol encryption control record named by a dependency ref. */
export function matchesEncryptionControlDependency(
  message: GenericMessage | undefined,
  ref: Extract<DependencyRef, { type: 'EncryptionControl' }>,
): boolean {
  return matchesRecordsDependency(message, {
    protocol     : ref.protocol,
    protocolPath : ref.protocolPath,
    recipient    : ref.recipient,
    tags         : ref.tags,
  });
}

function matchesRecordsDependency(
  message: GenericMessage | undefined,
  ref: {
    protocol: string;
    protocolPath: string;
    recipient?: string;
    tags?: Record<string, string | number>;
  },
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
