import { getRecordAuthor } from '@enbox/agent';
import type { DwnRecordSubscriptionHandler, PermissionsApi, Web5Agent } from '@enbox/agent';

import { Record } from './record.js';
import type { RecordsSubscribeRequest } from './dwn-api.js';

/**
 * Utility class for dealing with subscriptions.
 */
export class SubscriptionUtil {
  /**
   * Creates a record subscription handler that can be used to process incoming {Record} messages.
   */
  static recordSubscriptionHandler({ agent, connectedDid, request, delegateDid, protocolRole, permissionsApi }:{
    agent: Web5Agent;
    connectedDid: string;
    delegateDid?: string;
    protocolRole?: string;
    permissionsApi?: PermissionsApi;
    request: RecordsSubscribeRequest;
  }): DwnRecordSubscriptionHandler {
    const { subscriptionHandler, from: remoteOrigin } = request;

    return async (event) => {
      const { message, initialWrite } = event;
      const author = getRecordAuthor(message);
      const recordOptions = {
        author,
        connectedDid,
        remoteOrigin,
        initialWrite
      };

      const record = new Record(agent, {
        ...message,
        ...recordOptions,
        protocolRole,
        delegateDid: delegateDid,
      }, permissionsApi);

      subscriptionHandler(record);
    };
  }
}