import type { RecordsCollectionVisibility } from './records-collection.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsQueryMessage, RecordsQueryReply } from '../types/records-types.js';

import { attachInitialWrites } from '../utils/initial-write-attachment.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { RecordsQuery } from '../interfaces/records-query.js';
import { authorizeRecordsCollection, queryVisibleRecordsPage } from './records-collection.js';

export class RecordsQueryHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
  }: {tenant: string, message: RecordsQueryMessage}): Promise<RecordsQueryReply> {
    let recordsQuery: RecordsQuery;
    try {
      recordsQuery = await RecordsQuery.parse(message);
    } catch (error) {
      return messageReplyFromError(error, 400);
    }

    let visibility: RecordsCollectionVisibility;
    try {
      ({ visibility } = await authorizeRecordsCollection(tenant, recordsQuery, this.deps));
    } catch (error) {
      return messageReplyFromError(error, 401);
    }

    const result = await queryVisibleRecordsPage({
      deps    : this.deps,
      tenant,
      request : recordsQuery,
      visibility,
    });

    // Attach the retained initial write to every entry that is not itself an initial write.
    const entries = await attachInitialWrites({
      messageStore  : this.deps.messageStore,
      tenant,
      recordsWrites : result.messages,
      operationName : 'RecordsQuery',
    });

    return {
      status : { code: 200, detail: 'OK' },
      entries,
      cursor : result.cursor,
    };
  }
}
