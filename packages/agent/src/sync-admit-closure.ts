import type {
  DependencyRef,
  GenericMessage,
  ProtocolsConfigureMessage,
  ProtocolsQueryReply,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsWriteMessage,
  ReplicationApplyResult,
} from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncScope } from './types/sync.js';

import { classifySyncMessageScope } from './sync-scope-acceptance.js';
import { DwnInterface } from './types/dwn.js';
import { KeyDeliveryProtocolDefinition } from './store-data-protocols.js';
import { topologicalSort } from './sync-topological-sort.js';
import { DwnInterfaceName, DwnMethodName, Encoder, Message, RecordsWrite } from '@enbox/dwn-sdk-js';
import { fetchRemoteMessages, getMessageCid, SyncPullAbortedError } from './sync-messages.js';

export type AdmitOutcome =
  | { kind: 'admitted'; appliedCids: string[] }
  | { kind: 'deferred'; rootCid: string; detail?: string }
  | { kind: 'failed'; rootCid: string; reason: 'invalid' | 'terminal'; detail?: string };

export type AdmitClosureDeps = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  scope?: SyncScope;
  agent: EnboxPlatformAgent;
  permissionsApi?: PermissionsApi;
  prefetched?: SyncMessageEntry[];
  shouldContinue?: () => boolean;
};

type AdmissionPassResult =
  | { kind: 'continue'; appliedCids: string[]; retry: SyncMessageEntry[] }
  | { kind: 'done'; outcome: AdmitOutcome };

type AdmissionEntryResult =
  | { kind: 'applied'; cid: string }
  | { kind: 'retry'; entries: SyncMessageEntry[] }
  | { kind: 'done'; outcome: AdmitOutcome };

// Replication handlers currently report one missing dependency per rejected apply.
// Keep a high safety cap so deep but valid closures can converge while still
// bounding work against malformed or adversarial remotes.
const MAX_ADMISSION_PASSES = 128;

/**
 * Applies a sync root and any dependencies it discovers through the DWN's
 * structured replication result. The DWN decides whether a message is applied,
 * duplicate, superseded, incomplete, invalid, or deferred; this module only
 * fetches missing dependencies and retries in dependency order.
 */
export async function admitClosure(rootCid: string, deps: AdmitClosureDeps): Promise<AdmitOutcome> {
  const context = new AdmitClosureContext(deps);
  return context.admit(rootCid);
}

class AdmitClosureContext {
  private readonly entriesByCid = new Map<string, SyncMessageEntry>();
  private readonly fetchedDependencyEntries = new Map<string, SyncMessageEntry[]>();
  private readonly fetchedRefs = new Set<string>();
  private readonly prefetchedEntries: SyncMessageEntry[];

  public constructor(private readonly deps: AdmitClosureDeps) {
    this.prefetchedEntries = deps.prefetched ?? [];
  }

  public async admit(rootCid: string): Promise<AdmitOutcome> {
    await this.rememberEntries(this.prefetchedEntries);
    let pending = await this.initialPending(rootCid);
    const appliedCids: string[] = [];
    if (pending.length === 0) {
      return { kind: 'deferred', rootCid, detail: 'root message not available' };
    }

    for (let pass = 0; pass < MAX_ADMISSION_PASSES && pending.length > 0; pass++) {
      this.assertShouldContinue();
      const passResult = await this.admitPass(rootCid, pending);
      if (passResult.kind === 'done') {
        return passResult.outcome;
      }

      appliedCids.push(...passResult.appliedCids);
      pending = await dedupeEntries(passResult.retry);
    }

    return pending.length === 0
      ? { kind: 'admitted', appliedCids }
      : { kind: 'deferred', rootCid, detail: 'dependency admission pass budget exhausted' };
  }

