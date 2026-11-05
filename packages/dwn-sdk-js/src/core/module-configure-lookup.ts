import type { Filter } from '../types/query-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { ModulesConfigureMessage } from '../types/modules-types.js';

import { SortDirection } from '../types/query-types.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

/**
 * Queries the stored `ModulesConfigure` message active at the given timestamp — the latest
 * configuration when no timestamp is given — newest first.
 *
 * When no configuration predates the timestamp, falls back to the earliest retained
 * configuration: a record can be authored before the module's earliest retained config yet
 * still have been admitted under that config, because admission order, not timestamp order,
 * governed the source. A module that is genuinely not installed has zero configurations and
 * returns `undefined`.
 */
export async function queryModuleConfigure(
  messageStore: MessageStore,
  tenant: string,
  module: string,
  messageTimestamp?: string,
): Promise<ModulesConfigureMessage | undefined> {
  const filter: Filter = {
    interface : DwnInterfaceName.Modules,
    method    : DwnMethodName.Configure,
    module,
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
        interface : DwnInterfaceName.Modules,
        method    : DwnMethodName.Configure,
        module,
      }],
      { messageTimestamp: SortDirection.Ascending },
      { limit: 1 },
    ));
  }

  return messages[0] as ModulesConfigureMessage | undefined;
}
