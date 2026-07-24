import type { Filter } from '../types/query-types.js';
import type { RecordLimitOccupancy } from '../types/message-store.js';
import type { RecordsCollectionVisibility } from './records-collection.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsCountMessage, RecordsCountReply } from '../types/records-types.js';

import { EncryptionControl } from '../core/encryption-control.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Records } from '../utils/records.js';
import { RecordsCount } from '../interfaces/records-count.js';
import { buildRecordsSnapshotFilters, resolveRecordsCollectionVisibility } from './records-collection.js';
import {
  countRecordsWithRecordLimitOccupancy,
  queryRecordsWithRecordLimitOccupancy,
  resolveRecordLimitOccupancy,
} from '../utils/record-limit-occupancy.js';

export class RecordsCountHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
  }: {tenant: string, message: RecordsCountMessage}): Promise<RecordsCountReply> {
    let recordsCount: RecordsCount;
    try {
      recordsCount = await RecordsCount.parse(message);
    } catch (error) {
      return messageReplyFromError(error, 400);
    }

    const requester = Message.getRequester(recordsCount.message);
    let visibility: RecordsCollectionVisibility;
    try {
      visibility = await resolveRecordsCollectionVisibility(tenant, recordsCount, this.deps);
    } catch (error) {
      return messageReplyFromError(error, 401);
    }

    const filters = buildRecordsSnapshotFilters(recordsCount, visibility);
    const recordLimit = await resolveRecordLimitOccupancy({
      validationStateReader : this.deps.validationStateReader,
      tenant,
      recordsFilter         : recordsCount.message.descriptor.filter,
      messageTimestamp      : recordsCount.message.descriptor.messageTimestamp,
    });

    const count = recordsCount.author === tenant && requester === tenant
      ? await this.countProjectedRecords(tenant, filters, recordLimit)
      : await this.countProjectedRecordsForRequester(tenant, recordsCount, requester, filters, recordLimit);

    return {
      status: { code: 200, detail: 'OK' },
      count,
    };
  }

  private async countProjectedRecords(
    tenant: string,
    filters: Filter[],
    recordLimit: RecordLimitOccupancy | undefined,
  ): Promise<number> {
    const totalCount = await countRecordsWithRecordLimitOccupancy({
      messageStore: this.deps.messageStore,
      tenant,
      filters,
      recordLimit,
    });

    const audienceFilters = EncryptionControl.buildAudienceRecordFilters(filters);
    if (audienceFilters.length === 0) {
      return totalCount;
    }

    const storedAudienceCount = await this.deps.messageStore.count(tenant, audienceFilters);
    if (storedAudienceCount === 0) {
      return totalCount;
    }

    const { messages } = await this.deps.messageStore.query(tenant, audienceFilters);
    const projectedAudienceMessages = await EncryptionControl.projectCurrentAudienceRecords({
      messageStore         : this.deps.messageStore,
      tenant,
      recordsWriteMessages : messages.filter(Records.isRecordsWrite),
      bypassFilters        : audienceFilters,
    });

    return totalCount - storedAudienceCount + projectedAudienceMessages.length;
  }

  private async countProjectedRecordsForRequester(
    tenant: string,
    recordsCount: RecordsCount,
    requester: string | undefined,
    filters: Filter[],
    recordLimit: RecordLimitOccupancy | undefined,
  ): Promise<number> {
    const controlFilters = Records.buildControlRecordsFilters(filters);
    if (controlFilters.length === 0) {
      return this.countProjectedRecords(tenant, filters, recordLimit);
    }

    const totalCount = await this.countProjectedRecords(tenant, filters, recordLimit);
    const controlCount = await this.countProjectedRecords(tenant, controlFilters, recordLimit);
    if (controlCount === 0) {
      return totalCount;
    }

    const { messages } = await queryRecordsWithRecordLimitOccupancy({
      messageStore : this.deps.messageStore,
      tenant,
      filters      : controlFilters,
      recordLimit,
    });
    const projectedMessages = await EncryptionControl.projectCurrentAudienceRecords({
      messageStore         : this.deps.messageStore,
      tenant,
      recordsWriteMessages : messages,
      bypassFilters        : controlFilters,
    });
    const visibleMessages = await EncryptionControl.filterVisibleControlRecords({
      tenant,
      incomingMessage       : recordsCount.message,
      requester,
      recordsWriteMessages  : projectedMessages,
      validationStateReader : this.deps.validationStateReader,
    });
    return totalCount - controlCount + visibleMessages.length;
  }
}