  private async admitPass(rootCid: string, pending: SyncMessageEntry[]): Promise<AdmissionPassResult> {
    const retry: SyncMessageEntry[] = [];
    const appliedCids: string[] = [];

    for (const entry of topologicalSort(pending)) {
      this.assertShouldContinue();
      const result = await this.admitEntry(rootCid, entry);
      switch (result.kind) {
        case 'applied':
          appliedCids.push(result.cid);
          break;
        case 'retry':
          retry.push(...result.entries);
          break;
        case 'done':
          return { kind: 'done', outcome: result.outcome };
      }
    }

    return { kind: 'continue', appliedCids, retry };
  }

  private async admitEntry(rootCid: string, entry: SyncMessageEntry): Promise<AdmissionEntryResult> {
    const cid = await this.rememberEntry(entry);
    if (cid === rootCid && !await this.rootIsInScope(entry)) {
      return {
        kind    : 'done',
        outcome : { kind: 'failed', rootCid, reason: 'terminal', detail: 'root message is outside the sync scope' },
      };
    }

    return this.admissionResultFromApply(rootCid, entry, cid, await this.applyEntry(entry));
  }

  private async admissionResultFromApply(
    rootCid: string,
    entry: SyncMessageEntry,
    cid: string,
    result: ReplicationApplyResult,
  ): Promise<AdmissionEntryResult> {
    switch (result.kind) {
      case 'Applied':
      case 'Duplicate':
      case 'Superseded':
        return { kind: 'applied', cid };
      case 'Deferred':
        return { kind: 'done', outcome: { kind: 'deferred', rootCid, detail: result.reason } };
      case 'Invalid':
        return { kind: 'done', outcome: { kind: 'failed', rootCid, reason: 'invalid', detail: result.reason } };
      case 'Incomplete':
        return this.admissionResultFromMissingDependencies(rootCid, entry, result.missing);
    }
  }

  private async admissionResultFromMissingDependencies(
    rootCid: string,
    entry: SyncMessageEntry,
    missing: DependencyRef[],
  ): Promise<AdmissionEntryResult> {
    if (hasTerminalDependency(missing)) {
      return {
        kind    : 'done',
        outcome : { kind: 'failed', rootCid, reason: 'terminal', detail: missingDependencyDetail(missing) },
      };
    }

    const dependencies = await this.fetchMissingDependencies(missing);
    if (dependencies.length === 0) {
      return { kind: 'done', outcome: { kind: 'deferred', rootCid, detail: missingDependencyDetail(missing) } };
    }

    return { kind: 'retry', entries: [...dependencies, entry] };
  }

  private async initialPending(rootCid: string): Promise<SyncMessageEntry[]> {
    const existing = this.entriesByCid.get(rootCid);
    if (existing !== undefined) {
      return [existing];
    }

    const fetched = await fetchRemoteMessages({
      did                : this.deps.did,
      dwnUrl             : this.deps.dwnUrl,
      delegateDid        : this.deps.delegateDid,
      permissionGrantIds : this.deps.permissionGrantIds,
      messageCids        : [rootCid],
      agent              : this.deps.agent,
    });
    return fetched;
  }

  private async rootIsInScope(entry: SyncMessageEntry): Promise<boolean> {
    const { scope } = this.deps;
    if (scope === undefined || scope.kind === 'full') {
      return true;
    }

    const classification = classifySyncMessageScope({
      message      : entry.message,
      initialWrite : await this.getInitialWriteForDelete(entry.message),
      scope,
    });
    return classification === 'in-scope';
  }

  private async getInitialWriteForDelete(message: GenericMessage): Promise<RecordsWriteMessage | undefined> {
    if (
      message.descriptor.interface !== DwnInterfaceName.Records ||
      message.descriptor.method !== DwnMethodName.Delete
    ) {
      return undefined;
    }

    const recordId = (message.descriptor as { recordId?: unknown }).recordId;
    if (typeof recordId !== 'string') {
      return undefined;
    }

    for (const entry of this.entriesByCid.values()) {
      if (isInitialWriteForRecord(entry.message, recordId)) {
        return entry.message;
      }
    }

    if (this.deps.agent.dwn.isRemoteMode) {
      return undefined;
    }

    const messageStore = this.deps.agent.dwn.node?.storage?.messageStore;
    if (messageStore === undefined) {
      return undefined;
    }

    return RecordsWrite.fetchInitialRecordsWriteMessage(
      messageStore,
      this.deps.did,
      recordId,
    );
  }

