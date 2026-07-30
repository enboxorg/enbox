import type { AudienceKeyDeliveryStore } from '../src/audience-key-delivery-store.js';
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
    const audienceKeyDeliveryStore = {
      close: sinon.stub().callsFake(async (): Promise<void> => { order.push('delivery'); }),
    } as unknown as AudienceKeyDeliveryStore;

    const dwnApi = new AgentDwnApi({ audienceKeyDeliveryStore, dwn, wakePublisher });
    await dwnApi.close();

    // The channel is released only after the stores that publish into it.
    expect(order).toEqual(['dwn', 'wake', 'delivery']);
  });

  it('should tolerate closing without an owned wake publisher', async () => {
    const dwn = { close: sinon.stub().resolves() } as unknown as Dwn;

    const dwnApi = new AgentDwnApi({ dwn });
    await expect(dwnApi.close()).resolves.toBeUndefined();
  });

  it('should close delivery state when DWN shutdown fails', async () => {
    const dwn = { close: sinon.stub().rejects(new Error('DWN close failed')) } as unknown as Dwn;
    const deliveryClose = sinon.stub().resolves();
    const audienceKeyDeliveryStore = { close: deliveryClose } as unknown as AudienceKeyDeliveryStore;
    const dwnApi = new AgentDwnApi({ audienceKeyDeliveryStore, dwn });

    await expect(dwnApi.close()).rejects.toThrow('DWN close failed');
    expect(deliveryClose.calledOnce).toBe(true);
  });
});
