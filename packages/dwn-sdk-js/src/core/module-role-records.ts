import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ResolvedRoleReference } from './module-graph.js';

export type RoleRecordIdentity = {
  contextIdPrefix: string | undefined;
  key: string;
  module: string;
  modulePath: string;
  recipient: string;
};

/** Root roles have no context; nested roles use their resolved physical parent's context. */
export function getRoleAudienceContextId(
  role: Pick<ResolvedRoleReference, 'parentPhysicalDepth'>,
  contextId?: string,
): string | undefined {
  if (role.parentPhysicalDepth === 0) {
    return '';
  }
  const segments = contextId?.split('/');
  if (segments === undefined || segments.length < role.parentPhysicalDepth || segments.includes('')) {
    return undefined;
  }
  return segments.slice(0, role.parentPhysicalDepth).join('/');
}

export function getRoleContextPrefix(
  role: Pick<ResolvedRoleReference, 'parentPhysicalDepth'>,
  contextId?: string,
): string | undefined {
  const context = getRoleAudienceContextId(role, contextId);
  return context === '' ? undefined : context;
}

/** Creates a canonical identity from an already resolved role and its current context. */
export function getRoleRecordIdentity(input: {
  role: Pick<ResolvedRoleReference, 'owningModuleUri' | 'owningModulePath' | 'parentPhysicalDepth'>;
  contextId?: string;
  recipient: string;
}): RoleRecordIdentity {
  const { role, contextId, recipient } = input;
  return identity(role.owningModuleUri, role.owningModulePath, recipient, getRoleContextPrefix(role, contextId));
}

/** A role record carries its direct parent in its context ID, independent of declared path depth. */
export function getRecordsWriteRoleIdentity(message: RecordsWriteMessage): RoleRecordIdentity | undefined {
  const { module, modulePath, recipient } = message.descriptor;
  if (module === undefined || modulePath === undefined || recipient === undefined || message.contextId === undefined) {
    return undefined;
  }
  const separator = message.contextId.lastIndexOf('/');
  const parentContext = separator === -1 ? undefined : message.contextId.slice(0, separator);
  return identity(module, modulePath, recipient, parentContext);
}

function identity(module: string, modulePath: string, recipient: string, contextIdPrefix: string | undefined): RoleRecordIdentity {
  return {
    contextIdPrefix,
    key: JSON.stringify([module, modulePath, recipient, contextIdPrefix]),
    module,
    modulePath,
    recipient,
  };
}
