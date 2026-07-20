import type { GenericMessage, GenericSignaturePayload, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { getInvokedPermissionGrantIds } from './sync-permission-grants.js';
import {
  DwnInterfaceName,
  DwnMethodName,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  EncryptionProtocol,
  getRoleAudienceContextId,
  getRoleContextPrefix,
  isCrossProtocolRef,
  Jws,
  Message,
  parseCrossProtocolRef,
  PermissionsProtocol,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

type DescriptorWithRecordId = GenericMessage['descriptor'] & {
  recordId?: string;
};

type RecordsDescriptor = GenericMessage['descriptor'] & {
  dateCreated?: string;
  parentId?: string;
  protocol?: string;
  protocolPath?: string;
  recipient?: string;
  tags?: Record<string, unknown>;
};

type ProtocolsConfigureDescriptor = GenericMessage['descriptor'] & {
  definition?: Partial<ProtocolDefinition>;
};

type SourceAudienceTags = {
  protocol: string;
  contextId: string;
  rolePath: string;
  keyId: string;
};

type MessageDependencyGraph<T> = {
  sorted: T[];
  dependencies: Map<T, T[]>;
};

type DependencyIndexes<T> = {
  byIndex: Map<number, T>;
  protocolConfigureIndex: Map<string, number>;
  protocolDefinitionsByProtocol: Map<string, Partial<ProtocolDefinition>>;
  initialWriteIndex: Map<string, number>;
  grantIndex: Map<string, number>;
  roleIndex: Map<string, number>;
  sourceAudienceIndex: Map<string, number>;
};

/**
 * Edge direction, stated once so call sites do not have to reverse-engineer
 * it from Kahn's algorithm: `addEdge(from, to)` means `from` must be admitted
 * BEFORE `to`.
 */
type DependencyEdges = {
  /** from → the dependents that must be admitted after it. */
  edges: Map<number, Set<number>>;
  /** The inverse of `edges`: to → its prerequisites. */
  dependenciesByIndex: Map<number, Set<number>>;
  /** inDegree[i] = number of unsatisfied prerequisites of entry `i`. */
  inDegree: number[];
};

type AddDependencyEdge = (from: number, to: number) => void;

function isRecordsDescriptor(descriptor: GenericMessage['descriptor']): descriptor is RecordsDescriptor {
  return descriptor.interface === DwnInterfaceName.Records;
}

function isRecordsWriteDescriptor(descriptor: GenericMessage['descriptor']): descriptor is RecordsDescriptor {
  return descriptor.interface === DwnInterfaceName.Records && descriptor.method === DwnMethodName.Write;
}

function isRecordsDeleteDescriptor(descriptor: GenericMessage['descriptor']): descriptor is DescriptorWithRecordId {
  return descriptor.interface === DwnInterfaceName.Records && descriptor.method === DwnMethodName.Delete;
}

function isProtocolsConfigureDescriptor(
  descriptor: GenericMessage['descriptor']
): descriptor is ProtocolsConfigureDescriptor {
  return descriptor.interface === DwnInterfaceName.Protocols && descriptor.method === DwnMethodName.Configure;
}

function getRecordId(message: GenericMessage): string | undefined {
  return (message as GenericMessage & { recordId?: string }).recordId;
}

function getProtocolDefinition(message: GenericMessage): Partial<ProtocolDefinition> | undefined {
  const { descriptor } = message;
  return isProtocolsConfigureDescriptor(descriptor) ? descriptor.definition : undefined;
}

function getConfiguredProtocol(message: GenericMessage): string | undefined {
  const protocol = getProtocolDefinition(message)?.protocol;
  return typeof protocol === 'string' ? protocol : undefined;
}

function getComposedProtocolDependencies(message: GenericMessage): string[] {
  const uses = getProtocolDefinition(message)?.uses;
  if (!uses) {
    return [];
  }

  return Object.values(uses).filter((protocol): protocol is string => typeof protocol === 'string');
}

/**
 * Checks whether a message is an initial RecordsWrite (not an update).
 * An initial write has dateCreated === messageTimestamp (first write for this recordId).
 */
function isInitialWrite(message: GenericMessage): boolean {
  const desc = message.descriptor;
  if (!isRecordsWriteDescriptor(desc)) {
    return false;
  }
  // A RecordsWrite is initial if dateCreated === messageTimestamp (first write for this recordId).
  return desc.dateCreated === desc.messageTimestamp;
}

function getContextId(message: GenericMessage): string | undefined {
  return (message as GenericMessage & { contextId?: string }).contextId;
}

export function getRoleKey(protocol: string, protocolPath: string, recipient: string, contextPrefix?: string): string {
  return `${protocol}|${protocolPath}|${recipient}|${contextPrefix ?? ''}`;
}

function getRoleRecordKey(message: GenericMessage): string | undefined {
  const { descriptor } = message;
  if (!isRecordsWriteDescriptor(descriptor)) {
    return undefined;
  }

  const { protocol, protocolPath, recipient } = descriptor;
  if (protocol === undefined || protocolPath === undefined || recipient === undefined) {
    return undefined;
  }

  return getRoleKey(protocol, protocolPath, recipient, getRoleContextPrefix(protocolPath, getContextId(message)));
}

function getSourceAudienceKeyFromTags(tags: SourceAudienceTags): string {
  return `${tags.protocol}|${tags.rolePath}|${tags.contextId}|${tags.keyId}`;
}

function getSourceAudienceKey(message: GenericMessage): string | undefined {
  const tags = getSourceEncryptionControlTags(message, ENCRYPTION_CONTROL_AUDIENCE_PATH);
  return tags === undefined ? undefined : getSourceAudienceKeyFromTags(tags);
}

function getSourceAudienceKeyFromDelivery(message: GenericMessage): string | undefined {
  const tags = getSourceEncryptionControlTags(message, ENCRYPTION_CONTROL_DELIVERY_PATH);
  return tags === undefined ? undefined : getSourceAudienceKeyFromTags(tags);
}

function getSourceDeliveryRoleKey(message: GenericMessage): string | undefined {
  const tags = getSourceEncryptionControlTags(message, ENCRYPTION_CONTROL_DELIVERY_PATH);
  const recipient = (message.descriptor as RecordsDescriptor).recipient;
  if (tags === undefined || recipient === undefined) {
    return undefined;
  }

  return getRoleKey(tags.protocol, tags.rolePath, recipient, tags.contextId === '' ? undefined : tags.contextId);
}

function getSourceEncryptionControlTags(
  message: GenericMessage,
  protocolPath: string,
): SourceAudienceTags | undefined {
  const { descriptor } = message;
  if (!isRecordsWriteDescriptor(descriptor) || descriptor.protocolPath !== protocolPath) {
    return undefined;
  }

  const tags = descriptor.tags;
  if (!isRecordObject(tags)) {
    return undefined;
  }

  const { protocol, contextId, rolePath, keyId } = tags;
  if (
    typeof protocol !== 'string' ||
    typeof contextId !== 'string' ||
    typeof rolePath !== 'string' ||
    typeof keyId !== 'string'
  ) {
    return undefined;
  }

  return { protocol, contextId, rolePath, keyId };
}

function getStringTag(message: GenericMessage, tag: string): string | undefined {
  const tags = (message.descriptor as RecordsDescriptor).tags;
  if (!isRecordObject(tags)) {
    return undefined;
  }

  const value = tags[tag];
  return typeof value === 'string' ? value : undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getSignaturePayload(message: GenericMessage): GenericSignaturePayload | undefined {
  if (message.authorization === undefined) {
    return undefined;
  }

  try {
    return Jws.decodePlainObjectPayload(message.authorization.signature) as GenericSignaturePayload;
  } catch {
    return undefined;
  }
}

function getInvokedRoleKey(
  message: GenericMessage,
  protocolDefinitionsByProtocol: Map<string, Partial<ProtocolDefinition>>,
): string | undefined {
  const { descriptor } = message;
  if (!isRecordsDescriptor(descriptor) || descriptor.protocol === undefined) {
    return undefined;
  }

  const baseProtocol = descriptor.protocol;
  const contextId = getContextId(message);
  const protocolRole = getSignaturePayload(message)?.protocolRole;
  const recipient = Message.getAuthor(message);
  if (typeof protocolRole !== 'string' || recipient === undefined) {
    return undefined;
  }

  let roleProtocol = baseProtocol;
  let roleProtocolPath = protocolRole;
  if (isCrossProtocolRef(protocolRole)) {
    const parsed = parseCrossProtocolRef(protocolRole);
    const referencedProtocol = parsed === undefined
      ? undefined
      : protocolDefinitionsByProtocol.get(baseProtocol)?.uses?.[parsed.alias];
    if (parsed === undefined || referencedProtocol === undefined) {
      return undefined;
    }

    roleProtocol = referencedProtocol;
    roleProtocolPath = parsed.protocolPath;
  }

  return getRoleKey(roleProtocol, roleProtocolPath, recipient, getRoleContextPrefix(roleProtocolPath, contextId));
}

function getSourceAudienceKeysFromEncryption(message: GenericMessage): string[] {
  const keyEncryption = (message as {
    encryption?: {
      keyEncryption?: Record<string, unknown>[];
    };
  }).encryption?.keyEncryption;
  if (!Array.isArray(keyEncryption)) {
    return [];
  }

  const keys: string[] = [];
  for (const entry of keyEncryption) {
    if (
      entry.derivationScheme !== ROLE_AUDIENCE_DERIVATION_SCHEME ||
      typeof entry.protocol !== 'string' ||
      typeof entry.rolePath !== 'string' ||
      typeof entry.keyId !== 'string'
    ) {
      continue;
    }

    const contextId = getRoleAudienceContextId(entry.rolePath, getContextId(message));
    if (contextId === undefined) {
      continue;
    }

    keys.push(getSourceAudienceKeyFromTags({
      protocol : entry.protocol,
      rolePath : entry.rolePath,
      contextId,
      keyId    : entry.keyId,
    }));
  }

  return keys;
}

/**
 * Builds a dependency graph from the fetched messages and returns them in
 * dependency order so that dependencies are processed before dependents.
 *
 * Dependencies — one bullet per edge kind added by
 * {@link addDependencyEdgesForMessage}; keep the two in step:
 * - ProtocolsConfigure must come before any RecordsWrite using that protocol
 * - Composed ProtocolsConfigure must come after ProtocolsConfigure messages for protocols in `uses`
 * - Parent record must come before child record (via parentId)
 * - Initial write must come before update writes (same recordId, not initial)
 * - Initial write must come before a RecordsDelete for the same recordId
 * - Permission grants must come before messages that invoke them
 * - A permission grant must come before the encryption grantKey record tagged with its grantId
 * - Source-audience and delivery-role records must come before messages whose encryption references them
 * - A role record must come before any message invoking that role
 */
export function orderMessagesForAdmission<T extends { message: GenericMessage }>(
  messages: T[]
): T[] {
  return buildMessageDependencyGraph(messages).sorted;
}

function buildMessageDependencyGraph<T extends { message: GenericMessage }>(
  messages: T[]
): MessageDependencyGraph<T> {
  if (messages.length <= 1) {
    return {
      sorted       : messages,
      dependencies : new Map(messages.map(message => [message, []])),
    };
  }

  const indexes = buildDependencyIndexes(messages);
  const dependencyEdges = buildDependencyEdges(messages, indexes);
  const sorted = sortDependencyGraph(messages, indexes.byIndex, dependencyEdges.edges, dependencyEdges.inDegree);

  return {
    sorted,
    dependencies: entriesByIndexDependencies(messages, dependencyEdges.dependenciesByIndex),
  };
}

function buildDependencyIndexes<T extends { message: GenericMessage }>(messages: T[]): DependencyIndexes<T> {
  const indexes: DependencyIndexes<T> = {
    byIndex                       : new Map(),
    protocolConfigureIndex        : new Map(),
    protocolDefinitionsByProtocol : new Map(),
    initialWriteIndex             : new Map(),
    grantIndex                    : new Map(),
    roleIndex                     : new Map(),
    sourceAudienceIndex           : new Map(),
  };

  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i];
    indexes.byIndex.set(i, entry);
    indexProtocolConfigure(entry.message, i, indexes);
    indexRecordsWrite(entry.message, i, indexes);
  }

  return indexes;
}

function indexProtocolConfigure<T>(message: GenericMessage, index: number, indexes: DependencyIndexes<T>): void {
  const protocolUrl = getConfiguredProtocol(message);
  if (protocolUrl === undefined) {
    return;
  }

  const protocolDefinition = getProtocolDefinition(message);
  indexes.protocolConfigureIndex.set(protocolUrl, index);
  if (protocolDefinition !== undefined) {
    indexes.protocolDefinitionsByProtocol.set(protocolUrl, protocolDefinition);
  }
}

function indexRecordsWrite<T>(message: GenericMessage, index: number, indexes: DependencyIndexes<T>): void {
  const desc = message.descriptor;
  if (!isRecordsWriteDescriptor(desc)) {
    return;
  }

  const recordId = getRecordId(message);
  if (recordId === undefined) {
    return;
  }

  if (isInitialWrite(message)) {
    indexes.initialWriteIndex.set(recordId, index);
  }
  if (desc.protocol === PermissionsProtocol.uri && desc.protocolPath === PermissionsProtocol.grantPath) {
    indexes.grantIndex.set(recordId, index);
  }

  const sourceAudienceKey = getSourceAudienceKey(message);
  if (sourceAudienceKey !== undefined) {
    indexes.sourceAudienceIndex.set(sourceAudienceKey, index);
  }

  const roleKey = getRoleRecordKey(message);
  if (roleKey !== undefined) {
    indexes.roleIndex.set(roleKey, index);
  }
}

function buildDependencyEdges<T extends { message: GenericMessage }>(
  messages: T[],
  indexes: DependencyIndexes<T>,
): DependencyEdges {
  const dependencyEdges: DependencyEdges = {
    edges               : new Map(),
    dependenciesByIndex : new Map(),
    inDegree            : new Array(messages.length).fill(0) as number[],
  };
  const addEdge: AddDependencyEdge = (from, to): void => {
    addDependencyEdge(dependencyEdges, from, to);
  };

  for (let i = 0; i < messages.length; i++) {
    addDependencyEdgesForMessage(i, messages[i].message, indexes, addEdge);
  }

  return dependencyEdges;
}

function addDependencyEdge(dependencyEdges: DependencyEdges, from: number, to: number): void {
  if (from === to) {
    return;
  }

  let edgeSet = dependencyEdges.edges.get(from);
  if (edgeSet === undefined) {
    edgeSet = new Set();
    dependencyEdges.edges.set(from, edgeSet);
  }
  if (edgeSet.has(to)) {
    return;
  }

  edgeSet.add(to);
  addIndexDependency(dependencyEdges, from, to);
}

function addIndexDependency(dependencyEdges: DependencyEdges, from: number, to: number): void {
  let dependencies = dependencyEdges.dependenciesByIndex.get(to);
  if (dependencies === undefined) {
    dependencies = new Set();
    dependencyEdges.dependenciesByIndex.set(to, dependencies);
  }
  dependencies.add(from);
  dependencyEdges.inDegree[to]++;
}

function addDependencyEdgesForMessage<T>(
  index: number,
  message: GenericMessage,
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  const desc = message.descriptor;
  addComposedProtocolEdges(index, message, desc, indexes, addEdge);
  addRecordProtocolEdge(index, desc, indexes, addEdge);
  addParentRecordEdge(index, desc, indexes, addEdge);
  addInitialWriteEdge(index, message, desc, indexes, addEdge);
  addDeleteEdge(index, desc, indexes, addEdge);
  addPermissionGrantEdges(index, message, indexes, addEdge);
  addEncryptionProtocolEdges(index, message, indexes, addEdge);
  addSourceAudienceEdges(index, message, indexes, addEdge);
  addRoleEdge(index, message, indexes, addEdge);
}

function addComposedProtocolEdges<T>(
  index: number,
  message: GenericMessage,
  desc: GenericMessage['descriptor'],
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  if (!isProtocolsConfigureDescriptor(desc)) {
    return;
  }

  for (const protocol of getComposedProtocolDependencies(message)) {
    const protocolIndex = indexes.protocolConfigureIndex.get(protocol);
    if (protocolIndex !== undefined) {
      addEdge(protocolIndex, index);
    }
  }
}

function addRecordProtocolEdge<T>(
  index: number,
  desc: GenericMessage['descriptor'],
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  if (!isRecordsDescriptor(desc) || desc.protocol === undefined) {
    return;
  }

  const protocolIndex = indexes.protocolConfigureIndex.get(desc.protocol);
  if (protocolIndex !== undefined) {
    addEdge(protocolIndex, index);
  }
}

function addParentRecordEdge<T>(
  index: number,
  desc: GenericMessage['descriptor'],
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  if (!isRecordsDescriptor(desc) || desc.parentId === undefined) {
    return;
  }

  const parentIndex = indexes.initialWriteIndex.get(desc.parentId);
  if (parentIndex !== undefined) {
    addEdge(parentIndex, index);
  }
}

function addInitialWriteEdge<T>(
  index: number,
  message: GenericMessage,
  desc: GenericMessage['descriptor'],
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  if (!isRecordsWriteDescriptor(desc) || isInitialWrite(message)) {
    return;
  }

  const recordId = getRecordId(message);
  const initialIndex = recordId === undefined ? undefined : indexes.initialWriteIndex.get(recordId);
  if (initialIndex !== undefined) {
    addEdge(initialIndex, index);
  }
}

function addDeleteEdge<T>(
  index: number,
  desc: GenericMessage['descriptor'],
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  if (!isRecordsDeleteDescriptor(desc) || desc.recordId === undefined) {
    return;
  }

  const initialIndex = indexes.initialWriteIndex.get(desc.recordId);
  if (initialIndex !== undefined) {
    addEdge(initialIndex, index);
  }
}

function addPermissionGrantEdges<T>(
  index: number,
  message: GenericMessage,
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  for (const permissionGrantId of getInvokedPermissionGrantIds(message)) {
    const grantIndex = indexes.grantIndex.get(permissionGrantId);
    if (grantIndex !== undefined) {
      addEdge(grantIndex, index);
    }
  }
}

function addEncryptionProtocolEdges<T>(
  index: number,
  message: GenericMessage,
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  const desc = message.descriptor;
  if (!isRecordsWriteDescriptor(desc) || desc.protocol !== EncryptionProtocol.uri) {
    return;
  }

  if (desc.protocolPath === EncryptionProtocol.grantKeyPath) {
    const grantId = getStringTag(message, 'grantId');
    const grantIndex = grantId === undefined ? undefined : indexes.grantIndex.get(grantId);
    if (grantIndex !== undefined) {
      addEdge(grantIndex, index);
    }
  }
}

function addRoleEdge<T>(
  index: number,
  message: GenericMessage,
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  const roleKey = getInvokedRoleKey(message, indexes.protocolDefinitionsByProtocol);
  const roleIndex = roleKey === undefined ? undefined : indexes.roleIndex.get(roleKey);
  if (roleIndex !== undefined) {
    addEdge(roleIndex, index);
  }
}

function addSourceAudienceEdges<T>(
  index: number,
  message: GenericMessage,
  indexes: DependencyIndexes<T>,
  addEdge: AddDependencyEdge,
): void {
  for (const audienceKey of getSourceAudienceKeysFromEncryption(message)) {
    const audienceIndex = indexes.sourceAudienceIndex.get(audienceKey);
    if (audienceIndex !== undefined) {
      addEdge(audienceIndex, index);
    }
  }

  const deliveryAudienceKey = getSourceAudienceKeyFromDelivery(message);
  const deliveryAudienceIndex = deliveryAudienceKey === undefined ? undefined : indexes.sourceAudienceIndex.get(deliveryAudienceKey);
  if (deliveryAudienceIndex !== undefined) {
    addEdge(deliveryAudienceIndex, index);
  }

  const deliveryRoleKey = getSourceDeliveryRoleKey(message);
  const deliveryRoleIndex = deliveryRoleKey === undefined ? undefined : indexes.roleIndex.get(deliveryRoleKey);
  if (deliveryRoleIndex !== undefined) {
    addEdge(deliveryRoleIndex, index);
  }
}

function sortDependencyGraph<T>(
  messages: T[],
  byIndex: Map<number, T>,
  edges: Map<number, Set<number>>,
  inDegree: number[],
): T[] {
  const queue = zeroInDegreeQueue(inDegree);
  const sorted: T[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(byIndex.get(node)!);
    decrementNeighborDegrees(node, edges, inDegree, queue);
  }

  appendCyclicEntries(messages, byIndex, sorted);
  return sorted;
}

function zeroInDegreeQueue(inDegree: number[]): number[] {
  const queue: number[] = [];
  for (let i = 0; i < inDegree.length; i++) {
    if (inDegree[i] === 0) {
      queue.push(i);
    }
  }
  return queue;
}

function decrementNeighborDegrees(
  node: number,
  edges: Map<number, Set<number>>,
  inDegree: number[],
  queue: number[],
): void {
  const neighbors = edges.get(node);
  if (neighbors === undefined) {
    return;
  }

  for (const neighbor of neighbors) {
    inDegree[neighbor]--;
    if (inDegree[neighbor] === 0) {
      queue.push(neighbor);
    }
  }
}

/**
 * Kahn's algorithm cannot drain a dependency cycle, so it stops early and
 * leaves the cyclic remainder unsorted. Rather than fail the whole batch,
 * append that remainder in feed order and let admission sort it out: the
 * DWN's Incomplete/Deferred results drive the retry passes that eventually
 * resolve them. The ordering guarantee is deliberately abandoned here.
 */
function appendCyclicEntries<T>(messages: T[], byIndex: Map<number, T>, sorted: T[]): void {
  if (sorted.length >= messages.length) {
    return;
  }

  const sortedSet = new Set(sorted);
  for (let i = 0; i < messages.length; i++) {
    const entry = byIndex.get(i)!;
    if (!sortedSet.has(entry)) {
      sorted.push(entry);
    }
  }
}

function entriesByIndexDependencies<T>(
  messages: T[],
  dependenciesByIndex: Map<number, Set<number>>,
): Map<T, T[]> {
  const dependencies = new Map<T, T[]>();
  for (let i = 0; i < messages.length; i++) {
    const indexDependencies = dependenciesByIndex.get(i) ?? new Set();
    dependencies.set(messages[i], [...indexDependencies].map(index => messages[index]));
  }
  return dependencies;
}
