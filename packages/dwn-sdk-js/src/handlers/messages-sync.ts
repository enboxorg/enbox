import type { GenericMessage } from '../types/message-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesSyncDiffEntry, MessagesSyncMessage, MessagesSyncReply } from '../types/messages-types.js';

import { authenticate } from '../core/auth.js';
import { DwnConstant } from '../core/dwn-constant.js';
import { Encoder } from '../utils/encoder.js';
import { hashToHex } from '../smt/smt-utils.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesSync } from '../interfaces/messages-sync.js';
import { Records } from '../utils/records.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

/**
 * Maximum inline data size for diff responses — aligned with the
 * {@link DwnConstant.maxDataSizeAllowedToBeEncoded} threshold (30 KB).
 * RecordsWrite data payloads smaller than this are base64url-encoded and
 * included directly in the diff reply.  Larger payloads must be fetched
 * separately via MessagesRead.
 */
const DEFAULT_MAX_INLINE_DATA_SIZE = DwnConstant.maxDataSizeAllowedToBeEncoded;

type StoredMessageWithEncodedData = GenericMessage & { encodedData?: string };


export class MessagesSyncHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message
  }: { tenant: string, message: MessagesSyncMessage }): Promise<MessagesSyncReply> {
    let messagesSync: MessagesSync;

    try {
      messagesSync = await MessagesSync.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    try {
      await authenticate(message.authorization, this.deps.didResolver);
      await MessagesSyncHandler.authorizeMessagesSync(tenant, messagesSync, this.deps.messageStore);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    const { action, protocol, prefix } = message.descriptor;

    try {
      switch (action) {
      case 'root': {
        const rootHash = protocol === undefined
          ? await this.deps.stateIndex!.getRoot(tenant)
          : await this.deps.stateIndex!.getProtocolRoot(tenant, protocol);
        return {
          status : { code: 200, detail: 'OK' },
          root   : hashToHex(rootHash),
        };
      }

      case 'subtree': {
        const bitPath = MessagesSyncHandler.parseBitPrefix(prefix!);
        const hash = protocol === undefined
          ? await this.deps.stateIndex!.getSubtreeHash(tenant, bitPath)
          : await this.deps.stateIndex!.getProtocolSubtreeHash(tenant, protocol, bitPath);
        return {
          status : { code: 200, detail: 'OK' },
          hash   : hashToHex(hash),
        };
      }

      case 'leaves': {
        const bitPath = MessagesSyncHandler.parseBitPrefix(prefix!);
        const leaves = protocol === undefined
          ? await this.deps.stateIndex!.getLeaves(tenant, bitPath)
          : await this.deps.stateIndex!.getProtocolLeaves(tenant, protocol, bitPath);
        return {
          status  : { code: 200, detail: 'OK' },
          entries : leaves,
        };
      }

      case 'diff': {
        return this.handleDiff(tenant, message);
      }

      default: {
        return {
          status: { code: 400, detail: `Unknown action: ${action as string}` },
        };
      }
      }
    } catch (e) {
      return messageReplyFromError(e, 500);
    }
  }

  /**
   * Handle the 'diff' action: the client sends its subtree hashes at a given
   * depth, and the server compares them against its own tree to compute the
   * set difference in a single round-trip.
   *
   * Response includes:
   * - `onlyRemote`: messages the server has that the client doesn't, with
   *   inline data for small payloads.
   * - `onlyLocal`: bit prefixes where the client has entries the server
   *   doesn't (client can enumerate its own leaves for these prefixes).
   */
  private async handleDiff(
    tenant: string,
    message: MessagesSyncMessage,
  ): Promise<MessagesSyncReply> {
    const { protocol, hashes: clientHashes, depth } = message.descriptor;

    if (!clientHashes || depth === undefined) {
      return {
        status: { code: 400, detail: 'diff action requires hashes and depth' },
      };
    }

    const stateIndex = this.deps.stateIndex!;
    const onlyRemoteCids: string[] = [];
    const onlyLocalPrefixes: string[] = [];

    // Get the default (empty subtree) hash at the given depth so we can
    // filter out client entries that represent empty subtrees.
    const defaultHashHex = await this.getDefaultHashHex(depth);

    // Build the set of all prefixes at the given depth that either side has.
    // Filter out client prefixes whose hash equals the default (empty subtree)
    // hash — these represent empty subtrees and should be treated the same as
    // omitted prefixes.
    const allPrefixes = new Set<string>();
    for (const [pfx, hash] of Object.entries(clientHashes)) {
      if (hash !== defaultHashHex) {
        allPrefixes.add(pfx);
      }
    }

    // Enumerate server-side non-empty prefixes by walking the server's
    // tree to the given depth and collecting leaf prefixes.
    const serverHashes = await this.collectSubtreeHashes(tenant, protocol, depth);
    for (const prefix of Object.keys(serverHashes)) {
      allPrefixes.add(prefix);
    }

    // Compare each prefix's hash between client and server.
    for (const pfx of allPrefixes) {
      const clientHash = clientHashes[pfx]; // undefined if client has empty subtree
      const serverHash = serverHashes[pfx]; // undefined if server has empty subtree

      if (clientHash === serverHash) {
        // Identical subtree — skip.
        continue;
      }

      if (serverHash === undefined) {
        // Client has entries the server doesn't.
        onlyLocalPrefixes.push(pfx);
        continue;
      }

      if (clientHash === undefined) {
        // Server has entries the client doesn't — enumerate server leaves.
        const bitPath = MessagesSyncHandler.parseBitPrefix(pfx);
        const leaves = protocol === undefined
          ? await stateIndex.getLeaves(tenant, bitPath)
          : await stateIndex.getProtocolLeaves(tenant, protocol, bitPath);
        onlyRemoteCids.push(...leaves);
        continue;
      }

      // Both sides have entries but they differ — enumerate both and set-diff.
      const bitPath = MessagesSyncHandler.parseBitPrefix(pfx);
      const serverLeaves = protocol === undefined
        ? await stateIndex.getLeaves(tenant, bitPath)
        : await stateIndex.getProtocolLeaves(tenant, protocol, bitPath);

      // We don't have the client's leaves, so we report all server leaves
      // as onlyRemote (the client will de-duplicate locally). We also
      // report this prefix as onlyLocal so the client can check its own leaves.
      onlyRemoteCids.push(...serverLeaves);
      onlyLocalPrefixes.push(pfx);
    }

    // Build response entries with inline message data where possible.
    const onlyRemote = await this.buildDiffEntries(tenant, onlyRemoteCids);

    return {
      status    : { code: 200, detail: 'OK' },
      onlyRemote,
      onlyLocal : onlyLocalPrefixes,
    };
  }

  /**
   * Walk the server's SMT to the given depth and collect all non-empty
   * subtree hashes as a `{ prefix: hexHash }` map.
   */
  private async collectSubtreeHashes(
    tenant: string,
    protocol: string | undefined,
    depth: number,
  ): Promise<Record<string, string>> {
    const stateIndex = this.deps.stateIndex!;
    const result: Record<string, string> = {};
    const defaultHashHex = await this.getDefaultHashHex(depth);

    const walk = async (prefix: string, currentDepth: number): Promise<void> => {
      const bitPath = MessagesSyncHandler.parseBitPrefix(prefix);
      const hash = protocol === undefined
        ? await stateIndex.getSubtreeHash(tenant, bitPath)
        : await stateIndex.getProtocolSubtreeHash(tenant, protocol, bitPath);
      const hexHash = hashToHex(hash);

      if (hexHash === defaultHashHex) {
        // Empty subtree — don't include in the result.
        return;
      }

      if (currentDepth >= depth) {
        // Reached target depth with a non-empty subtree.
        result[prefix] = hexHash;
        return;
      }

      // Recurse into children.
      await Promise.all([
        walk(prefix + '0', currentDepth + 1),
        walk(prefix + '1', currentDepth + 1),
      ]);
    };

    await walk('', 0);
    return result;
  }

  /**
   * Get the hex-encoded default hash for a given depth. Lazily cached.
   */
  private _defaultHashHexCache?: Map<number, string>;
  private async getDefaultHashHex(depth: number): Promise<string> {
    if (this._defaultHashHexCache === undefined) {
      const { initDefaultHashes } = await import('../smt/smt-utils.js');
      const defaults = await initDefaultHashes();
      this._defaultHashHexCache = new Map<number, string>();
      for (let d = 0; d <= 256; d++) {
        this._defaultHashHexCache.set(d, hashToHex(defaults[d]));
      }
    }
    return this._defaultHashHexCache.get(depth) ?? '';
  }

  /**
   * Build diff response entries for the given messageCids.
   * Reads each message from the MessageStore and, for small RecordsWrite
   * payloads, inlines the data as base64url.
   */
  private async buildDiffEntries(
    tenant: string,
    messageCids: string[],
  ): Promise<MessagesSyncDiffEntry[]> {
    const entries: MessagesSyncDiffEntry[] = [];

    for (const messageCid of messageCids) {
      const { message, encodedData: inlineData, data } = await this.readMessageByCid(tenant, messageCid);
      if (!message) {
        // Message was deleted between diff computation and read — skip.
        continue;
      }

      const entry: MessagesSyncDiffEntry = { messageCid, message };

      // Use inline data from the MessageStore if available (small payloads).
      if (inlineData) {
        entry.encodedData = inlineData;
      } else if (data) {
        // Data is in the DataStore — inline it if small enough.
        const bytes = await MessagesSyncHandler.streamToBytes(data);
        if (bytes.byteLength <= DEFAULT_MAX_INLINE_DATA_SIZE) {
          entry.encodedData = Encoder.bytesToBase64Url(bytes);
        }
        // Large payloads are NOT inlined — client fetches via MessagesRead.
      }

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Read a message and its data from the MessageStore + DataStore by CID.
   */
  private async readMessageByCid(
    tenant: string,
    messageCid: string,
  ): Promise<{ message?: GenericMessage; encodedData?: string; data?: ReadableStream<Uint8Array> }> {
    const storedMessage = await this.deps.messageStore.get(tenant, messageCid);
    if (!storedMessage) {
      return {};
    }

    // Extract and strip `encodedData` from the stored message.
    // `encodedData` is an internal storage optimization for small payloads
    // that are stored inline in the MessageStore rather than in the DataStore.
    // It must not be included in the wire-format message (the recipient's
    // DWN would reject it as an unexpected top-level property).
    let inlineEncodedData: string | undefined;
    if (MessagesSyncHandler.hasEncodedData(storedMessage)) {
      inlineEncodedData = storedMessage.encodedData;
      delete storedMessage.encodedData;
    }

    let data: ReadableStream<Uint8Array> | undefined;

    // Check if this is a RecordsWrite with data that is small enough to inline.
    if (inlineEncodedData === undefined && Records.isRecordsWrite(storedMessage)) {
      const { dataCid, dataSize } = storedMessage.descriptor;
      if (dataSize <= DEFAULT_MAX_INLINE_DATA_SIZE) {
        // Some stores may have small payload bytes in DataStore instead of encodedData.
        if (this.deps.dataStore) {
          // DataStore uses recordId, not messageCid. For RecordsWrite,
          // recordId is a top-level message property.
          const dataResult = await this.deps.dataStore.get(tenant, storedMessage.recordId, dataCid);
          if (dataResult?.dataStream) {
            data = dataResult.dataStream;
          }
        }
      }
    }

    return { message: storedMessage, encodedData: inlineEncodedData, data };
  }

  private static hasEncodedData(message: GenericMessage): message is StoredMessageWithEncodedData {
    return 'encodedData' in message && typeof message.encodedData === 'string';
  }

  /**
   * Read a ReadableStream to completion and return the bytes.
   */
  private static async streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      chunks.push(value);
      totalSize += value.byteLength;
    }

    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  /**
   * Parse a bit prefix string (e.g. "0110101") into a boolean array.
   */
  private static parseBitPrefix(prefix: string): boolean[] {
    if (!/^[01]*$/.test(prefix)) {
      throw new DwnError(
        DwnErrorCode.MessagesSyncInvalidPrefix,
        `Invalid prefix: must contain only '0' and '1' characters, got: ${prefix}`
      );
    }
    if (prefix.length > 256) {
      throw new DwnError(
        DwnErrorCode.MessagesSyncInvalidPrefix,
        `Invalid prefix: length must be <= 256, got: ${prefix.length}`
      );
    }
    return Array.from(prefix, (ch): boolean => ch === '1');
  }

  private static async authorizeMessagesSync(
    tenant: string,
    messagesSync: MessagesSync,
    messageStore: MessageStore
  ): Promise<void> {
    if (messagesSync.author === tenant) {
      return;
    }

    const permissionGrantIds = Message.getPermissionGrantIds(messagesSync.signaturePayload!);
    if (messagesSync.author !== undefined && permissionGrantIds.length > 0) {
      const permissionGrants = await MessagesGrantAuthorization.fetchPermissionGrants(tenant, messageStore, permissionGrantIds);
      await MessagesGrantAuthorization.authorizeSubscribeOrSync({
        incomingMessage : messagesSync.message,
        expectedGrantor : tenant,
        expectedGrantee : messagesSync.author,
        permissionGrants,
        messageStore
      });
    } else {
      throw new DwnError(DwnErrorCode.MessagesSyncAuthorizationFailed, 'message failed authorization');
    }
  }
}
