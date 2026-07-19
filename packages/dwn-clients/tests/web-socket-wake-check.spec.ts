import type { DwnSubscriptionHandler, DwnSubscriptionMessage } from '../src/dwn-rpc-types.js';
import type { GenericMessage, ProgressToken } from '@enbox/dwn-sdk-js';

import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { afterEach, describe, expect, it } from 'bun:test';

import { JsonRpcSocket } from '../src/json-rpc-socket.js';
import { WebSocketDwnRpcClient } from '../src/web-socket-clients.js';

const testDwnUrl = process.env.TEST_DWN_URL || 'http://localhost:3000';

type RaceHarnessConnection = {
  socket: JsonRpcSocket;
  subscriptions: Map<string, unknown>;
};

/**
 * Establishes one REAL subscription on `connection` against the live server,
 * seeds its cursor watermark as if events had been delivered, and returns the
 * caller-facing pieces: the stable subscription handle, the recorded
 * notifications, and the cursor-capturing resubscribe factory (optionally
 * gated so tests can hold a re-establishment in flight).
 */
async function establishSubscription(connection: RaceHarnessConnection, factoryGate?: Promise<void>): Promise<{
  factoryCursors: Array<ProgressToken | undefined>;
  received: DwnSubscriptionMessage[];
  seededCursor: ProgressToken;
  subscriptionHandle: { close: () => Promise<void> };
}> {
  const alice = await TestDataGenerator.generateDidKeyPersona();
  const factoryCursors: Array<ProgressToken | undefined> = [];
  const received: DwnSubscriptionMessage[] = [];
  const seededCursor: ProgressToken = { streamId: 's1', epoch: 'e1', position: '5', messageCid: 'cid-5' };

  const handler: DwnSubscriptionHandler = (message): void => { received.push(message); };
  const resubscribeFactory = async (cursor?: ProgressToken): Promise<GenericMessage> => {
    factoryCursors.push(cursor);
    if (factoryGate !== undefined) {
      await factoryGate;
    }
    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'foo/bar' },
    });
    return message;
  };

  const { message } = await TestDataGenerator.generateRecordsSubscribe({
    author : alice,
    filter : { schema: 'foo/bar' },
  });
  const reply = await (WebSocketDwnRpcClient as unknown as {
    subscriptionRequest(
      connection: unknown,
      target: string,
      message: GenericMessage,
      handler: DwnSubscriptionHandler,
      resubscribeFactory: (cursor?: ProgressToken) => Promise<GenericMessage>,
    ): Promise<{ status: { code: number }; subscription?: { close: () => Promise<void> } }>;
  }).subscriptionRequest(connection, alice.did, message, handler, resubscribeFactory);
  if (reply.status.code !== 200 || reply.subscription === undefined) {
    throw new Error(`test subscription failed: ${reply.status.code}`);
  }

  // Seed the cursor watermark as if events had been delivered.
  const tracked = [...connection.subscriptions.values()][0] as { lastCursor?: ProgressToken };
  tracked.lastCursor = seededCursor;

  return { factoryCursors, received, seededCursor, subscriptionHandle: reply.subscription };
}

/**
 * Seeds the client's process-wide connection pool with stub connections so
 * wake-triggered health checks can be verified without a live WebSocket server.
 */
function poolOf(client: typeof WebSocketDwnRpcClient): {
  connections: Map<string, unknown>;
  reconnectingSockets: Set<unknown>;
  ensureWakeListeners(): void;
  removeWakeListeners(): void;
} {
  return client as unknown as {
    connections: Map<string, unknown>;
    reconnectingSockets: Set<unknown>;
    ensureWakeListeners(): void;
    removeWakeListeners(): void;
  };
}

function stubConnection(onCheck: () => void): unknown {
  return {
    socket: {
      checkHealth : async (): Promise<boolean> => { onCheck(); return true; },
      close       : (): void => {},
    },
    subscriptions: new Map(),
  };
}

/** Waits until `condition` holds, failing the test after `timeoutMs`. */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor: ${label} not met in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Wake-event tests need a dispatchable global EventTarget (Bun and browsers have one). */
const canDispatchGlobalEvents = typeof globalThis.dispatchEvent === 'function';

