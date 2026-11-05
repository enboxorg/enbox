import type { DataStore } from '../types/data-store.js';
import type { Filter } from '../types/query-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { ModuleDefinition } from '../types/modules-types.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

/**
 * Bundled store references passed to core module post-processing hooks.
 */
export type CoreModuleStores = {
  messageStore : MessageStore;
  dataStore : DataStore;
};

/**
 * A core module is a hardcoded, immutable, always-installed DWN module
 * with lifecycle hooks that participate in the Records message processing pipeline.
 *
 * Core modules are returned from `fetchModuleDefinition()` without a database
 * lookup and cannot be overridden by `ModulesConfigure`. They provide system-level
 * behavior (e.g., permissions) while riding on the Records interface for CRUD and sync.
 */
export interface CoreModule {
  /** The immutable module definition. */
  readonly definition: ModuleDefinition;

  /** The module URI (shorthand for `definition.module`). */
  readonly uri: string;

  /**
   * Validate the data payload of a record being written under this module.
   * Called after module authorization but before storage.
   * @throws DwnError to reject the write with the appropriate status code.
   */
  validateRecord?(message: RecordsWriteMessage, dataBytes: Uint8Array): Promise<void> | void;

  /**
   * Pre-processing hook: runs before storing a record under this module.
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
   * Post-processing hook: runs after successfully storing a record under this module.
   * Can perform cascading side effects (e.g., cleanup of grant-authorized messages on revocation).
   */
  postProcessWrite?(
    tenant: string,
    recordsWrite: RecordsWrite,
    stores: CoreModuleStores,
  ): Promise<void>;

  /**
   * Map an error code from this module's validation to an HTTP status code.
   * Return `undefined` if the error code is not owned by this module.
   */
  mapErrorToStatusCode?(errorCode: string): number | undefined;

  /**
   * Construct an additional filter to include this module's records in
   * module-scoped `MessagesFilter` conversions (e.g., sync, subscribe, read).
   *
   * This is used when permission records (or similar system records) are tagged
   * with a target module and must appear alongside that module's records in
   * message-level queries.
   *
   * Return `undefined` if no additional filter is needed for the given input.
   */
  constructAdditionalMessageFilter?(filter: MessagesFilter): Filter | undefined;
}

/**
 * Registry of core modules. Owned by a `Dwn` instance (not a static singleton)
 * so that each DWN — including those in tests — gets an isolated registry.
 */
export class CoreModuleRegistry {
  private readonly _modules: Map<string, CoreModule> = new Map();

  /** Register a core module. */
  public register(module: CoreModule): void {
    this._modules.set(module.uri, module);
  }

  /** Get a core module by URI, or `undefined` if not registered. */
  public get(uri: string): CoreModule | undefined {
    return this._modules.get(uri);
  }

  /**
   * Get the module definition for a core module, or `undefined`.
   * Used by `fetchModuleDefinition()` to bypass the message store for core modules.
   */
  public getDefinition(uri: string): ModuleDefinition | undefined {
    return this._modules.get(uri)?.definition;
  }

  /** Check whether a URI is a registered core module. */
  public has(uri: string): boolean {
    return this._modules.has(uri);
  }

  /** Get all registered core modules. */
  public all(): CoreModule[] {
    return [...this._modules.values()];
  }

  /**
   * Delegate error code mapping to all registered core modules.
   * Returns the first non-`undefined` status code, or `undefined` if no module claims the error.
   */
  public mapErrorToStatusCode(errorCode: string): number | undefined {
    for (const module of this._modules.values()) {
      const status = module.mapErrorToStatusCode?.(errorCode);
      if (status !== undefined) {
        return status;
      }
    }
    return undefined;
  }
}
