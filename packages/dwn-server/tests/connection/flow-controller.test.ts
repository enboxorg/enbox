import type { JsonRpcSuccessResponse } from '@enbox/dwn-clients';
import type { SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { DEFAULT_MAX_IN_FLIGHT, FlowController, MAX_BUFFER_SIZE } from '../../src/connection/flow-controller.js';

/** Helper to create a SubscriptionEvent message with a given cursor. */
function makeEvent(cursor: string): SubscriptionMessage {
  return {
    type  : 'event',
    cursor,
    event : { message: { descriptor: { interface: 'Records', method: 'Write' } } as any },
  };
}

/** Helper to create a SubscriptionEose message with a given cursor. */
function makeEose(cursor: string): SubscriptionMessage {
  return { type: 'eose', cursor };
}

/** Creates a FlowController with a collector array for sent responses. */
function createFc(
  maxInFlight: number,
  sent: JsonRpcSuccessResponse[],
  onOverflow: () => void = () => { /* no-op */ },
  subscriptionId = 'sub-1',
): FlowController {
  return new FlowController(
    subscriptionId,
    maxInFlight,
    (r) => {
      sent.push(r);
    },
    onOverflow,
  );
}

describe('FlowController', () => {
  describe('defaults', () => {
    it('should have a default maxInFlight of 32', () => {
      expect(DEFAULT_MAX_IN_FLIGHT).toBe(32);
    });

    it('should have a max buffer size of 1000', () => {
      expect(MAX_BUFFER_SIZE).toBe(1000);
    });
  });

  describe('push()', () => {
    it('should send events immediately when window has room', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(3, sent);

      fc.push(makeEvent('1'));
      fc.push(makeEvent('2'));

      expect(sent).toHaveLength(2);
      expect(sent[0].result.subscription.cursor).toBe('1');
      expect(sent[1].result.subscription.cursor).toBe('2');
      expect(fc.inFlightCount).toBe(2);
      expect(fc.bufferCount).toBe(0);
    });

    it('should buffer events when window is full', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(2, sent);

      fc.push(makeEvent('1'));
      fc.push(makeEvent('2'));
      fc.push(makeEvent('3'));
      fc.push(makeEvent('4'));

      expect(sent).toHaveLength(2);
      expect(fc.inFlightCount).toBe(2);
      expect(fc.bufferCount).toBe(2);
    });

    it('should handle EOSE messages the same as events', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(2, sent);

      fc.push(makeEvent('1'));
      fc.push(makeEose('2'));

      expect(sent).toHaveLength(2);
      expect(sent[1].result.subscription.type).toBe('eose');
      expect(fc.inFlightCount).toBe(2);
    });

    it('should not send after overflow closes the controller', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      let overflowed = false;
      const fc = createFc(1, sent, () => {
        overflowed = true;
      });

      // Send 1 (fills window)
      fc.push(makeEvent('1'));
      expect(sent).toHaveLength(1);

      // Buffer MAX_BUFFER_SIZE + 1 events to trigger overflow
      for (let i = 0; i <= MAX_BUFFER_SIZE; i++) {
        fc.push(makeEvent(String(i + 2)));
      }

      expect(overflowed).toBe(true);

      // After overflow, push should be a no-op
      const sentBefore = sent.length;
      fc.push(makeEvent('9999'));
      expect(sent).toHaveLength(sentBefore);
    });
  });

  describe('ack()', () => {
    it('should acknowledge events and flush buffered events', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(2, sent);

      fc.push(makeEvent('1'));
      fc.push(makeEvent('2'));
      fc.push(makeEvent('3'));
      fc.push(makeEvent('4'));
      fc.push(makeEvent('5'));

      // Window: [1, 2], Buffer: [3, 4, 5]
      expect(sent).toHaveLength(2);
      expect(fc.inFlightCount).toBe(2);
      expect(fc.bufferCount).toBe(3);

      // Ack cursor '2' — acknowledges both '1' and '2'
      fc.ack('2');

      // Window should now have [3, 4] from flush, Buffer: [5]
      expect(sent).toHaveLength(4);
      expect(sent[2].result.subscription.cursor).toBe('3');
      expect(sent[3].result.subscription.cursor).toBe('4');
      expect(fc.inFlightCount).toBe(2);
      expect(fc.bufferCount).toBe(1);
    });

    it('should handle acking the first cursor only', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(2, sent);

      fc.push(makeEvent('1'));
      fc.push(makeEvent('2'));
      fc.push(makeEvent('3'));

      // Ack only cursor '1'
      fc.ack('1');

      // One slot freed, one buffered event flushed
      expect(sent).toHaveLength(3);
      expect(sent[2].result.subscription.cursor).toBe('3');
      expect(fc.inFlightCount).toBe(2); // '2' and '3' still in flight
      expect(fc.bufferCount).toBe(0);
    });

    it('should ignore unknown cursors', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(2, sent);

      fc.push(makeEvent('1'));
      fc.push(makeEvent('2'));
      fc.push(makeEvent('3'));

      fc.ack('unknown');

      // Nothing should change
      expect(sent).toHaveLength(2);
      expect(fc.inFlightCount).toBe(2);
      expect(fc.bufferCount).toBe(1);
    });

    it('should handle acking all cursors at once', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(3, sent);

      fc.push(makeEvent('1'));
      fc.push(makeEvent('2'));
      fc.push(makeEvent('3'));

      // Ack the last cursor
      fc.ack('3');

      expect(fc.inFlightCount).toBe(0);
      expect(fc.bufferCount).toBe(0);
    });

    it('should be a no-op after overflow', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      let overflowed = false;
      const fc = createFc(1, sent, () => {
        overflowed = true;
      });

      fc.push(makeEvent('1'));
      for (let i = 0; i <= MAX_BUFFER_SIZE; i++) {
        fc.push(makeEvent(String(i + 2)));
      }

      expect(overflowed).toBe(true);

      const sentBefore = sent.length;
      fc.ack('1');
      expect(sent).toHaveLength(sentBefore);
    });

    it('should handle cumulative acks (ack last cursor in batch)', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(3, sent);

      // Push 6 events. Window: [1,2,3], Buffer: [4,5,6]
      for (let i = 1; i <= 6; i++) {
        fc.push(makeEvent(String(i)));
      }

      expect(sent).toHaveLength(3);
      expect(fc.bufferCount).toBe(3);

      // Cumulative ack up to cursor '3' — frees all 3 slots, flushes 3 buffered
      fc.ack('3');
      expect(sent).toHaveLength(6);
      expect(fc.inFlightCount).toBe(3);
      expect(fc.bufferCount).toBe(0);
    });
  });

  describe('JSON-RPC framing', () => {
    it('should wrap messages in JSON-RPC success responses with subscription id', () => {
      const sent: JsonRpcSuccessResponse[] = [];
      const fc = createFc(10, sent, undefined, 'sub-42');

      fc.push(makeEvent('abc'));

      expect(sent).toHaveLength(1);
      expect(sent[0].jsonrpc).toBe('2.0');
      expect(sent[0].id).toBe('sub-42');
      expect(sent[0].result.subscription.type).toBe('event');
      expect(sent[0].result.subscription.cursor).toBe('abc');
    });
  });
});