describe('WebSocketDwnRpcClient wake health checks', () => {
  afterEach(async () => {
    await WebSocketDwnRpcClient.closeAllConnections();
  });

  it('should check every pooled connection on checkAllConnections()', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.connections.set('wss://a.example/', stubConnection((): void => { checked.push('a'); }));
    pool.connections.set('wss://b.example/', stubConnection((): void => { checked.push('b'); }));

    WebSocketDwnRpcClient.checkAllConnections();
    await Promise.resolve();

    expect(checked.sort()).toEqual(['a', 'b']);
  });

  it.skipIf(!canDispatchGlobalEvents)('should check pooled connections when the browser comes back online', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.connections.set('wss://wake.example/', stubConnection((): void => { checked.push('wake'); }));
    pool.ensureWakeListeners();

    globalThis.dispatchEvent(new Event('online'));
    await Promise.resolve();

    expect(checked).toEqual(['wake']);
  });

  it.skipIf(!canDispatchGlobalEvents)('should stop listening for wake events after closeAllConnections()', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.connections.set('wss://stale.example/', stubConnection((): void => { checked.push('stale'); }));
    pool.ensureWakeListeners();

    await WebSocketDwnRpcClient.closeAllConnections();
    pool.connections.set('wss://stale.example/', stubConnection((): void => { checked.push('stale'); }));

    globalThis.dispatchEvent(new Event('online'));
    await Promise.resolve();

    expect(checked).toEqual([]);
  });

  it('should health-check sockets that are reconnecting outside the pool', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    const reconnectingStub = {
      isClosedByUser : false,
      checkHealth    : async (): Promise<boolean> => { checked.push('reconnecting'); return false; },
      close          : (): void => {},
    };
    const closedStub = {
      isClosedByUser : true,
      checkHealth    : async (): Promise<boolean> => { checked.push('closed'); return false; },
      close          : (): void => {},
    };
    pool.reconnectingSockets.add(reconnectingStub);
    pool.reconnectingSockets.add(closedStub);

    WebSocketDwnRpcClient.checkAllConnections();
    await Promise.resolve();

    // Reconnecting sockets are checked; user-closed strays are dropped, not checked.
    expect(checked).toEqual(['reconnecting']);
    expect(pool.reconnectingSockets.has(closedStub)).toBe(false);
  });

  it('should fast-forward reconnect backoff for a pool-evicted socket on a wake event', async () => {
    // Composed path over the real pool and a live server: an unexpected close
    // evicts the connection from the pool into the reconnecting registry; a
    // wake event must still reach it and interrupt its (deliberately huge)
    // backoff so reconnection happens now, re-registering it into the pool.
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';

    const client = new WebSocketDwnRpcClient();
    const pool = poolOf(WebSocketDwnRpcClient);
    const connection = await (client as unknown as {
      getConnection(url: string): Promise<{ socket: JsonRpcSocket }>;
    }).getConnection(dwnUrl.toString());
    expect(pool.connections.size).toBe(1);

    // Park any reconnect far beyond test time unless a wake fast-forwards it.
    const socketInternals = connection.socket as unknown as {
      options: { baseReconnectDelay?: number; maxReconnectDelay?: number };
      socket: WebSocket;
      reconnecting: boolean;
      _backoffWake?: () => void;
    };
    socketInternals.options.baseReconnectDelay = 600_000;
    socketInternals.options.maxReconnectDelay = 600_000;

    // Simulate an unexpected drop: evicted from the pool, parked in backoff.
    socketInternals.socket.close();
    await waitFor((): boolean => socketInternals.reconnecting && socketInternals._backoffWake !== undefined, 'reconnect parked in backoff');
    expect(pool.connections.size).toBe(0);
    expect(pool.reconnectingSockets.has(connection.socket)).toBe(true);

    // The wake path must reach the evicted socket and interrupt the backoff.
    WebSocketDwnRpcClient.checkAllConnections();
    await waitFor((): boolean => connection.socket.isConnected, 'socket reconnected after wake');
    await waitFor((): boolean => pool.connections.size === 1, 'connection re-pooled');
    expect(pool.reconnectingSockets.size).toBe(0);
  }, 10_000);

  it('should not resurrect a pooled connection when shutdown races an in-flight reconnect', async () => {
    // The shutdown race: a dropped socket is already past its backoff and
    // awaiting a fresh WebSocket when closeAllConnections() runs. The pending
    // establishment must not undo the shutdown — the fresh socket is
    // discarded and both the pool and the reconnecting registry stay empty.
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';

    const client = new WebSocketDwnRpcClient();
    const pool = poolOf(WebSocketDwnRpcClient);
    const connection = await (client as unknown as {
      getConnection(url: string): Promise<{ socket: JsonRpcSocket }>;
    }).getConnection(dwnUrl.toString());

    const socketInternals = connection.socket as unknown as {
      options: { baseReconnectDelay?: number; maxReconnectDelay?: number };
      socket: WebSocket;
    };
    socketInternals.options.baseReconnectDelay = 10;
    socketInternals.options.maxReconnectDelay = 10;

    // Gate reconnect establishment so shutdown can land mid-connect.
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const socketClass = JsonRpcSocket as unknown as {
      createWebSocket(url: string, timeout: number): Promise<WebSocket>;
    };
    const originalCreate = socketClass.createWebSocket;
    const createdSockets: WebSocket[] = [];
    let connectCalls = 0;
    socketClass.createWebSocket = async (url: string, timeout: number): Promise<WebSocket> => {
      connectCalls += 1;
      await connectGate;
      const socket = await originalCreate.call(JsonRpcSocket, url, timeout);
      createdSockets.push(socket);
      return socket;
    };

    try {
      // Unexpected drop: pool eviction, registry entry, gated establishment.
      socketInternals.socket.close();
      await waitFor((): boolean => connectCalls > 0, 'establishment gated');
      expect(pool.reconnectingSockets.has(connection.socket)).toBe(true);

      await WebSocketDwnRpcClient.closeAllConnections();
      expect(pool.connections.size).toBe(0);
      expect(pool.reconnectingSockets.size).toBe(0);

      // Releasing the pending establishment must not resurrect anything.
      releaseConnect();
      await waitFor((): boolean => createdSockets.length === 1, 'gated establishment released');
      await waitFor((): boolean => createdSockets[0].readyState >= WebSocket.CLOSING, 'discarded socket closed');

      expect(pool.connections.size).toBe(0);
      expect(pool.reconnectingSockets.size).toBe(0);
      expect(connection.socket.isConnected).toBe(false);
    } finally {
      socketClass.createWebSocket = originalCreate;
    }
  }, 10_000);

  it('should close a reconnected socket that lost its endpoint to a replacement connection', async () => {
    // Interleaving 1: the old socket's reconnect completes AFTER a request
    // already created a replacement for the endpoint. The replacement owns
    // the pool; the reconnected socket must close instead of overwriting it —
    // exactly one socket per endpoint survives.
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';

    const client = new WebSocketDwnRpcClient();
    const pool = poolOf(WebSocketDwnRpcClient);
    const getConnection = (client as unknown as {
      getConnection(url: string): Promise<{ socket: JsonRpcSocket }>;
    }).getConnection.bind(client);

    const first = await getConnection(dwnUrl.toString());
    const { factoryCursors, received, seededCursor, subscriptionHandle } =
      await establishSubscription(first as unknown as RaceHarnessConnection);
    const firstInternals = first.socket as unknown as {
      options: { baseReconnectDelay?: number; maxReconnectDelay?: number };
      socket: WebSocket;
    };
    firstInternals.options.baseReconnectDelay = 10;
    firstInternals.options.maxReconnectDelay = 10;

    // Gate only the FIRST establishment (the old socket's reconnect); the
    // replacement's own connect passes straight through.
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const socketClass = JsonRpcSocket as unknown as {
      createWebSocket(url: string, timeout: number): Promise<WebSocket>;
    };
    const originalCreate = socketClass.createWebSocket;
    let connectCalls = 0;
    socketClass.createWebSocket = async (url: string, timeout: number): Promise<WebSocket> => {
      connectCalls += 1;
      if (connectCalls === 1) {
        await connectGate;
      }
      return originalCreate.call(JsonRpcSocket, url, timeout);
    };

    try {
      // Unexpected drop: eviction + registry; reconnect parks in the gate.
      firstInternals.socket.close();
      await waitFor((): boolean => connectCalls === 1, 'first establishment gated');
      expect(pool.connections.size).toBe(0);

      // A request meanwhile creates the replacement, which takes the pool.
      const replacement = await getConnection(dwnUrl.toString());
      expect(pool.connections.size).toBe(1);
      expect(replacement.socket).not.toBe(first.socket);

      // The old socket's reconnect completes — and must lose the race,
      // handing its tracked subscription to the surviving connection.
      releaseConnect();
      await waitFor((): boolean => !first.socket.isConnected && pool.reconnectingSockets.size === 0, 'superseded socket closed');
      await waitFor((): boolean => (replacement as unknown as RaceHarnessConnection).subscriptions.size === 1, 'subscription adopted by winner');

      expect(pool.connections.size).toBe(1);
      expect(([...pool.connections.values()][0] as { socket: JsonRpcSocket }).socket).toBe(replacement.socket);
      expect(replacement.socket.isConnected).toBe(true);
      expect(first.socket.isConnected).toBe(false);

      // The subscription survived the handover: resumed exactly once from
      // the prior cursor, tracked by the winner, consumer told 'reconnected'.
      expect(factoryCursors).toEqual([seededCursor]);
      expect((first as unknown as RaceHarnessConnection).subscriptions.size).toBe(0);
      expect(received.some((message) => message.type === 'reconnected')).toBe(true);

      // The caller's ORIGINAL close handle still controls the logical
      // subscription after the handover — closing it empties the winner.
      await subscriptionHandle.close();
      expect((replacement as unknown as RaceHarnessConnection).subscriptions.size).toBe(0);
    } finally {
      socketClass.createWebSocket = originalCreate;
    }
  }, 10_000);

  it('should reuse a recovered connection instead of displacing it with a completing replacement', async () => {
    // Interleaving 2: the old socket reconnects and re-takes the pool while
    // the replacement is still being established. The recovered connection's
    // subscriptions are already live, so the replacement is discarded and its
    // waiting caller resolves with the recovered pooled connection — no
    // redundant resubscription, no duplicate reconnected notification.
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';

    const client = new WebSocketDwnRpcClient();
    const pool = poolOf(WebSocketDwnRpcClient);
    const getConnection = (client as unknown as {
      getConnection(url: string): Promise<{ socket: JsonRpcSocket }>;
    }).getConnection.bind(client);

    const first = await getConnection(dwnUrl.toString());
    const { factoryCursors, received, seededCursor, subscriptionHandle } =
      await establishSubscription(first as unknown as RaceHarnessConnection);
    const firstInternals = first.socket as unknown as {
      options: { baseReconnectDelay?: number; maxReconnectDelay?: number };
      socket: WebSocket;
    };
    // Slow enough that the replacement's establishment starts first.
    firstInternals.options.baseReconnectDelay = 200;
    firstInternals.options.maxReconnectDelay = 200;

    // Gate only the FIRST establishment (the replacement); the old socket's
    // reconnect passes straight through and re-takes the pool.
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const socketClass = JsonRpcSocket as unknown as {
      createWebSocket(url: string, timeout: number): Promise<WebSocket>;
    };
    const originalCreate = socketClass.createWebSocket;
    const createdSockets: WebSocket[] = [];
    let connectCalls = 0;
    socketClass.createWebSocket = async (url: string, timeout: number): Promise<WebSocket> => {
      connectCalls += 1;
      const gated = connectCalls === 1;
      if (gated) {
        await connectGate;
      }
      const socket = await originalCreate.call(JsonRpcSocket, url, timeout);
      if (gated) {
        createdSockets.push(socket);
      }
      return socket;
    };

    try {
      // Unexpected drop, then request the endpoint while the pool is empty.
      firstInternals.socket.close();
      await waitFor((): boolean => pool.connections.size === 0, 'pool evicted');
      const replacementPromise = getConnection(dwnUrl.toString());
      await waitFor((): boolean => connectCalls === 1, 'first establishment gated');

      // The old socket reconnects first, re-takes the pool, and resumes its
      // subscription from the prior cursor.
      await waitFor((): boolean => first.socket.isConnected && pool.connections.size === 1, 'old socket re-took pool');
      await waitFor((): boolean => factoryCursors.length === 1, 'seeded subscription resumed');
      expect(factoryCursors[0]).toEqual(seededCursor);
      await waitFor(
        (): boolean => (first as unknown as RaceHarnessConnection).subscriptions.size === 1,
        'resumed subscription re-registered',
      );

      // The completing replacement finds the endpoint recovered — it is
      // discarded and its caller resolves with the recovered connection.
      releaseConnect();
      const replacement = await replacementPromise;
      expect(replacement.socket).toBe(first.socket);
      expect(pool.connections.size).toBe(1);
      expect(first.socket.isConnected).toBe(true);
      expect(pool.reconnectingSockets.size).toBe(0);

      // The redundant replacement socket was closed, not pooled.
      await waitFor((): boolean => createdSockets.length === 1, 'redundant establishment released');
      await waitFor((): boolean => createdSockets[0].readyState >= WebSocket.CLOSING, 'redundant socket closed');

      // No adoption happened: the factory ran exactly once (the old socket's
      // own resume from the prior cursor) and 'reconnected' fired exactly once.
      expect(factoryCursors).toEqual([seededCursor]);
      expect(received.filter((message) => message.type === 'reconnected')).toHaveLength(1);

      // The caller's original close handle still controls the subscription.
      await subscriptionHandle.close();
      await waitFor(
        (): boolean => (first as unknown as RaceHarnessConnection).subscriptions.size === 0,
        'subscription closed via original handle',
      );
    } finally {
      socketClass.createWebSocket = originalCreate;
    }
  }, 10_000);

  it('should keep the original close handle valid across an ordinary reconnect', async () => {
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';

    const client = new WebSocketDwnRpcClient();
    const pool = poolOf(WebSocketDwnRpcClient);
    const connection = await (client as unknown as {
      getConnection(url: string): Promise<{ socket: JsonRpcSocket }>;
    }).getConnection(dwnUrl.toString());
    const { factoryCursors, received, seededCursor, subscriptionHandle } =
      await establishSubscription(connection as unknown as RaceHarnessConnection);

    const socketInternals = connection.socket as unknown as {
      options: { baseReconnectDelay?: number; maxReconnectDelay?: number };
      socket: WebSocket;
    };
    socketInternals.options.baseReconnectDelay = 10;
    socketInternals.options.maxReconnectDelay = 10;

    // Ordinary drop → auto-reconnect → resubscription from the prior cursor.
    socketInternals.socket.close();
    await waitFor((): boolean => received.some((message) => message.type === 'reconnected'), 'resubscribed after reconnect');
    expect(factoryCursors).toEqual([seededCursor]);
    await waitFor(
      (): boolean => (connection as unknown as RaceHarnessConnection).subscriptions.size === 1,
      'subscription re-registered',
    );

    // The ORIGINAL handle closes the CURRENT (re-established) subscription.
    await subscriptionHandle.close();
    expect((connection as unknown as RaceHarnessConnection).subscriptions.size).toBe(0);
    expect(pool.connections.size).toBe(1);
  }, 10_000);

  it('should not re-establish a subscription closed while its adoption is in flight', async () => {
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';

    const client = new WebSocketDwnRpcClient();
    const pool = poolOf(WebSocketDwnRpcClient);
    const getConnection = (client as unknown as {
      getConnection(url: string): Promise<{ socket: JsonRpcSocket }>;
    }).getConnection.bind(client);

    const first = await getConnection(dwnUrl.toString());
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => { releaseFactory = resolve; });
    const { factoryCursors, received, subscriptionHandle } =
      await establishSubscription(first as unknown as RaceHarnessConnection, factoryGate);
    const firstInternals = first.socket as unknown as {
      options: { baseReconnectDelay?: number; maxReconnectDelay?: number };
      socket: WebSocket;
    };
    firstInternals.options.baseReconnectDelay = 10;
    firstInternals.options.maxReconnectDelay = 10;

    // Gate the old socket's reconnect establishment so a replacement can pool.
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const socketClass = JsonRpcSocket as unknown as {
      createWebSocket(url: string, timeout: number): Promise<WebSocket>;
    };
    const originalCreate = socketClass.createWebSocket;
    let connectCalls = 0;
    socketClass.createWebSocket = async (url: string, timeout: number): Promise<WebSocket> => {
      connectCalls += 1;
      if (connectCalls === 1) {
        await connectGate;
      }
      return originalCreate.call(JsonRpcSocket, url, timeout);
    };

    try {
      firstInternals.socket.close();
      await waitFor((): boolean => connectCalls === 1, 'first establishment gated');
      const replacement = await getConnection(dwnUrl.toString());
      expect(replacement.socket).not.toBe(first.socket);

      // The old socket reconnects, loses the race, and starts adopting its
      // subscription — held in flight by the factory gate.
      releaseConnect();
      await waitFor((): boolean => factoryCursors.length === 1, 'adoption resubscription in flight');

      // The consumer closes the logical subscription mid-adoption.
      await subscriptionHandle.close();
      releaseFactory();

      // The adoption must observe the close and never re-establish: winner
      // stays empty, no 'reconnected' after the close.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect((replacement as unknown as RaceHarnessConnection).subscriptions.size).toBe(0);
      expect(received.filter((message) => message.type === 'reconnected')).toHaveLength(0);
      expect(pool.connections.size).toBe(1);
    } finally {
      socketClass.createWebSocket = originalCreate;
    }
  }, 10_000);

  it('should emit a terminal recovery error when adoption gets a failed subscribe reply', async () => {
    const received: DwnSubscriptionMessage[] = [];
    const tracked = {
      subscription      : { id: 'stub-sub', close: async (): Promise<void> => {} },
      target            : 'did:example:alice',
      message           : {} as GenericMessage,
      handler           : ((message): void => { received.push(message); }) as DwnSubscriptionHandler,
      lastCursor        : { streamId: 's1', epoch: 'e1', position: '5', messageCid: 'cid-5' },
      currentId         : 'stub-sub',
      currentConnection : { socket: {}, subscriptions: new Map(), url: 'wss://stub.example/' },
      currentClose      : async (): Promise<void> => {},
      closed            : false,
    };
    const winner = {
      socket: {
        subscribe: async (): Promise<unknown> => ({
          response : { jsonrpc: '2.0', id: 'id', result: { reply: { status: { code: 410, detail: 'Progress token gap' } } } },
          close    : async (): Promise<void> => {},
        }),
        send: (): void => {},
      },
      subscriptions : new Map(),
      url           : 'wss://stub.example/',
    };

    (WebSocketDwnRpcClient as unknown as {
      adoptSubscriptions(from: Map<string, unknown>, winner: unknown): void;
    }).adoptSubscriptions(new Map([['stub-sub', tracked]]), winner);

    await waitFor((): boolean => received.length === 1, 'terminal recovery error delivered');
    const [message] = received;
    expect(message.type).toBe('error');
    expect((message as { error: { code: string } }).error.code).toBe('SubscriptionRecoveryFailed');
    expect(received.some((entry) => entry.type === 'reconnected')).toBe(false);
    expect(winner.subscriptions.size).toBe(0);
    expect(tracked.closed).toBe(true);
  });

  it('should emit a terminal recovery error when adoption establishment throws', async () => {
    const received: DwnSubscriptionMessage[] = [];
    const tracked = {
      subscription      : { id: 'stub-sub', close: async (): Promise<void> => {} },
      target            : 'did:example:alice',
      message           : {} as GenericMessage,
      handler           : ((message): void => { received.push(message); }) as DwnSubscriptionHandler,
      currentId         : 'stub-sub',
      currentConnection : { socket: {}, subscriptions: new Map(), url: 'wss://stub.example/' },
      currentClose      : async (): Promise<void> => {},
      closed            : false,
    };
    const winner = {
      socket: {
        subscribe : async (): Promise<unknown> => { throw new Error('transport failed mid-adoption'); },
        send      : (): void => {},
      },
      subscriptions : new Map(),
      url           : 'wss://stub.example/',
    };

    (WebSocketDwnRpcClient as unknown as {
      adoptSubscriptions(from: Map<string, unknown>, winner: unknown): void;
    }).adoptSubscriptions(new Map([['stub-sub', tracked]]), winner);

    await waitFor((): boolean => received.length === 1, 'terminal recovery error delivered');
    const [message] = received;
    expect(message.type).toBe('error');
    expect((message as { error: { code: string } }).error.code).toBe('SubscriptionRecoveryFailed');
    expect(received.some((entry) => entry.type === 'reconnected')).toBe(false);
    expect(winner.subscriptions.size).toBe(0);
  });
});
