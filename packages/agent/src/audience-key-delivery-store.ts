import type { AudienceKeyDeliveryOutcome } from './types/dwn.js';
import type { AudienceKeyDeliveryIntent, AudienceKeyDeliveryState } from './audience-key-delivery.js';

import { projectAudienceKeyDeliveryOutcome } from './audience-key-delivery.js';

export type RecordAudienceKeyDeliveryParams = Readonly<{
  intent: AudienceKeyDeliveryIntent;
  outcome: AudienceKeyDeliveryOutcome;
}>;

export type ReconcileAudienceKeyDeliveryModuleParams = Readonly<{
  module: string;
  scan: () => Promise<readonly AudienceKeyDeliveryIntent[]>;
  sourceDid: string;
}>;

export type AudienceKeyDeliveryChange = Readonly<Pick<AudienceKeyDeliveryIntent, 'module' | 'sourceDid'>>;

/** Internal persistence contract for reconstructable audience-key delivery state. */
export interface AudienceKeyDeliveryStore {
  clear(): Promise<void>;
  close(): Promise<void>;
  get(sourceDid: string, roleRecordId: string): Promise<AudienceKeyDeliveryState | undefined>;
  reconcileModule(params: ReconcileAudienceKeyDeliveryModuleParams): Promise<AudienceKeyDeliveryState[]>;
  record(params: RecordAudienceKeyDeliveryParams): Promise<void>;
  subscribe(listener: (change: AudienceKeyDeliveryChange) => void): () => void;
}

export function audienceKeyDeliveryProjectionKey(sourceDid: string, roleRecordId: string): string {
  return JSON.stringify([sourceDid, roleRecordId]);
}

export function recordAudienceKeyDeliveryProjection(
  existing: AudienceKeyDeliveryState | undefined,
  params: RecordAudienceKeyDeliveryParams,
): AudienceKeyDeliveryState | undefined {
  if (existing?.state === 'delivered') {
    return undefined;
  }

  return projectAudienceKeyDeliveryOutcome(params.intent, params.outcome);
}