  private async applyEntry(entry: SyncMessageEntry): Promise<ReplicationApplyResult> {
    return this.deps.agent.dwn.applyReplicatedMessage(this.deps.did, entry.message, {
      dataStream: await replayableDataStream(entry),
    });
  }

  private async fetchMissingDependencies(refs: DependencyRef[]): Promise<SyncMessageEntry[]> {
    const fetched: SyncMessageEntry[] = [];
    for (const ref of refs) {
      const key = dependencyKey(ref);
      if (this.fetchedRefs.has(key)) {
        fetched.push(...(this.fetchedDependencyEntries.get(key) ?? []));
        continue;
      }
      this.fetchedRefs.add(key);
      const entries = await this.fetchDependency(ref);
      this.fetchedDependencyEntries.set(key, entries);
      fetched.push(...entries);
    }
    return fetched;
  }

  private async fetchDependency(ref: DependencyRef): Promise<SyncMessageEntry[]> {
    if (ref.messageCid !== undefined) {
      return this.fetchMessageCids([ref.messageCid]);
    }

    switch (ref.type) {
      case 'Protocol':
        return this.fetchProtocolConfig(ref.protocol);
      case 'Parent':
      case 'Ancestor':
      case 'InitialWrite':
        return this.fetchInitialWriteDependency(ref);
      case 'CrossProtocolRef':
        return this.fetchRecordsByRecordId(ref.recordId, ref.protocol);
      case 'Role':
        return this.fetchRoleRecord(ref);
      case 'Grant':
        return this.fetchGrantRecord(ref.permissionGrantId);
      case 'KeyDelivery':
        return this.fetchKeyDeliveryRecord(ref);
      case 'RecordData':
        return this.fetchRecordData(ref);
      default:
        return [];
    }
  }

  private async fetchMessageCids(messageCids: string[]): Promise<SyncMessageEntry[]> {
    const entries = await fetchRemoteMessages({
      did                : this.deps.did,
      dwnUrl             : this.deps.dwnUrl,
      delegateDid        : this.deps.delegateDid,
      permissionGrantIds : this.deps.permissionGrantIds,
      messageCids,
      agent              : this.deps.agent,
    });
    await this.rememberEntries(entries);
    return entries;
  }

  private async fetchInitialWriteDependency(
    ref: Extract<DependencyRef, { type: 'Parent' | 'Ancestor' | 'InitialWrite' }>,
  ): Promise<SyncMessageEntry[]> {
    const existing = this.findInitialWriteEntry(ref.recordId);
    if (existing !== undefined) {
      return [existing];
    }

    return this.fetchRecordsByRecordId(ref.recordId, ref.protocol);
  }

  private async fetchGrantRecord(permissionGrantId: string): Promise<SyncMessageEntry[]> {
    return this.fetchRecordsByRecordId(permissionGrantId);
  }

  private async fetchRecordsByRecordId(recordId: string, protocol?: string): Promise<SyncMessageEntry[]> {
    const permissionGrantId = protocol === undefined
      ? undefined
      : await this.getPermissionGrantId(DwnInterface.RecordsQuery, protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { message } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { recordId, ...(protocol === undefined ? {} : { protocol }) },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsQuery,
      store       : false,
      target      : this.deps.did,
    });

