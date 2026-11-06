import type { CoreModuleRegistry } from '../core/core-module.js';
import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { MessagesFilter } from '../types/messages-types.js';

import { FilterUtility } from './filter.js';
import { normalizeModuleUrl } from './url.js';
import { Records } from './records.js';
import { Replication } from './replication.js';
import { isEmptyObject, removeUndefinedProperties } from '@enbox/common';

type StoredMessageWithEncodedData = GenericMessage & { encodedData?: string };


/**
 * Class containing Messages related utility methods.
 */
export class Messages {
  /**
   * Normalizes/fixes the formatting of the given filters (such as URLs) so that they provide a consistent search experience.
   */
  public static normalizeFilters(filters: MessagesFilter[]): MessagesFilter[] {

    const messagesQueryFilters: MessagesFilter[] = [];

    // normalize each filter, and only add non-empty filters to the returned array
    for (const filter of filters) {
      // normalize the module URL if it exists
      const module = filter.module === undefined ? undefined : normalizeModuleUrl(filter.module);

      const messagesFilter = {
        ...filter,
        module,
      };

      // remove any empty filter properties and do not add if empty
      removeUndefinedProperties(messagesFilter);
      if (!isEmptyObject(messagesFilter)) {
        messagesQueryFilters.push(messagesFilter);
      }
    }

    return messagesQueryFilters;
  }

  /**
   *  Converts an incoming array of MessagesFilter into an array of Filter usable by MessageLog.
   *
   * When a `CoreModuleRegistry` is provided, each registered core module's
   * `constructAdditionalMessageFilter` hook is invoked per filter. This replaces the previous
   * hardcoded permission-records shadow filter with a generic loop over all core modules.
   *
   * @param filters An array of MessagesFilter
   * @param coreModules Optional registry of core modules whose additional filters are injected.
   * @param includeShadowFilters Whether to include module support-record filters.
   * @returns {Filter[]} an array of generic Filter able to be used when querying.
   */
  public static convertFilters(
    filters: MessagesFilter[],
    coreModules?: CoreModuleRegistry,
    includeShadowFilters = true,
  ): Filter[] {
    if (!includeShadowFilters) {
      return filters.map(filter => this.convertFilter(filter));
    }

    const messagesQueryFilters: Filter[] = [];

    for (const filter of filters) {
      // Ask each core module whether it needs an additional shadow filter for this query.
      messagesQueryFilters.push(...this.constructCoreModuleFilters(filter, coreModules));

      messagesQueryFilters.push(this.convertFilter(filter));

      // When a module path or context scope is used with a module, inject a shadow filter for ModulesConfigure events.
      const metadataFilter = this.constructModuleConfigureShadowFilter(filter);
      if (metadataFilter !== undefined) {
        messagesQueryFilters.push(metadataFilter);
      }
    }

    return messagesQueryFilters;
  }

  /**
   * Asks each core module whether it needs an additional shadow filter for the given query filter.
   * For example, the Permissions module injects a filter for grants/requests/revocations
   * tagged with the target module so they appear alongside that module's own records.
   */
  private static constructCoreModuleFilters(filter: MessagesFilter, coreModules?: CoreModuleRegistry): Filter[] {
    if (coreModules === undefined) {
      return [];
    }

    const additionalFilters: Filter[] = [];
    for (const coreModule of coreModules.all()) {
      const additionalFilter = coreModule.constructAdditionalMessageFilter?.(filter);
      if (additionalFilter !== undefined) {
        additionalFilters.push(additionalFilter);
      }
    }

    return additionalFilters;
  }

