import type { KeyValues } from '../../src/types/query-types.js';
import type { MessageEvent } from '../../src/types/subscriptions.js';

import { EventEmitterStream } from '../../src/event-stream/event-emitter-stream.js';
import { TestDataGenerator } from '../../src/index.js';

import sinon from 'sinon';
import { afterAll, describe, expect, it } from 'bun:test';

describe('EventEmitterStream', () => {
  afterAll(() => {
    sinon.restore();
  });

  it('should deliver events to subscribers', async () => {
    const eventStream = new EventEmitterStream();
    await eventStream.open();

    const received: { tenant: string; event: MessageEvent; indexes: KeyValues }[] = [];
    await eventStream.subscribe('did:alice', 'sub-1', (tenant: string, event: MessageEvent, indexes: KeyValues): void => {
      received.push({ tenant, event, indexes });
    });

    const message = await TestDataGenerator.generateRecordsWrite({});
    eventStream.emit('did:alice', { message: message.message }, { key: 'value' });

    expect(received.length).toBe(1);
    expect(received[0].tenant).toBe('did:alice');
    expect(received[0].event.message).toBe(message.message);
    expect(received[0].indexes).toEqual({ key: 'value' });

    await eventStream.close();
  });

  it('should remove a single listener when subscription.close() is called', async () => {
    const eventStream = new EventEmitterStream();
    await eventStream.open();

    let callCount = 0;
    const sub = await eventStream.subscribe('did:alice', 'sub-1', (): void => { callCount++; });

    const message = await TestDataGenerator.generateRecordsWrite({});
    eventStream.emit('did:alice', { message: message.message }, {});
    expect(callCount).toBe(1);

    // close the subscription — listener should no longer fire
    await sub.close();
    eventStream.emit('did:alice', { message: message.message }, {});
    expect(callCount).toBe(1);

    await eventStream.close();
  });

  it('should remove all listeners when eventStream.close() is called', async () => {
    const eventStream = new EventEmitterStream();
    await eventStream.open();

    let aliceCount = 0;
    let bobCount = 0;
    await eventStream.subscribe('did:alice', 'sub-1', (): void => { aliceCount++; });
    await eventStream.subscribe('did:bob', 'sub-2', (): void => { bobCount++; });

    const message = await TestDataGenerator.generateRecordsWrite({});
    eventStream.emit('did:alice', { message: message.message }, {});
    eventStream.emit('did:bob', { message: message.message }, {});
    expect(aliceCount).toBe(1);
    expect(bobCount).toBe(1);

    // close stream — all listeners removed
    await eventStream.close();

    // re-open to allow emit without triggering error handler
    await eventStream.open();
    eventStream.emit('did:alice', { message: message.message }, {});
    eventStream.emit('did:bob', { message: message.message }, {});
    expect(aliceCount).toBe(1);
    expect(bobCount).toBe(1);

    await eventStream.close();
  });

  it('should call error handler when the stream is closed', async () => {
    const testHandler = {
      errorHandler: (_: any): void => {},
    };
    const eventErrorSpy = sinon.spy(testHandler, 'errorHandler');

    const eventStream = new EventEmitterStream({ errorHandler: testHandler.errorHandler });

    const message = await TestDataGenerator.generateRecordsWrite({});
    eventStream.emit('did:alice', { message: message.message }, {});
    expect(eventErrorSpy.callCount).toBe(1);
  });

  it('does not emit messages if event stream is closed', async () => {
    const testHandler = {
      errorHandler: (_: any): void => {},
    };
    const eventErrorSpy = sinon.spy(testHandler, 'errorHandler');

    const eventStream = new EventEmitterStream({ errorHandler: testHandler.errorHandler });

    let callCount = 0;
    await eventStream.subscribe('did:alice', 'sub-1', (): void => { callCount++; });

    // open then close to remove all listeners
    await eventStream.open();
    await eventStream.close();

    const message1 = await TestDataGenerator.generateRecordsWrite({});
    eventStream.emit('did:alice', { message: message1.message }, {});
    const message2 = await TestDataGenerator.generateRecordsWrite({});
    eventStream.emit('did:alice', { message: message2.message }, {});

    // error handler called twice (once per emit while closed)
    expect(eventErrorSpy.callCount).toBe(2);

    // listener never called — stream is closed
    expect(callCount).toBe(0);
  });
});
