import type { Filter } from '../types/query-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { ProtocolsConfigureMessage } from '../types/protocols-types.js';

import { SortDirection } from '../types/query-types.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

/**
 * Queries the stored `ProtocolsConfigure` message active at the given timestamp — the latest
 * configuration when no timestamp is given — newest first.
 *
 * When no configuration predates the timestamp, falls back to the earliest retained
 * configuration: a record can be authored before the protocol's earliest retained config yet
 * still have been admitted under that config, because admission order, not timestamp order,
 * governed the source. A protocol that is genuinely not installed has zero configurations and
 * returns `undefined`.
 */
export async function queryProtocolConfigure(
  messageStore: MessageStore,
  tenant: string,
  protocol: string,
  messageTimestamp?: string,
): Promise<ProtocolsConfigureMessage | undefined> {
  const filter: Filter = {
    interface : DwnInterfaceName.Protocols,
    method    : DwnMethodName.Configure,
    protocol,
  };

  if (messageTimestamp === undefined) {
    filter.isLatestBaseState = true;
  } else {
    filter.messageTimestamp = { lte: messageTimestamp };
  }

  let { messages } = await messageStore.query(
    tenant,
    [filter],
    { messageTimestamp: SortDirection.Descending },
    { limit: 1 },
  );

  if (messages.length === 0 && messageTimestamp !== undefined) {
    ({ messages } = await messageStore.query(
      tenant,
      [{
        interface : DwnInterfaceName.Protocols,
        method    : DwnMethodName.Configure,
        protocol,
      }],
      { messageTimestamp: SortDirection.Ascending },
      { limit: 1 },
    ));
  }

  return messages[0] as ProtocolsConfigureMessage | undefined;
}