    const reply = await this.deps.agent.rpc.sendDwnRequest({
      dwnUrl    : this.deps.dwnUrl,
      message,
      targetDid : this.deps.did,
    }) as RecordsQueryReply;
    return this.entriesFromRecordsQueryReply(reply);
  }

  private async fetchRoleRecord(ref: Extract<DependencyRef, { type: 'Role' }>): Promise<SyncMessageEntry[]> {
    const permissionGrantId = await this.getPermissionGrantId(DwnInterface.RecordsQuery, ref.protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { message } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: {
          protocol     : ref.protocol,
          protocolPath : ref.protocolPath,
          recipient    : ref.recipient,
          ...(ref.contextPrefix === undefined ? {} : { contextId: ref.contextPrefix }),
        },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsQuery,
      store       : false,
      target      : this.deps.did,
    });

    const reply = await this.deps.agent.rpc.sendDwnRequest({
      dwnUrl    : this.deps.dwnUrl,
      message,
      targetDid : this.deps.did,
    }) as RecordsQueryReply;
    return this.entriesFromRecordsQueryReply(reply);
  }

  private async fetchKeyDeliveryRecord(ref: Extract<DependencyRef, { type: 'KeyDelivery' }>): Promise<SyncMessageEntry[]> {
    const { message } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          tags         : {
            protocol  : ref.protocol,
            contextId : ref.contextId,
          },
        },
      },
      messageType : DwnInterface.RecordsQuery,
      store       : false,
      target      : this.deps.did,
    });

    const reply = await this.deps.agent.rpc.sendDwnRequest({
      dwnUrl    : this.deps.dwnUrl,
      message,
      targetDid : this.deps.did,
    }) as RecordsQueryReply;
    return this.entriesFromRecordsQueryReply(reply);
  }

  private async entriesFromRecordsQueryReply(reply: RecordsQueryReply): Promise<SyncMessageEntry[]> {
    if (reply.status.code !== 200 || reply.entries === undefined) {
      return [];
    }

    const entries = reply.entries.flatMap((entry): SyncMessageEntry[] => {
      const { encodedData, initialWrite, ...message } = entry;
      const syncEntries: SyncMessageEntry[] = [];
      if (initialWrite !== undefined) {
        syncEntries.push({ message: initialWrite });
      }

      const syncEntry: SyncMessageEntry = { message };
      if (encodedData !== undefined) {
        syncEntry.bufferedData = Encoder.base64UrlToBytes(encodedData);
      }
      syncEntries.push(syncEntry);
      return syncEntries;
    });
    const dedupedEntries = await dedupeEntries(entries);
    await this.rememberEntries(dedupedEntries);
    return dedupedEntries;
  }

  private async fetchRecordData(ref: Extract<DependencyRef, { type: 'RecordData' }>): Promise<SyncMessageEntry[]> {
    const permissionGrantId = ref.protocol === undefined
      ? undefined
      : await this.getPermissionGrantId(DwnInterface.RecordsRead, ref.protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { message } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { recordId: ref.recordId },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsRead,
      store       : false,
      target      : this.deps.did,
    });

    const reply = await this.deps.agent.rpc.sendDwnRequest({
      dwnUrl    : this.deps.dwnUrl,
      message,
      targetDid : this.deps.did,
    }) as RecordsReadReply;
    if (reply.status.code !== 200 || reply.entry?.recordsWrite === undefined || reply.entry.data === undefined) {
      return [];
    }

    const recordsWrite = reply.entry.recordsWrite;
    if (recordsWrite.descriptor.dataCid !== ref.dataCid) {
      return [];
    }

    const entry = { message: recordsWrite, dataStream: reply.entry.data };
    await this.rememberEntry(entry);
    return [entry];
  }

  private async fetchProtocolConfig(protocol: string): Promise<SyncMessageEntry[]> {
    const config = await this.fetchProtocol(protocol);
    const entries = config === undefined ? [] : [{ message: config }];
    await this.rememberEntries(entries);
    return entries;
  }

  private async fetchProtocol(protocol: string): Promise<ProtocolsConfigureMessage | undefined> {
    const permissionGrantId = await this.getPermissionGrantId(DwnInterface.ProtocolsQuery, protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { message } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { protocol },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.ProtocolsQuery,
      store       : false,
      target      : this.deps.did,
    });

    const reply = await this.deps.agent.rpc.sendDwnRequest({
      dwnUrl    : this.deps.dwnUrl,
      message,
      targetDid : this.deps.did,
    }) as ProtocolsQueryReply;
    if (reply.status.code !== 200 || reply.entries === undefined) {
      return undefined;
    }

    const configs = reply.entries.filter(isTenantProtocolConfig(this.deps.did, protocol));
    return newestProtocolConfig(configs);
  }

  private async getPermissionGrantId(messageType: DwnInterface, protocol: string): Promise<string | undefined> {
    if (this.deps.delegateDid === undefined || this.deps.permissionsApi === undefined) {
      return undefined;
    }

    try {
      const { grant } = await this.deps.permissionsApi.getPermissionForRequest({
        connectedDid : this.deps.did,
        delegateDid  : this.deps.delegateDid,
        protocol,
        cached       : true,
        messageType,
      });
      return grant.id;
    } catch {
      return undefined;
    }
  }

  private async rememberEntries(entries: SyncMessageEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.rememberEntry(entry);
    }
  }

  private async rememberEntry(entry: SyncMessageEntry): Promise<string> {
    const cid = await Message.getCid(entry.message);
    this.entriesByCid.set(cid, entry);
    return cid;
  }

  private assertShouldContinue(): void {
    if (this.deps.shouldContinue?.() === false) {
      throw new SyncPullAbortedError();
    }
  }

  private findInitialWriteEntry(recordId: string): SyncMessageEntry | undefined {
    for (const entry of this.entriesByCid.values()) {
      if (isInitialWriteForRecord(entry.message, recordId)) {
        return entry;
      }
    }
  }
}

