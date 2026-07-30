import type { AbstractLevel } from 'abstract-level';

import type { AudienceKeyDeliveryState } from './audience-key-delivery.js';
import type {
  AudienceKeyDeliveryStore,
  RecordAudienceKeyDeliveryParams,
} from './audience-key-delivery-store.js';

import { Level } from 'level';
import { runSerializedByKey, runWithCrossContextLock } from '@enbox/common';

import {
  audienceKeyDeliveryProjectionKey,
  recordAudienceKeyDeliveryProjection,
} from './audience-key-delivery-store.js';

type LevelKey = string | Buffer | Uint8Array;

/** Level-backed audience-key delivery projection store. */
export class AudienceKeyDeliveryStoreLevel implements AudienceKeyDeliveryStore {
  private readonly _db: AbstractLevel<LevelKey>;
  private readonly _lockNamespace: string;
  private readonly _pendingOperations = new Map<string, Promise<void>>();
  private readonly _states: AbstractLevel<LevelKey, string, string>;

  public constructor(location: string) {
    this._db = new Level<string, string>(location);
    this._lockNamespace = location;
    this._states = this._db.sublevel('audienceDeliveryProjections');
  }

  public async clear(): Promise<void> {
    await this.waitForPendingOperations();
    await this._states.clear();
  }

  public async close(): Promise<void> {
    await this.waitForPendingOperations();
    await this._db.close();
  }

  public async get(sourceDid: string, roleRecordId: string): Promise<AudienceKeyDeliveryState | undefined> {
    return this.getEntry(audienceKeyDeliveryProjectionKey(sourceDid, roleRecordId));
  }

  public async record(params: RecordAudienceKeyDeliveryParams): Promise<void> {
    const key = audienceKeyDeliveryProjectionKey(params.intent.sourceDid, params.intent.roleRecordId);
    await this.runForRole(key, async (): Promise<void> => {
      const next = recordAudienceKeyDeliveryProjection(await this.getEntry(key), params);
      if (next !== undefined) {
        await this._states.put(key, JSON.stringify(next));
      }
    });
  }

  private async getEntry(key: string): Promise<AudienceKeyDeliveryState | undefined> {
    try {
      return JSON.parse(await this._states.get(key)) as AudienceKeyDeliveryState;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND' || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  private runForRole<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return runSerializedByKey(
      this._pendingOperations,
      key,
      (): Promise<T> => runWithCrossContextLock(
        `enbox:audience-delivery:${this._lockNamespace}:${key}`,
        operation,
      ),
    );
  }

  private async waitForPendingOperations(): Promise<void> {
    while (this._pendingOperations.size > 0) {
      await Promise.all(this._pendingOperations.values());
    }
  }
}
