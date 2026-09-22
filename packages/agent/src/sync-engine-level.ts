import type { EnboxPlatformAgent } from './types/agent.js';
import type { SyncEngineNextParams } from './sync-next/engine.js';

import { SyncEngineNext } from './sync-next/engine.js';

export type SyncEngineLevelParams = SyncEngineNextParams & {
  agent?: EnboxPlatformAgent;
};

/** Compatibility name for the watermark-based sync engine. */
export class SyncEngineLevel extends SyncEngineNext {
  public constructor({ agent, ...params }: SyncEngineLevelParams = {}) {
    super(params);
    if (agent !== undefined) {
      this.agent = agent;
    }
  }
}
