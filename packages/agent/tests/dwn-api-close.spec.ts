import type { Dwn } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { AgentDwnApi } from '../src/dwn-api.js';

describe('AgentDwnApi close()', () => {
  it('should release the owned wake publisher after closing the DWN stores', async () => {
    const order: string[] = [];
    const dwn = {
      close: sinon.stub().callsFake(async (): Promise<void> => { order.push('dwn'); }),
    } as unknown as Dwn;
    const wakePublisher = { close: (): void => { order.push('wake'); } };

    const dwnApi = new AgentDwnApi({ dwn, wakePublisher });
    await dwnApi.close();

    // The channel is released only after the stores that publish into it.
    expect(order).toEqual(['dwn', 'wake']);
  });

  it('should tolerate closing without an owned wake publisher', async () => {
    const dwn = { close: sinon.stub().resolves() } as unknown as Dwn;

    const dwnApi = new AgentDwnApi({ dwn });
    await expect(dwnApi.close()).resolves.toBeUndefined();
  });
});