  /**
   * When modulePath, modulePathPrefix, or contextIdPrefix is used with a module, constructs a shadow filter
   * for ModulesConfigure events. Without this, module metadata updates would be excluded
   * (ModulesConfigure indexes have no modulePath). This mirrors the core-module additional-filter
   * pattern above. The messageTimestamp constraint is carried over so time-bounded queries
   * (including cursor-based subscriptions) also apply to the shadow filter.
   */
  private static constructModuleConfigureShadowFilter(filter: MessagesFilter): Filter | undefined {
    if (
      (filter.modulePath === undefined && filter.modulePathPrefix === undefined && filter.contextIdPrefix === undefined)
      || filter.module === undefined
    ) {
      return undefined;
    }

    const metadataFilter: Filter = {
      interface : 'Modules',
      method    : 'Configure',
      module    : filter.module,
    };

    if (filter.messageTimestamp !== undefined) {
      const timestampFilter = FilterUtility.convertRangeCriterion(filter.messageTimestamp);
      if (timestampFilter) {
        metadataFilter.messageTimestamp = timestampFilter;
      }
    }

    return metadataFilter;
  }

  /**
   * Maps a filter set onto the replication fingerprint domains it covers, or
   * `undefined` when the filters do not correspond to fingerprint domains.
   * An empty filter set covers the global domain; a set of module-only
   * filters covers each module's domain plus its tagged core-module
   * domains. Any other filter shape has no domain mapping.
   */
  public static computeFingerprintScopes(filters: MessagesFilter[]): string[] | undefined {
    if (filters.length === 0) {
      return [Replication.globalDomain];
    }

    const modules = new Set<string>();
    for (const filter of filters) {
      const keys = Object.keys(filter);
      if (keys.length !== 1 || typeof filter.module !== 'string') {
        return undefined;
      }

      modules.add(filter.module);
    }

    // Fail closed for filter sets naming a core module directly: the core
    // modules contribute no tagged domains for themselves, so the domain
    // set would not span everything such filters enumerate — two feeds could
    // fingerprint identically while differing in enumerable messages. No
    // fingerprint beats one whose coverage is known-incomplete.
    for (const module of modules) {
      if (Replication.isCoreModuleUri(module)) {
        return undefined;
      }
    }

    const scopes: string[] = [];
    for (const module of modules) {
      scopes.push(
        Replication.moduleDomain(module),
        ...Replication.taggedCoreModuleDomains(module, modules),
      );
    }

    return scopes;
  }

  /**
   * Returns a copy of a RecordsWrite message without inline encodedData, and the
   * detached encodedData value for wire surfaces that carry data beside the message.
   */
  public static detachEncodedData(message: GenericMessage): { message: GenericMessage; encodedData?: string } {
    if (!Records.isRecordsWrite(message) || !Messages.hasEncodedData(message)) {
      return { message };
    }

    const messageWithoutEncodedData: StoredMessageWithEncodedData = { ...message };
    const { encodedData } = messageWithoutEncodedData;
    delete messageWithoutEncodedData.encodedData;

    return { message: messageWithoutEncodedData, encodedData };
  }

  /**
   * Converts an external-facing filter model into an internal-facing filer model used by data store.
   */
  private static convertFilter(filter: MessagesFilter): Filter {
    const filterCopy = { ...filter } as Filter;

    const { messageTimestamp, modulePathPrefix, contextIdPrefix } = filter;
    const messageTimestampFilter = messageTimestamp ? FilterUtility.convertRangeCriterion(messageTimestamp) : undefined;
    if (messageTimestampFilter) {
      filterCopy.messageTimestamp = messageTimestampFilter;
      delete filterCopy.dateUpdated;
    }

    // Convert modulePathPrefix into a segment-aware modulePath subtree filter.
    if (modulePathPrefix !== undefined) {
      delete (filterCopy as any).modulePathPrefix;
      filterCopy.modulePath = { subtree: modulePathPrefix };
    }

    // Convert contextIdPrefix into the same segment-aware subtree filter.
    if (contextIdPrefix !== undefined) {
      delete (filterCopy as any).contextIdPrefix;
      filterCopy.contextId = { subtree: contextIdPrefix };
    }

    return filterCopy;
  }

  private static hasEncodedData(message: GenericMessage): message is StoredMessageWithEncodedData {
    return 'encodedData' in message && typeof message.encodedData === 'string';
  }
}
