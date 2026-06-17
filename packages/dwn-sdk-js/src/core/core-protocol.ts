import type { DataStore } from '../types/data-store.js';
import type { Filter } from '../types/query-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { ProtocolDefinition } from '../types/protocols-types.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

/**
 * Bundled store references passed to core protocol post-processing hooks.
 */
export type CoreProtocolStores = {
  messageStore : MessageStore;
  dataStore : DataStore;
};

/**
 * A core protocol is a hardcoded, immutable, always-installed DWN protocol
 * with lifecycle hooks that participate in the Records message processing pipeline.
 *
 * Core protocols are returned from `fetchProtocolDefinition()` without a database
 * lookup and cannot be overridden by `ProtocolsConfigure`. They provide system-level
 * behavior (e.g., permissions) while riding on the Records interface for CRUD and sync.
 */
export interface CoreProtocol {
  /** The immutable protocol definition. */
  readonly definition: ProtocolDefinition;

  /** The protocol URI (shorthand for `definition.protocol`). */
  readonly uri: string;

  /**
   * Validate the data payload of a record being written under this protocol.
   * Called after protocol authorization but before storage.
   * @throws DwnError to reject the write with the appropriate status code.
   */
  validateRecord?(message: RecordsWriteMessage, dataBytes: Uint8Array): void;

  /**
   * Pre-processing hook: runs before storing a record under this protocol.
   * Can perform cross-record validation (e.g., revocation tag consistency checks).
   * State reads are validation-time reads and must route through the `ValidationStateReader`.
   * @throws DwnError to reject the write.
   */
  preProcessWrite?(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void>;

  /**
   * Post-processing hook: runs after successfully storing a record under this protocol.
   * Can perform cascading side effects (e.g., cleanup of grant-authorized messages on revocation).
   */
  postProcessWrite?(
    tenant: string,
    recordsWrite: RecordsWrite,
    stores: CoreProtocolStores,
  ): Promise<void>;

  /**
   * Map an error code from this protocol's validation to an HTTP status code.
   * Return `undefined` if the error code is not owned by this protocol.
   */
  mapErrorToStatusCode?(errorCode: string): number | undefined;

  /**
   * Construct an additional filter to include this protocol's records in
   * protocol-scoped `MessagesFilter` conversions (e.g., sync, subscribe, read).
   *
   * This is used when permission records (or similar system records) are tagged
   * with a target protocol and must appear alongside that protocol's records in
   * message-level queries.
   *
   * Return `undefined` if no additional filter is needed for the given input.
   */
  constructAdditionalMessageFilter?(filter: MessagesFilter): Filter | undefined;
}

/**
 * Registry of core protocols. Owned by a `Dwn` instance (not a static singleton)
 * so that each DWN — including those in tests — gets an isolated registry.
 */
export class CoreProtocolRegistry {
  private readonly _protocols: Map<string, CoreProtocol> = new Map();

  /** Register a core protocol. */
  public register(protocol: CoreProtocol): void {
    this._protocols.set(protocol.uri, protocol);
  }

  /** Get a core protocol by URI, or `undefined` if not registered. */
  public get(uri: string): CoreProtocol | undefined {
    return this._protocols.get(uri);
  }

  /**
   * Get the protocol definition for a core protocol, or `undefined`.
   * Used by `fetchProtocolDefinition()` to bypass the message store for core protocols.
   */
  public getDefinition(uri: string): ProtocolDefinition | undefined {
    return this._protocols.get(uri)?.definition;
  }

  /** Check whether a URI is a registered core protocol. */
  public has(uri: string): boolean {
    return this._protocols.has(uri);
  }

  /** Get all registered core protocols. */
  public all(): CoreProtocol[] {
    return [...this._protocols.values()];
  }

  /**
   * Delegate error code mapping to all registered core protocols.
   * Returns the first non-`undefined` status code, or `undefined` if no protocol claims the error.
   */
  public mapErrorToStatusCode(errorCode: string): number | undefined {
    for (const protocol of this._protocols.values()) {
      const status = protocol.mapErrorToStatusCode?.(errorCode);
      if (status !== undefined) {
        return status;
      }
    }
    return undefined;
  }
}
