import type { GenericMessage } from '../types/message-types.js';
import type { StateIndex } from '../types/state-index.js';
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
 * Maximum inline data size for diff responses, aligned with the
 * {@link DwnConstant.maxDataSizeAllowedToBeEncoded} threshold.
 */
const DEFAULT_MAX_INLINE_DATA_SIZE = DwnConstant.maxDataSizeAllowedToBeEncoded;

type StoredMessageWithEncodedData = GenericMessage & { encodedData?: string };

export class MessagesSyncHandler implements MethodHandler {

  private _defaultHashHexCache?: Map<number, string>;

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
      await MessagesSyncHandler.authorizeMessagesSync(tenant, messagesSync, this.deps);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    try {
      switch (message.descriptor.action) {
      case 'root':
        return await this.handleRoot(tenant, message);

      case 'subtree':
        return await this.handleSubtree(tenant, message);

      case 'leaves':
        return await this.handleLeaves(tenant, message);

      case 'diff':
        return await this.handleDiff(tenant, message);

      default:
        return {
          status: { code: 400, detail: `Unknown action: ${message.descriptor.action as string}` },
        };
      }
    } catch (e) {
      return messageReplyFromError(e, 500);
    }
  }

  private async handleRoot(
    tenant: string,
    message: MessagesSyncMessage,
  ): Promise<MessagesSyncReply> {
    const root = hashToHex(await this.getIndexedRootHash(tenant, message.descriptor.protocol));
    return {
      status: { code: 200, detail: 'OK' },
      root,
    };
  }

  private async handleSubtree(
    tenant: string,
    message: MessagesSyncMessage,
  ): Promise<MessagesSyncReply> {
    const bitPath = MessagesSyncHandler.parseBitPrefix(message.descriptor.prefix!);
    const hash = await MessagesSyncHandler.getIndexedSubtreeHash(
      this.deps.stateIndex!,
      tenant,
      message.descriptor.protocol,
      bitPath,
    );

    return {
      status : { code: 200, detail: 'OK' },
      hash   : hashToHex(hash),
    };
  }

  private async handleLeaves(
    tenant: string,
    message: MessagesSyncMessage,
  ): Promise<MessagesSyncReply> {
    const bitPath = MessagesSyncHandler.parseBitPrefix(message.descriptor.prefix!);
    const leaves = await MessagesSyncHandler.getIndexedLeaves(
      this.deps.stateIndex!,
      tenant,
      message.descriptor.protocol,
      bitPath,
    );

    return {
      status  : { code: 200, detail: 'OK' },
      entries : leaves,
    };
  }

  /**
   * Computes a single-round diff between the client's sparse Merkle tree view
   * and this DWN's full/protocol StateIndex tree.
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

    const onlyRemoteCids: string[] = [];
    const onlyLocalPrefixes: string[] = [];
    const defaultHashHex = await this.getDefaultHashHex(depth);
    const allPrefixes = new Set<string>();

    for (const [prefix, hash] of Object.entries(clientHashes)) {
      if (hash !== defaultHashHex) {
        allPrefixes.add(prefix);
      }
    }

    const serverHashes = await this.collectSubtreeHashes(tenant, protocol, depth);
    for (const prefix of Object.keys(serverHashes)) {
      allPrefixes.add(prefix);
    }

    for (const prefix of allPrefixes) {
      const clientHash = clientHashes[prefix];
      const serverHash = serverHashes[prefix];

      if (clientHash === serverHash) {
        continue;
      }

      if (serverHash === undefined) {
        onlyLocalPrefixes.push(prefix);
        continue;
      }

      const bitPath = MessagesSyncHandler.parseBitPrefix(prefix);
      const serverLeaves = await MessagesSyncHandler.getIndexedLeaves(
        this.deps.stateIndex!,
        tenant,
        protocol,
        bitPath,
      );

      onlyRemoteCids.push(...serverLeaves);
      if (clientHash !== undefined) {
        onlyLocalPrefixes.push(prefix);
      }
    }

    return {
      status     : { code: 200, detail: 'OK' },
      onlyRemote : await this.buildDiffEntries(tenant, onlyRemoteCids),
      onlyLocal  : onlyLocalPrefixes,
    };
  }

  private async getIndexedRootHash(
    tenant: string,
    protocol: string | undefined
  ): Promise<Uint8Array> {
    if (protocol === undefined) {
      return this.deps.stateIndex!.getRoot(tenant);
    }

    return this.deps.stateIndex!.getProtocolRoot(tenant, protocol);
  }

  /**
   * Walks this DWN's StateIndex tree to the requested depth and returns only
   * non-empty subtree hashes keyed by bit prefix.
   */
  private async collectSubtreeHashes(
    tenant: string,
    protocol: string | undefined,
    depth: number,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    const walk = async (prefix: string, currentDepth: number): Promise<void> => {
      const bitPath = MessagesSyncHandler.parseBitPrefix(prefix);
      const hash = await MessagesSyncHandler.getIndexedSubtreeHash(
        this.deps.stateIndex!,
        tenant,
        protocol,
        bitPath,
      );
      const hexHash = hashToHex(hash);
      const defaultHashHex = await this.getDefaultHashHex(currentDepth);

      if (hexHash === defaultHashHex) {
        return;
      }

      if (currentDepth >= depth) {
        result[prefix] = hexHash;
        return;
      }

      await Promise.all([
        walk(prefix + '0', currentDepth + 1),
        walk(prefix + '1', currentDepth + 1),
      ]);
    };

    await walk('', 0);
    return result;
  }

  private static async getIndexedLeaves(
    stateIndex: StateIndex,
    tenant: string,
    protocol: string | undefined,
    bitPath: boolean[]
  ): Promise<string[]> {
    if (protocol === undefined) {
      return stateIndex.getLeaves(tenant, bitPath);
    }

    return stateIndex.getProtocolLeaves(tenant, protocol, bitPath);
  }

  private static async getIndexedSubtreeHash(
    stateIndex: StateIndex,
    tenant: string,
    protocol: string | undefined,
    bitPath: boolean[]
  ): Promise<Uint8Array> {
    if (protocol === undefined) {
      return stateIndex.getSubtreeHash(tenant, bitPath);
    }

    return stateIndex.getProtocolSubtreeHash(tenant, protocol, bitPath);
  }

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
   * Builds diff entries and inlines data when it is small enough for the
   * MessagesSync response. Large record data remains fetch-by-CID.
   */
  private async buildDiffEntries(
    tenant: string,
    messageCids: string[],
  ): Promise<MessagesSyncDiffEntry[]> {
    const entries: MessagesSyncDiffEntry[] = [];

    for (const messageCid of messageCids) {
      const { message, encodedData: inlineData, data } = await this.readMessageByCid(tenant, messageCid);
      if (!message) {
        continue;
      }

      const entry: MessagesSyncDiffEntry = { messageCid, message };

      if (inlineData) {
        entry.encodedData = inlineData;
      } else if (data) {
        const bytes = await MessagesSyncHandler.streamToBytes(data);
        if (bytes.byteLength <= DEFAULT_MAX_INLINE_DATA_SIZE) {
          entry.encodedData = Encoder.bytesToBase64Url(bytes);
        }
      }

      entries.push(entry);
    }

    return entries;
  }

  private async readMessageByCid(
    tenant: string,
    messageCid: string,
  ): Promise<{ message?: GenericMessage; encodedData?: string; data?: ReadableStream<Uint8Array> }> {
    const storedMessage = await this.deps.messageStore.get(tenant, messageCid);
    if (!storedMessage) {
      return {};
    }

    let inlineEncodedData: string | undefined;
    if (MessagesSyncHandler.hasEncodedData(storedMessage)) {
      inlineEncodedData = storedMessage.encodedData;
      delete storedMessage.encodedData;
    }

    let data: ReadableStream<Uint8Array> | undefined;
    if (inlineEncodedData === undefined && Records.isRecordsWrite(storedMessage)) {
      const { dataCid, dataSize } = storedMessage.descriptor;
      if (dataSize <= DEFAULT_MAX_INLINE_DATA_SIZE && this.deps.dataStore) {
        const dataResult = await this.deps.dataStore.get(tenant, storedMessage.recordId, dataCid);
        data = dataResult?.dataStream;
      }
    }

    return { message: storedMessage, encodedData: inlineEncodedData, data };
  }

  private static hasEncodedData(message: GenericMessage): message is StoredMessageWithEncodedData {
    return 'encodedData' in message && typeof message.encodedData === 'string';
  }

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
    deps: HandlerDependencies
  ): Promise<void> {
    if (messagesSync.author === tenant) {
      return;
    }

    const permissionGrantIds = Message.getPermissionGrantIds(messagesSync.signaturePayload!);
    if (messagesSync.author !== undefined && permissionGrantIds.length > 0) {
      const permissionGrants = await MessagesGrantAuthorization.fetchPermissionGrants(tenant, deps.validationStateReader, permissionGrantIds);
      await MessagesGrantAuthorization.authorizeSubscribeOrSync({
        incomingMessage       : messagesSync.message,
        expectedGrantor       : tenant,
        expectedGrantee       : messagesSync.author,
        permissionGrants,
        validationStateReader : deps.validationStateReader
      });
      return;
    }

    throw new DwnError(DwnErrorCode.MessagesSyncAuthorizationFailed, 'message failed authorization');
  }
}