function hasTerminalDependency(refs: DependencyRef[]): boolean {
  return refs.some(ref => ref.terminal === true);
}

function missingDependencyDetail(refs: DependencyRef[]): string {
  return refs.map(dependencyKey).join(', ');
}

function dependencyKey(ref: DependencyRef): string {
  return JSON.stringify(ref);
}

async function replayableDataStream(entry: SyncMessageEntry): Promise<ReadableStream<Uint8Array> | undefined> {
  if (entry.bufferedData === undefined) {
    return entry.dataStreamFactory === undefined ? entry.dataStream : entry.dataStreamFactory();
  }

  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(entry.bufferedData);
      controller.close();
    }
  });
}

async function dedupeEntries(entries: SyncMessageEntry[]): Promise<SyncMessageEntry[]> {
  const byCid = new Map<string, SyncMessageEntry>();
  for (const entry of entries) {
    byCid.set(await getMessageCid(entry.message), entry);
  }
  return [...byCid.values()];
}

function isTenantProtocolConfig(tenantDid: string, protocol: string): (message: GenericMessage) => message is ProtocolsConfigureMessage {
  return (message: GenericMessage): message is ProtocolsConfigureMessage => {
    if (
      message.descriptor.interface !== DwnInterfaceName.Protocols ||
      message.descriptor.method !== DwnMethodName.Configure
    ) {
      return false;
    }

    const definition = (message.descriptor as { definition?: { protocol?: string } }).definition;
    return definition?.protocol === protocol && Message.getAuthor(message) === tenantDid;
  };
}

function newestProtocolConfig(configs: ProtocolsConfigureMessage[]): ProtocolsConfigureMessage | undefined {
  let newest: ProtocolsConfigureMessage | undefined;
  for (const config of configs) {
    if (newest === undefined || config.descriptor.messageTimestamp > newest.descriptor.messageTimestamp) {
      newest = config;
    }
  }
  return newest;
}

function isInitialWriteForRecord(message: GenericMessage, recordId: string): message is RecordsWriteMessage {
  if (
    message.descriptor.interface !== DwnInterfaceName.Records ||
    message.descriptor.method !== DwnMethodName.Write
  ) {
    return false;
  }

  const recordsWrite = message as RecordsWriteMessage;
  return recordsWrite.recordId === recordId &&
    recordsWrite.descriptor.dateCreated === recordsWrite.descriptor.messageTimestamp;
}
