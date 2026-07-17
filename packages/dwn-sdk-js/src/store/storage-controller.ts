import type { DataStore } from '../types/data-store.js';
import type { GenericMessage } from '../types/message-types.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { Filter, KeyValues } from '../types/query-types.js';
import type { MessageStore, MessageStorePutResult } from '../types/message-store.js';
import type { RecordsDeleteMessage, RecordsWriteMessage } from '../types/records-types.js';

import { DwnConstant } from '../core/dwn-constant.js';
import { FilterUtility } from '../utils/filter.js';
import { Message } from '../core/message.js';
import { Records } from '../utils/records.js';
import { RecordsDelete } from '../interfaces/records-delete.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';


export type ResumableRecordsDeleteData = {
  tenant: string;
  message: RecordsDeleteMessage;
};

export type ResumableRecordsSquashData = {
  tenant: string;
  message: RecordsWriteMessage;
};

export type RecordsDeleteTaskResult = {
  position?: ProgressToken;
};

/**
 * A class that provides an abstraction for coordinated MessageStore and DataStore mutations.
 */
export class StorageController {

  private readonly messageStore: MessageStore;
  private readonly dataStore: DataStore;

  public constructor({ messageStore, dataStore }: {
    messageStore : MessageStore,
    dataStore : DataStore,
  }
  ) {
    this.messageStore = messageStore;
    this.dataStore = dataStore;
  }

  public async performRecordsDelete({ tenant, message }: ResumableRecordsDeleteData): Promise<RecordsDeleteTaskResult> {
    // get existing records matching the `recordId`
    const query = {
      interface : DwnInterfaceName.Records,
      recordId  : message.descriptor.recordId
    };
    const { messages: existingMessages } = await this.messageStore.query(tenant, [ query ]);

    // find which message is the newest, and if the incoming message is the newest
    const newestExistingMessage = await Message.getNewestMessage(existingMessages);

    if (newestExistingMessage === undefined) {
      return {};
    }

    // Same tombstone-lattice gate as the RecordsDelete handler: state can advance between
    // acceptance and task replay, and a beaten delete accepted earlier must not displace the
    // tombstone that has since become the record's canonical winner.
    if (await Records.isDeleteBeatenByExistingTombstone(message, newestExistingMessage)) {
      return {};
    }

    // NOTE: code above is duplicated from `RecordsDeleteHandler` and is already performed if this was invoked by the `RecordsDeleteHandler`,
    // But we repeat the logic for the code path when the ResumableTaskManager resumes the task.
    // We make the two different code paths to share this same method to reduce code duplication, there might be a better way to refactor this.

    const recordsDelete = await RecordsDelete.parse(message);
    const initialWrite = await RecordsWrite.getInitialWrite(existingMessages);
    const newestPreDeleteWrite = await Records.getNewestRecordsWrite(existingMessages) ?? initialWrite;

    // Tombstone mutable query-visibility facts (`tag.*`, `published`, `datePublished`) come from
    // the newest retained RecordsWrite. This remains true when replacing an existing tombstone:
    // tombstones carry no visibility facts in their descriptors, so the retained write is the
    // durable source of truth for later prune/replay/replication index reconstruction.
    const indexes = recordsDelete.constructIndexes(initialWrite, newestPreDeleteWrite);

    // store the tombstone and displace every other message for this record in one atomic commit,
    // retaining the writes needed for replay and future tombstone visibility
    const { position } = await StorageController.commitLatestStateTransition(
      tenant, existingMessages, { message, indexes }, [newestPreDeleteWrite], this.messageStore, this.dataStore
    );

    if (message.descriptor.prune) {
      // purge/hard-delete all descendant records. Cascade is intentionally protocol-agnostic:
      // `parentContextId` is a structural link, and a prune removes the whole subtree regardless
      // of which protocol a descendant lives in. Cross-protocol composing children (linked via
      // `$ref`/`uses`) participate in the cascade. See issue #298 for the design discussion.
      await StorageController.purgeRecordDescendants(
        tenant, message.descriptor.recordId, this.messageStore, this.dataStore
      );
    }

    return { position };
  }

