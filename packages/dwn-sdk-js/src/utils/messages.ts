import type { CoreProtocolRegistry } from '../core/core-protocol.js';
import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { MessagesFilter } from '../types/messages-types.js';

import { FilterUtility } from './filter.js';
import { normalizeProtocolUrl } from './url.js';
import { Records } from './records.js';
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
      // For example, the Permissions protocol injects a filter for grants/requests/revocations
      // tagged with the target protocol so they appear alongside that protocol's own records.
      if (coreProtocols !== undefined) {
        for (const coreProtocol of coreProtocols.all()) {
          const additionalFilter = coreProtocol.constructAdditionalMessageFilter?.(filter);
          if (additionalFilter !== undefined) {
            messagesQueryFilters.push(additionalFilter);
          }
        }
      }

      messagesQueryFilters.push(this.convertFilter(filter));

      // When protocolPathPrefix is used with a protocol, inject a shadow filter
      // for ProtocolsConfigure events. Without this, protocol metadata updates
      // would be excluded (ProtocolsConfigure indexes have no protocolPath).
      // This mirrors the existing core-protocol additional-filter pattern above.
      // The messageTimestamp constraint is carried over so time-bounded queries
      // (including cursor-based subscriptions) also apply to the shadow filter.
      if ((filter.protocolPathPrefix !== undefined || filter.contextIdPrefix !== undefined) && filter.protocol !== undefined) {
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

        messagesQueryFilters.push(metadataFilter);
      }
    }

    return messagesQueryFilters;
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

    // Convert protocolPathPrefix into a protocolPath range filter.
    // The range gte: prefix, lt: prefix + '/\uffff' matches:
    //   - exact: 'post' (prefix itself)
    //   - children: 'post/attachment', 'post/comment', etc.
    //   - NOT siblings: 'poster', 'postfix' (excluded because '/' < any alphanumeric)
    if (protocolPathPrefix !== undefined) {
      delete (filterCopy as any).protocolPathPrefix;
      filterCopy.protocolPath = {
        gte : protocolPathPrefix,
        lt  : protocolPathPrefix + '/\uffff',
      };
    }

    // Convert contextIdPrefix into a contextId range filter (same pattern).
    if (contextIdPrefix !== undefined) {
      delete (filterCopy as any).contextIdPrefix;
      filterCopy.contextId = {
        gte : contextIdPrefix,
        lt  : contextIdPrefix + '/\uffff',
      };
    }

    return filterCopy;
  }

  private static hasEncodedData(message: GenericMessage): message is StoredMessageWithEncodedData {
    return 'encodedData' in message && typeof message.encodedData === 'string';
  }
}
