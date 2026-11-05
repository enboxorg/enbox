import type { GenericMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, EncryptionModule, PermissionsModule } from '@enbox/dwn-sdk-js';

import type { SyncScope } from './types/sync.js';

/** Result of testing whether an inbound sync message belongs to a link scope. */
export type SyncScopeClassification = 'in-scope' | 'out-of-scope' | 'unknown';

type SyncMessageScopeClassificationParams = {
  message: GenericMessage;
  initialWrite?: RecordsWriteMessage;
  scope: SyncScope;
};

type ModuleSetSyncScope = Extract<SyncScope, { kind: 'moduleSet' }>;
type ContextSyncScope = Extract<SyncScope, { kind: 'context' }>;

/**
 * Classifies whether a DWN message belongs to a sync scope before local apply.
 *
 * If a RecordsDelete cannot be tied to its initial write, the result is
 * `unknown` so callers fail closed instead of applying an unclassified delete.
 */
export function classifySyncMessageScope({
  message,
  initialWrite,
  scope,
}: SyncMessageScopeClassificationParams): SyncScopeClassification {
  if (scope.kind === 'full') { return 'in-scope'; }
  if (scope.kind === 'context') { return classifyContextScope(message, initialWrite, scope); }
  return classifyModuleSetScope(message, initialWrite, scope);
}

function classifyContextScope(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
  scope: ContextSyncScope,
): SyncScopeClassification {
  const isDelete = message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Delete;
  let recordsWrite: RecordsWriteMessage | undefined;
  if (isDelete) {
    recordsWrite = initialWrite;
  } else if (
    message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write
  ) {
    recordsWrite = message as RecordsWriteMessage;
  }
  if (recordsWrite === undefined) {
    return isDelete ? 'unknown' : 'out-of-scope';
  }

  const contextId = recordsWrite.contextId;
  return recordsWrite.descriptor.module === scope.module &&
    typeof recordsWrite.descriptor.modulePath === 'string' &&
    scope.modulePaths.includes(recordsWrite.descriptor.modulePath) &&
    typeof contextId === 'string' &&
    (contextId === scope.contextId || contextId.startsWith(`${scope.contextId}/`))
    ? 'in-scope'
    : 'out-of-scope';
}

function classifyModuleSetScope(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
  scope: ModuleSetSyncScope,
): SyncScopeClassification {
  const descriptor = message.descriptor as Record<string, unknown>;
  const scopedDescriptor = getScopedMessageDescriptor(message, initialWrite);
  if (scopedDescriptor === undefined) {
    return 'unknown';
  }

  const taggedCoreRecordClassification = classifyTaggedCoreModuleRecord(scopedDescriptor, scope.modules);
  if (taggedCoreRecordClassification !== undefined) { return taggedCoreRecordClassification; }

  const moduleClassification = classifyModuleField(scopedDescriptor.module, scope.modules);
  if (moduleClassification !== undefined) { return moduleClassification; }

  return classifyModulesConfigureDescriptor(descriptor, scope.modules);
}

function classifyTaggedCoreModuleRecord(
  descriptor: Record<string, unknown>,
  modules: readonly string[],
): SyncScopeClassification | undefined {
  if (
    (descriptor.module !== PermissionsModule.uri && descriptor.module !== EncryptionModule.uri) ||
    !isRecordObject(descriptor.tags)
  ) {
    return undefined;
  }

  const taggedModule = descriptor.tags.module;
  return typeof taggedModule === 'string' && modules.includes(taggedModule)
    ? 'in-scope'
    : 'out-of-scope';
}

function classifyModuleField(module: unknown, modules: readonly string[]): SyncScopeClassification | undefined {
  if (typeof module !== 'string') {
    return undefined;
  }

  return modules.includes(module) ? 'in-scope' : 'out-of-scope';
}

function classifyModulesConfigureDescriptor(
  descriptor: Record<string, unknown>,
  modules: readonly string[],
): SyncScopeClassification {
  if (
    descriptor.interface === DwnInterfaceName.Modules &&
    descriptor.method === DwnMethodName.Configure &&
    isRecordObject(descriptor.definition)
  ) {
    const definitionModule = descriptor.definition.module;
    return typeof definitionModule === 'string' && modules.includes(definitionModule)
      ? 'in-scope'
      : 'out-of-scope';
  }

  return 'out-of-scope';
}

function getScopedMessageDescriptor(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
): Record<string, unknown> | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  if (
    descriptor.interface === DwnInterfaceName.Records &&
    descriptor.method === DwnMethodName.Delete
  ) {
    return initialWrite?.descriptor as Record<string, unknown> | undefined;
  }

  return descriptor;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
