import type { GenericMessage } from '../types/message-types.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ProtocolDefinition } from '../types/protocols-types.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

/**
 * One recorded validation-time state read: the reader method invoked.
 */
export type RecordedValidationRead = {
  method: keyof ValidationStateReader;
};

/**
 * A `ValidationStateReader` decorator that records every read before delegating to the wrapped
 * reader. Used by the replay-basis closure tests (and harnesses) to assert that admission
 * performs no validation read outside the read-set table, and to keep recorded read-traces as a
 * regression artifact when reads change.
 *
 * Inject via `DwnConfig.instrumentValidationStateReader`.
 */
export class RecordingValidationStateReader implements ValidationStateReader {
  private readonly recordedReads: RecordedValidationRead[] = [];

  public constructor(private readonly inner: ValidationStateReader) { }

  /** All reads recorded since construction or the last `clearRecordedReads()`. */
  public get reads(): RecordedValidationRead[] {
    return [...this.recordedReads];
  }

  /** Clears the recorded reads, e.g. between closure-test scenarios. */
  public clearRecordedReads(): void {
    this.recordedReads.length = 0;
  }

  /** @inheritdoc */
  public async fetchInitialRecordsWrite(tenant: string, recordId: string): Promise<RecordsWrite | undefined> {
    this.recordedReads.push({ method: 'fetchInitialRecordsWrite' });
    return this.inner.fetchInitialRecordsWrite(tenant, recordId);
  }

  /** @inheritdoc */
  public async fetchInitialWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage | undefined> {
    this.recordedReads.push({ method: 'fetchInitialWrite' });
    return this.inner.fetchInitialWrite(tenant, recordId);
  }

  /** @inheritdoc */
  public async constructRecordChain(tenant: string, descendantRecordId: string | undefined): Promise<RecordsWriteMessage[]> {
    this.recordedReads.push({ method: 'constructRecordChain' });
    return this.inner.constructRecordChain(tenant, descendantRecordId);
  }

  /** @inheritdoc */
  public async fetchParentRecord(input: {
    tenant: string;
    parentProtocolUri: string;
    parentId: string;
  }): Promise<RecordsWriteMessage | undefined> {
    this.recordedReads.push({ method: 'fetchParentRecord' });
    return this.inner.fetchParentRecord(input);
  }

  /** @inheritdoc */
  public async hasMatchingRoleRecord(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
  }): Promise<boolean> {
    this.recordedReads.push({ method: 'hasMatchingRoleRecord' });
    return this.inner.hasMatchingRoleRecord(input);
  }

  /** @inheritdoc */
  public async queryLatestRoleRecords(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage[]> {
    this.recordedReads.push({ method: 'queryLatestRoleRecords' });
    return this.inner.queryLatestRoleRecords(input);
  }

  /** @inheritdoc */
  public async fetchGrant(tenant: string, permissionGrantId: string): Promise<PermissionGrant> {
    this.recordedReads.push({ method: 'fetchGrant' });
    return this.inner.fetchGrant(tenant, permissionGrantId);
  }

  /** @inheritdoc */
  public async fetchOldestGrantRevocation(tenant: string, permissionGrantId: string): Promise<GenericMessage | undefined> {
    this.recordedReads.push({ method: 'fetchOldestGrantRevocation' });
    return this.inner.fetchOldestGrantRevocation(tenant, permissionGrantId);
  }

  /** @inheritdoc */
  public async fetchNewestRecordsWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage> {
    this.recordedReads.push({ method: 'fetchNewestRecordsWrite' });
    return this.inner.fetchNewestRecordsWrite(tenant, recordId);
  }

  /** @inheritdoc */
  public async getGoverningTimestamp(input: {
    tenant: string;
    recordId: string;
  }): Promise<string | undefined> {
    this.recordedReads.push({ method: 'getGoverningTimestamp' });
    return this.inner.getGoverningTimestamp(input);
  }

  /** @inheritdoc */
  public async fetchProtocolDefinition(tenant: string, protocolUri: string, messageTimestamp?: string): Promise<ProtocolDefinition> {
    this.recordedReads.push({ method: 'fetchProtocolDefinition' });
    return this.inner.fetchProtocolDefinition(tenant, protocolUri, messageTimestamp);
  }

  /** @inheritdoc */
  public async countLatestRecordsAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<number> {
    this.recordedReads.push({ method: 'countLatestRecordsAtScope' });
    return this.inner.countLatestRecordsAtScope(input);
  }

  /** @inheritdoc */
  public async fetchLatestSquashRecordAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage | undefined> {
    this.recordedReads.push({ method: 'fetchLatestSquashRecordAtScope' });
    return this.inner.fetchLatestSquashRecordAtScope(input);
  }

  /** @inheritdoc */
  public async hasStoredData(tenant: string, recordId: string, dataCid: string): Promise<boolean> {
    this.recordedReads.push({ method: 'hasStoredData' });
    return this.inner.hasStoredData(tenant, recordId, dataCid);
  }
}
