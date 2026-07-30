import type { AbstractLevel } from 'abstract-level';

import type { AudienceKeyDeliveryState } from './audience-key-delivery.js';
import type {
  AudienceKeyDeliveryStore,
  ReconcileAudienceKeyDeliveryProtocolParams,
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

  public async reconcileProtocol(
    params: ReconcileAudienceKeyDeliveryProtocolParams,
  ): Promise<AudienceKeyDeliveryState[]> {
    return this.runForScope(params.sourceDid, params.protocol, async (): Promise<AudienceKeyDeliveryState[]> => {
      // Keep the scan inside the scope lock so it cannot erase an outcome recorded after an older scan.
      const intents = await params.scan();
      const existing = await this.getForProtocol(params.sourceDid, params.protocol);
      const activeIds = new Set(intents.map(intent => intent.roleRecordId));
      const states = new Map(existing.map(state => [state.roleRecordId, state]));
      const operations: Array<{ type: 'put'; key: string; value: string } | { type: 'del'; key: string }> = [];

      for (const intent of intents) {
        if (!states.has(intent.roleRecordId)) {
          const state = { ...intent, state: 'pending' as const };
          states.set(intent.roleRecordId, state);
          operations.push({ type: 'put', key: audienceKeyDeliveryProjectionKey(params.sourceDid, intent.roleRecordId), value: JSON.stringify(state) });
        }
      }

      for (const state of existing) {
        if (!activeIds.has(state.roleRecordId)) {
          states.delete(state.roleRecordId);
          operations.push({
            type : 'del',
            key  : audienceKeyDeliveryProjectionKey(params.sourceDid, state.roleRecordId),
          });
        }
      }

      if (operations.length > 0) {
        await this._states.batch(operations);
      }
      return [...states.values()];
    });
  }

  public async record(params: RecordAudienceKeyDeliveryParams): Promise<void> {
    const key = audienceKeyDeliveryProjectionKey(params.intent.sourceDid, params.intent.roleRecordId);
    await this.runForScope(params.intent.sourceDid, params.intent.protocol, async (): Promise<void> => {
      const next = recordAudienceKeyDeliveryProjection(await this.getEntry(key), params);
      if (next !== undefined) {
        await this._states.put(key, JSON.stringify(next));
      }
    });
  }

  private async getEntry(key: string): Promise<AudienceKeyDeliveryState | undefined> {
    try {
      return AudienceKeyDeliveryStoreLevel.parseEntry(await this._states.get(key));
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  private async getForProtocol(sourceDid: string, protocol: string): Promise<AudienceKeyDeliveryState[]> {
    const states: AudienceKeyDeliveryState[] = [];
    for await (const [, value] of this._states.iterator()) {
      const state = AudienceKeyDeliveryStoreLevel.parseEntry(value);
      if (state?.sourceDid === sourceDid && state.protocol === protocol) {
        states.push(state);
      }
    }
    return states;
  }

  private static parseEntry(value: string): AudienceKeyDeliveryState | undefined {
    try {
      return JSON.parse(value) as AudienceKeyDeliveryState;
    } catch {
      return undefined;
    }
  }

  private runForScope<T>(sourceDid: string, protocol: string, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([sourceDid, protocol]);
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