  /**
   * Performs the squash processing for a `RecordsWrite` with `squash: true`.
   * Deletes all sibling records at the same protocol path and parent context whose
   * `messageTimestamp` is strictly older than the squash record's `messageTimestamp`.
   * Unlike normal `RecordsDelete` tombstones, squash targets are fully purged — no initial writes
   * are retained.
   *
   * This method is idempotent — it can be safely re-run on resume after a crash.
   */
  public async performRecordsSquash({ tenant, message }: ResumableRecordsSquashData): Promise<void> {
    const { protocol, protocolPath, messageTimestamp } = message.descriptor;

    // Build a filter to find all sibling records at the same protocol path and parent context.
    // We query by interface only (not method) so that both RecordsWrite and RecordsDelete messages are found.
    const filter: Filter = {
      interface    : DwnInterfaceName.Records,
      protocol,
      protocolPath : protocolPath,
    };

    // Scope by parent context for nested records
    const parentContextId = Records.getParentContextFromOfContextId(message.contextId);
    if (parentContextId !== undefined && parentContextId !== '') {
      const prefixFilter = FilterUtility.constructPrefixFilterAsRangeFilter(parentContextId);
      filter.contextId = prefixFilter;
    }

    // Query for all records at this path and context
    const { messages: siblingMessages } = await this.messageStore.query(tenant, [filter]);

    // Group messages by recordId — RecordsWrite messages use `message.recordId`,
    // RecordsDelete messages use `message.descriptor.recordId`.
    const recordIdToMessages = StorageController.groupSquashSiblingsByRecordId(siblingMessages);

    // Delete all records whose newest message timestamp is strictly older than the squash timestamp.
    // Skip the squash record itself.
    for (const [recordId, messages] of recordIdToMessages) {
      if (recordId === message.recordId) {
        continue;
      }

      // Use the newest message's timestamp to determine if the record predates the squash.
      const newestMessage = await Message.getNewestMessage(messages);
      if (newestMessage === undefined) {
        continue;
      }

      const newestTimestamp = newestMessage.descriptor.messageTimestamp;
      if (newestTimestamp < messageTimestamp) {
        // Fully purge this record — all messages (including initial write) and their data
        await StorageController.purgeRecordMessages(tenant, messages, this.messageStore, this.dataStore);
      }
    }
  }

  /**
   * Groups the given messages by `recordId` — RecordsWrite messages use `message.recordId`,
   * RecordsDelete messages use `message.descriptor.recordId`. Used by `performRecordsSquash()`
   * to identify sibling records at the squash record's protocol path and parent context.
   */
  private static groupSquashSiblingsByRecordId(messages: GenericMessage[]): Map<string, GenericMessage[]> {
    const recordIdToMessages = new Map<string, GenericMessage[]>();
    for (const msg of messages) {
      let recordId: string;
      if (Records.isRecordsWrite(msg)) {
        recordId = msg.recordId;
      } else {
        recordId = (msg as RecordsDeleteMessage).descriptor.recordId;
      }

      const existing = recordIdToMessages.get(recordId);
      if (existing === undefined) {
        recordIdToMessages.set(recordId, [msg]);
      } else {
        existing.push(msg);
      }
    }

    return recordIdToMessages;
  }

  /**
   * Deletes the data referenced by the given message if needed.
   * @param message The message to check if the data it references should be deleted.
   */
  private static async deleteFromDataStoreIfNeeded(
    dataStore: DataStore,
    tenant: string,
    message: GenericMessage,
    newestMessage: GenericMessage
  ): Promise<void> {
    if (message.descriptor.method !== DwnMethodName.Write) {
      return;
    }

    const recordsWriteMessage = message as RecordsWriteMessage;

    // Optional short-circuit optimization to avoid unnecessary data store call since the data should be encoded with the message itself in this case,
    // but data store call is a no-op thus code still works correctly even if this short-circuit is removed.
    if (recordsWriteMessage.descriptor.dataSize <= DwnConstant.maxDataSizeAllowedToBeEncoded) {
      return;
    }

    // We must still keep the data if the newest message still references the same data.
    if (recordsWriteMessage.descriptor.dataCid === (newestMessage as RecordsWriteMessage).descriptor.dataCid) {
      return;
    }

    // Else we delete the data from the data store.
    await dataStore.delete(tenant, recordsWriteMessage.recordId, recordsWriteMessage.descriptor.dataCid);
  }

