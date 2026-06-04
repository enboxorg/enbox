import type { GenericMessage, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { getInvokedPermissionGrantIds } from './sync-permission-grants.js';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol } from '@enbox/dwn-sdk-js';

type DescriptorWithRecordId = GenericMessage['descriptor'] & {
  recordId?: string;
};

type RecordsDescriptor = GenericMessage['descriptor'] & {
  dateCreated?: string;
  parentId?: string;
  protocol?: string;
  protocolPath?: string;
};

type ProtocolsConfigureDescriptor = GenericMessage['descriptor'] & {
  definition?: Partial<ProtocolDefinition>;
};

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

/**
 * Builds a dependency graph from the fetched messages and returns them in
 * topological order so that dependencies are processed before dependents.
 *
 * Dependencies:
 * - ProtocolsConfigure must come before any RecordsWrite using that protocol
 * - Composed ProtocolsConfigure must come after ProtocolsConfigure messages for protocols in `uses`
 * - Parent record must come before child record (via parentId)
 * - Initial write must come before update writes (same recordId, not initial)
 * - Permission grants must come before messages that invoke them
 */
export function topologicalSort<T extends { message: GenericMessage }>(
  messages: T[]
): T[] {
  if (messages.length <= 1) {
    return messages;
  }

  // Index messages by various keys for dependency resolution.
  const byIndex = new Map<number, T>();
  const protocolConfigureIndex = new Map<string, number>(); // protocol URL -> index
  const initialWriteIndex = new Map<string, number>(); // recordId -> index of initial write
  const grantIndex = new Map<string, number>(); // grant recordId -> index

  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i];
    byIndex.set(i, entry);
    const desc = entry.message.descriptor;

    if (desc.interface === DwnInterfaceName.Protocols && desc.method === DwnMethodName.Configure) {
      const protocolUrl = getConfiguredProtocol(entry.message);
      if (protocolUrl) {
        protocolConfigureIndex.set(protocolUrl, i);
      }
    }

    if (isRecordsWriteDescriptor(desc)) {
      const recordId = getRecordId(entry.message);
      const initial = isInitialWrite(entry.message);
      if (initial && recordId) {
        initialWriteIndex.set(recordId, i);
      }

      // Index permission grants by recordId so dependents can reference them.
      if (
        desc.protocol === PermissionsProtocol.uri &&
        desc.protocolPath === PermissionsProtocol.grantPath &&
        recordId
      ) {
        grantIndex.set(recordId, i);
      }
    }
  }

  // Build adjacency list (edges: dependency -> dependent).
  const edges = new Map<number, Set<number>>();
  const inDegree = new Array(messages.length).fill(0) as number[];

  const addEdge = (from: number, to: number): void => {
    if (from === to) {
      return;
    }
    if (!edges.has(from)) {
      edges.set(from, new Set());
    }
    const edgeSet = edges.get(from)!;
    if (!edgeSet.has(to)) {
      edgeSet.add(to);
      inDegree[to]++;
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const desc = messages[i].message.descriptor;

    // Composition dependency: a composed protocol depends on its referenced protocol definitions.
    if (isProtocolsConfigureDescriptor(desc)) {
      for (const protocol of getComposedProtocolDependencies(messages[i].message)) {
        if (protocolConfigureIndex.has(protocol)) {
          addEdge(protocolConfigureIndex.get(protocol)!, i);
        }
      }
    }

    // Protocol dependency: RecordsWrite depends on ProtocolsConfigure for its protocol.
    if (isRecordsDescriptor(desc)) {
      const protocol = desc.protocol;
      if (protocol && protocolConfigureIndex.has(protocol)) {
        addEdge(protocolConfigureIndex.get(protocol)!, i);
      }
    }

    // Parent dependency: child record depends on parent record.
    if (isRecordsDescriptor(desc) && desc.parentId) {
      const parentId = desc.parentId;
      if (initialWriteIndex.has(parentId)) {
        addEdge(initialWriteIndex.get(parentId)!, i);
      }
    }

    // Initial write dependency: update depends on initial write.
    if (isRecordsWriteDescriptor(desc)) {
      const recordId = getRecordId(messages[i].message);
      if (recordId && !isInitialWrite(messages[i].message) && initialWriteIndex.has(recordId)) {
        addEdge(initialWriteIndex.get(recordId)!, i);
      }
    }

    // Delete depends on initial write.
    if (isRecordsDeleteDescriptor(desc)) {
      const recordId = desc.recordId;
      if (recordId && initialWriteIndex.has(recordId)) {
        addEdge(initialWriteIndex.get(recordId)!, i);
      }
    }

    // Permission grant dependency: message depends on each grant it references.
    for (const permissionGrantId of getInvokedPermissionGrantIds(messages[i].message)) {
      if (grantIndex.has(permissionGrantId)) {
        addEdge(grantIndex.get(permissionGrantId)!, i);
      }
    }
  }

  // Kahn's algorithm for topological sort.
  const queue: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (inDegree[i] === 0) {
      queue.push(i);
    }
  }

  const sorted: T[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(byIndex.get(node)!);

    const neighbors = edges.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
    }
  }

  // If there are nodes not in sorted (cycle), append them at the end.
  if (sorted.length < messages.length) {
    const sortedSet = new Set(sorted);
    for (let i = 0; i < messages.length; i++) {
      const entry = byIndex.get(i)!;
      if (!sortedSet.has(entry)) {
        sorted.push(entry);
      }
    }
  }

  return sorted;
}
