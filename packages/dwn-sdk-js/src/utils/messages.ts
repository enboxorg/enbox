import type { CoreProtocolRegistry } from '../core/core-protocol.js';
import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { MessagesFilter } from '../types/messages-types.js';

import { FilterUtility } from './filter.js';
import { normalizeProtocolUrl } from './url.js';
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
      // normalize the protocol URL if it exists
      const protocol = filter.protocol === undefined ? undefined : normalizeProtocolUrl(filter.protocol);

      const messagesFilter = {
        ...filter,
        protocol,
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
   * When a `CoreProtocolRegistry` is provided, each registered core protocol's
   * `constructAdditionalMessageFilter` hook is invoked per filter. This replaces the previous
   * hardcoded permission-records shadow filter with a generic loop over all core protocols.
   *
   * @param filters An array of MessagesFilter
   * @param coreProtocols Optional registry of core protocols whose additional filters are injected.
   * @returns {Filter[]} an array of generic Filter able to be used when querying.
   */
  public static convertFilters(filters: MessagesFilter[], coreProtocols?: CoreProtocolRegistry): Filter[] {

    const messagesQueryFilters: Filter[] = [];

    for (const filter of filters) {
      // Ask each core protocol whether it needs an additional shadow filter for this query.
      messagesQueryFilters.push(...this.constructCoreProtocolFilters(filter, coreProtocols));

      messagesQueryFilters.push(this.convertFilter(filter));

      // When protocolPathPrefix is used with a protocol, inject a shadow filter for ProtocolsConfigure events.
      const metadataFilter = this.constructProtocolConfigureShadowFilter(filter);
      if (metadataFilter !== undefined) {
        messagesQueryFilters.push(metadataFilter);
      }
    }

    return messagesQueryFilters;
  }

  /**
   * Asks each core protocol whether it needs an additional shadow filter for the given query filter.
   * For example, the Permissions protocol injects a filter for grants/requests/revocations
   * tagged with the target protocol so they appear alongside that protocol's own records.
   */
  private static constructCoreProtocolFilters(filter: MessagesFilter, coreProtocols?: CoreProtocolRegistry): Filter[] {
    if (coreProtocols === undefined) {
      return [];
    }

    const additionalFilters: Filter[] = [];
    for (const coreProtocol of coreProtocols.all()) {
      const additionalFilter = coreProtocol.constructAdditionalMessageFilter?.(filter);
      if (additionalFilter !== undefined) {
        additionalFilters.push(additionalFilter);
      }
    }

    return additionalFilters;
  }

  /**
   * When protocolPathPrefix or contextIdPrefix is used with a protocol, constructs a shadow filter
   * for ProtocolsConfigure events. Without this, protocol metadata updates would be excluded
   * (ProtocolsConfigure indexes have no protocolPath). This mirrors the core-protocol additional-filter
   * pattern above. The messageTimestamp constraint is carried over so time-bounded queries
   * (including cursor-based subscriptions) also apply to the shadow filter.
   */
  private static constructProtocolConfigureShadowFilter(filter: MessagesFilter): Filter | undefined {
    if ((filter.protocolPathPrefix === undefined && filter.contextIdPrefix === undefined) || filter.protocol === undefined) {
      return undefined;
    }

    const metadataFilter: Filter = {
      interface : 'Protocols',
      method    : 'Configure',
      protocol  : filter.protocol,
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
   * An empty filter set covers the global domain; a set of protocol-only
   * filters covers each protocol's domain plus its tagged core-protocol
   * domains. Any other filter shape has no domain mapping.
   */
  public static computeFingerprintScopes(filters: MessagesFilter[]): string[] | undefined {
    if (filters.length === 0) {
      return [Replication.globalDomain];
    }

    const protocols = new Set<string>();
    for (const filter of filters) {
      const keys = Object.keys(filter);
      if (keys.length !== 1 || typeof filter.protocol !== 'string') {
        return undefined;
      }

      protocols.add(filter.protocol);
    }

    // Fail closed for filter sets naming a core protocol directly: the core
    // protocols contribute no tagged domains for themselves, so the domain
    // set would not span everything such filters enumerate — two feeds could
    // fingerprint identically while differing in enumerable messages. No
    // fingerprint beats one whose coverage is known-incomplete.
    for (const protocol of protocols) {
      if (Replication.isCoreProtocolUri(protocol)) {
        return undefined;
      }
    }

    const scopes: string[] = [];
    for (const protocol of protocols) {
      scopes.push(
        Replication.protocolDomain(protocol),
        ...Replication.taggedCoreProtocolDomains(protocol, protocols),
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

    const { messageTimestamp, protocolPathPrefix, contextIdPrefix } = filter;
    const messageTimestampFilter = messageTimestamp ? FilterUtility.convertRangeCriterion(messageTimestamp) : undefined;
    if (messageTimestampFilter) {
      filterCopy.messageTimestamp = messageTimestampFilter;
      delete filterCopy.dateUpdated;
    }

    // Convert protocolPathPrefix into a segment-aware protocolPath subtree filter.
    if (protocolPathPrefix !== undefined) {
      delete (filterCopy as any).protocolPathPrefix;
      filterCopy.protocolPath = { subtree: protocolPathPrefix };
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