  /**
   * Purges (permanent hard-delete) all descendants of the given `recordId`, recursively.
   *
   * The cascade is intentionally protocol-agnostic: `parentContextId` is a structural link,
   * so pruning a parent removes every record hanging off it regardless of which protocol a
   * descendant lives in. Cross-protocol composing children (records in a different protocol
   * that reference the parent via `$ref` / `uses`) are included in the cascade.
   *
   * Rationale (closes #298 as working-as-intended):
   * - A DWN is tenant-owned storage. The tenant's prune authority extends across the whole
   *   subtree they rooted, regardless of which protocol a descendant declares itself under.
   * - Preserving cross-protocol orphans creates a half-alive state (readable but not
   *   updatable, since `validateReferentialIntegrity` requires the pruned parent) that is
   *   worse for callers than simply cascading.
   * - Same-protocol cascade is already protocol-agnostic at every hop via `parentId`,
   *   so treating cross-protocol boundaries differently was inconsistent.
   */
  public static async purgeRecordDescendants(
    tenant: string,
    recordId: string,
    messageStore: MessageStore,
    dataStore: DataStore
  ): Promise<void> {
    const filter: Filter = {
      interface : DwnInterfaceName.Records,
      parentId  : recordId,
    };
    const { messages: childMessages } = await messageStore.query(tenant, [filter]);

    // group the child messages by `recordId`
    const recordIdToMessagesMap = new Map<string, GenericMessage[]>();
    for (const message of childMessages) {
      let recordId;
      if (Records.isRecordsWrite(message)) {
        recordId = message.recordId;
      } else {
        recordId = (message as RecordsDeleteMessage).descriptor.recordId;
      }

      const existingMessages = recordIdToMessagesMap.get(recordId);
      if (existingMessages) {
        existingMessages.push(message);
      } else {
        recordIdToMessagesMap.set(recordId, [message]);
      }
    }

    for (const childRecordId of recordIdToMessagesMap.keys()) {
      await StorageController.purgeRecordDescendants(tenant, childRecordId, messageStore, dataStore);
    }

    for (const childRecordId of recordIdToMessagesMap.keys()) {
      await StorageController.purgeRecordMessages(tenant, recordIdToMessagesMap.get(childRecordId)!, messageStore, dataStore);
    }
  }

  /**
   * Purges (permanent hard-delete) all messages of the SAME `recordId` given and their associated data and events.
   * Assumes that the given `recordMessages` are all of the same `recordId`.
   */
  public static async purgeRecordMessages(
    tenant: string,
    recordMessages: GenericMessage[],
    messageStore: MessageStore,
    dataStore: DataStore
  ): Promise<void> {
    // delete the data from the data store first so no chance of orphaned data (not having a message referencing it) in case of server crash
    // NOTE: only the `RecordsWrite` with latest timestamp can possibly have data associated with it so we do this filtering as an optimization
    // NOTE: however there could still be no data associated with the `RecordsWrite` with newest timestamp, because either:
    //       1. the data is encoded with the message itself; or
    //       2. the newest `RecordsWrite` may not be the "true" latest state due to:
    //          a. sync has yet to write the latest `RecordsWrite`; or
    //          b. `recordMessages` maybe an incomplete page of results if the caller uses the paging in its query
    // Calling dataStore.delete() is a no-op if the data is not found, so we are safe to call it redundantly.
    const recordsWrites = recordMessages.filter((message) => message.descriptor.method === DwnMethodName.Write);
    const newestRecordsWrite = (await Message.getNewestMessage(recordsWrites)) as RecordsWriteMessage;
    await dataStore.delete(tenant, newestRecordsWrite.recordId, newestRecordsWrite.descriptor.dataCid);

    const messageCids = await Promise.all(recordMessages.map((message) => Message.getCid(message)));

    await Promise.all(messageCids.map((messageCid) => messageStore.delete(tenant, messageCid)));
  }

  /**
   * Stores the new latest message and displaces every other message in `existingMessages` as ONE
   * atomic message-store commit: the initial write and the caller-supplied writes are retained as
   * non-latest state for future replay and tombstone visibility reconstruction, and the remaining
   * displaced messages are deleted. Readers can never observe an intermediate state where both the
   * new message and a displaced message carry latest-state indexes.
   *
   * Displacement is deliberately NOT a timestamp comparison: a RecordsDelete displaces even a
   * newer RecordsWrite (delete-wins convergence), and on resumable-task replay the new message
   * itself is back in `existingMessages` and must survive — so membership is decided by CID.
   *
   * Displaced messages' unreferenced data is deleted from the data store only AFTER the commit:
   * a crash in between leaves at most an orphaned data blob, never a live row whose data is gone.
   */
  public static async commitLatestStateTransition(
    tenant: string,
    existingMessages: GenericMessage[],
    newMessage: { message: GenericMessage, indexes: KeyValues },
    additionalRetainedRecordsWrites: RecordsWriteMessage[],
    messageStore: MessageStore,
    dataStore: DataStore,
  ): Promise<MessageStorePutResult> {
    const newMessageCid = await Message.getCid(newMessage.message);
    const additionalRetainedRecordsWriteCids = new Set<string>();
    for (const retainedRecordsWrite of additionalRetainedRecordsWrites) {
      additionalRetainedRecordsWriteCids.add(await Message.getCid(retainedRecordsWrite));
    }

    // NOTE: under normal operation, there should only be at most two existing records per `recordId` (initial + a potential subsequent write/delete),
    // but the plan-then-commit shape below heals any lingering rows a previous partial application left behind.
    const retains: { messageCid: string, message: GenericMessage, indexes: KeyValues }[] = [];
    const deletes: string[] = [];
    const displacedMessages: GenericMessage[] = [];
    for (const message of existingMessages) {
      const messageCid = await Message.getCid(message);
      const messageIsDisplaced = messageCid !== newMessageCid;
      if (!messageIsDisplaced) {
        continue;
      }

      displacedMessages.push(message);

      // Retained writes must stay in the message store and state index so future deletes and
      // replicas can reconstruct tombstone visibility, but they must no longer be latest state.
      const shouldKeepAsNonLatestWrite =
        await RecordsWrite.isInitialWrite(message) ||
        additionalRetainedRecordsWriteCids.has(messageCid);
      if (shouldKeepAsNonLatestWrite) {
        const retainedRecordsWriteMessage = StorageController.stripInlineData(message as RecordsWriteMessage);
        const existingRecordsWrite = await RecordsWrite.parse(retainedRecordsWriteMessage);
        const isLatestBaseState = false;
        const indexes = await existingRecordsWrite.constructIndexes(isLatestBaseState);
        retains.push({ messageCid, message: retainedRecordsWriteMessage, indexes });
      } else {
        deletes.push(messageCid);
      }
    }

    const putResult = await messageStore.commitLatestState(tenant, { put: newMessage, retains, deletes });

    for (const message of displacedMessages) {
      await StorageController.deleteFromDataStoreIfNeeded(dataStore, tenant, message, newMessage.message);
    }

    return putResult;
  }

  private static stripInlineData(message: RecordsWriteMessage): RecordsWriteMessage {
    const retainedMessage = { ...message } as RecordsWriteMessage & { encodedData?: string };
    delete retainedMessage.encodedData;
    return retainedMessage;
  }
}
