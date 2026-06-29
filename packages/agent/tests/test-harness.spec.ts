import path from 'node:path';
import sinon from 'sinon';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import type { BearerDid } from '@enbox/dids';
import type { DerivedPrivateJwk } from '@enbox/dwn-sdk-js';

import { KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

/**
 * End-to-end unit tests for the `PlatformAgentTestHarness` teardown drain.
 *
 * Validation contract: VAL-HARNESS-001 through VAL-HARNESS-006.
 *
 * The tests exercise the harness's public teardown methods (`clearStorage()`
 * and `closeStorage()`) end-to-end with a real agent, a real agent DID, and
 * targeted stubs on `AgentDwnApi` internals to control the fire-and-forget
 * eager-send timing deterministically. The private `_pendingEagerSends` Set
 * is never inspected directly — verification is black-box via observable
 * behavior of `drainPendingEagerSends()`, `agent.agentDid` visibility,
 * and probe reads against the DWN stores.
 */

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej): void => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Races a promise against a macrotask sentinel. Returns `'settled'` when the
 * promise already resolved (microtask beats macrotask), `'tick'` when the
 * promise is still pending by the time the sentinel fires.
 */
async function raceAgainstTick<T>(
  p: Promise<T>,
  timeoutMs: number = 0,
): Promise<'settled' | 'tick'> {
  const TICK = 'tick' as const;
  return Promise.race<'settled' | 'tick'>([
    p.then((): 'settled' => 'settled', (): 'settled' => 'settled'),
    new Promise<'tick'>((resolve): void => {
      setTimeout((): void => resolve(TICK), timeoutMs);
    }),
  ]);
}

const mockContextKeyData: DerivedPrivateJwk = {
  rootKeyId         : 'root-1',
  derivationScheme  : KeyDerivationScheme.ProtocolPath,
  derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://proto.example.com'],
  derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
};

const baseWriteParams = {
  tenantDid       : 'did:example:alice',
  recipientDid    : 'did:example:bob',
  contextKeyData  : mockContextKeyData,
  sourceProtocol  : 'https://proto.example.com',
  sourceContextId : 'ctx-1',
};

/**
 * Stubs the `AgentDwnApi` internals used by `writeContextKeyRecord` so that
 * the local write succeeds with a fake `recordId` and the eager-send
 * resolves according to `eagerSendResult`.
 */
function stubEagerSendOnDwnApi(
  harness: PlatformAgentTestHarness,
  eagerSendResult: Promise<void>,
): void {
  sinon.stub(harness.agent.dwn as any, 'processRequest').resolves({
    reply      : { status: { code: 202, detail: 'Accepted' } },
    message    : { recordId: 'rec-stub-1' },
    messageCid : 'cid-stub-1',
  });
  sinon.stub(harness.agent.dwn as any, 'ensureKeyDeliveryProtocol').resolves();
  sinon.stub(harness.agent.dwn as any, 'eagerSendContextKeyRecord').returns(eagerSendResult);
}

async function setupHarnessWithAgentDid(
  testDataLocation: string,
): Promise<PlatformAgentTestHarness> {
  const harness = await PlatformAgentTestHarness.setup({
    agentClass  : TestAgent,
    agentStores : 'memory',
    testDataLocation,
  });
  await harness.createAgentDid();
  return harness;
}

async function safeCleanup(harness: PlatformAgentTestHarness): Promise<void> {
  try { await harness.clearStorage(); } catch { /* already cleared/closed */ }
  try { await harness.closeStorage(); } catch { /* already closed */ }
}

describe('PlatformAgentTestHarness.clearStorage drain', () => {
  afterEach((): void => {
    sinon.restore();
  });

  it('should drain pending eager sends before nullifying agent.agentDid (VAL-HARNESS-001)', async () => {
    const harness = await setupHarnessWithAgentDid('__TESTDATA__/harness-drain-001');
    try {
      const originalAgentDidUri = harness.agent.agentDid.uri;
      const deferred = createDeferred<void>();
      stubEagerSendOnDwnApi(harness, deferred.promise);

      await harness.agent.dwn.writeContextKeyRecord(baseWriteParams);

      // Start clearStorage without awaiting.
      const clearPromise = harness.clearStorage();

      // While the drain is blocked on the deferred, clearStorage must NOT resolve.
      expect(await raceAgainstTick(clearPromise, 30)).toBe('tick');

      // AgentDid is still defined because the drain runs BEFORE the
      // `agent.agentDid = undefined` line in clearStorage().
      expect(harness.agent.agentDid.uri).toBe(originalAgentDidUri);

      // Resolve the deferred → drain completes → clearStorage proceeds.
      deferred.resolve();
      await clearPromise;

      // After clearStorage resolves, agentDid should be undefined and the
      // TestAgent getter throws when accessed.
      expect((): BearerDid => harness.agent.agentDid).toThrow('TestAgent: Agent DID is not set');
    } finally {
      await safeCleanup(harness);
    }
  }, 30000);

  it('should be a fast no-op when zero eager sends are pending (VAL-HARNESS-003)', async () => {
    const harness = await setupHarnessWithAgentDid('__TESTDATA__/harness-drain-003');
    try {
      const startMs = Date.now();
      await harness.clearStorage();
      const elapsedMs = Date.now() - startMs;
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      await safeCleanup(harness);
    }
  }, 30000);

  it('should be safe to call twice in succession (VAL-HARNESS-004)', async () => {
    const harness = await setupHarnessWithAgentDid('__TESTDATA__/harness-drain-004');
    try {
      await harness.clearStorage();
      // Second call must not throw — stores are already cleared, agentDid is
      // already undefined, tracker is empty. The drain fast-paths.
      await expect(harness.clearStorage()).resolves.toBeUndefined();
    } finally {
      await safeCleanup(harness);
    }
  }, 30000);

  it('should emit the eager-send rejection console.warn before clearStorage resolves (VAL-HARNESS-006)', async () => {
    const harness = await setupHarnessWithAgentDid('__TESTDATA__/harness-drain-006');
    try {
      // Capture console.warn to verify the observability contract holds during drain.
      const warnStub = sinon.stub(console, 'warn');

      // The eager-send rejects with a deterministic error message. The .catch
      // handler in dwn-key-delivery.ts wraps the rejection and logs a warn.
      stubEagerSendOnDwnApi(harness, Promise.reject(new Error('network down')));

      await harness.agent.dwn.writeContextKeyRecord(baseWriteParams);

      // Record whether console.warn fired BEFORE clearStorage resolved. The
      // callback chained to clearStorage reads warnStub.called at the moment
      // of resolution.
      let warnAlreadyFiredWhenClearResolved = false;
      await harness.clearStorage().then((): void => {
        warnAlreadyFiredWhenClearResolved = warnStub.called;
      });

      expect(warnAlreadyFiredWhenClearResolved).toBe(true);

      // The recorded warn message must match the verbatim observability contract.
      const expectedPattern = new RegExp(
        'AgentDwnApi: Eager send of contextKey record \'.*\' to remote DWN '
        + 'failed: network down\\. Sync will deliver it later\\.',
      );
      const matched = warnStub.args.find(
        (args: unknown[]): boolean =>
          typeof args[0] === 'string' && expectedPattern.test(args[0] as string),
      );
      expect(matched).toBeDefined();
    } finally {
      await safeCleanup(harness);
    }
  }, 30000);
});

describe('PlatformAgentTestHarness.closeStorage drain', () => {
  afterEach((): void => {
    sinon.restore();
  });

  it('should drain pending eager sends before closing LevelDB handles (VAL-HARNESS-002)', async () => {
    const harness = await setupHarnessWithAgentDid('__TESTDATA__/harness-drain-002');
    try {
      const deferred = createDeferred<void>();
      stubEagerSendOnDwnApi(harness, deferred.promise);

      await harness.agent.dwn.writeContextKeyRecord(baseWriteParams);

      // Probe a raw LevelDB-backed store (`syncStore` is an `AbstractLevel`).
      // When open, `.get('__probe__')` throws `LEVEL_NOT_FOUND`; when closed,
      // it throws `LEVEL_DATABASE_NOT_OPEN`.
      const probeLevel = async (): Promise<'open' | 'closed' | string> => {
        try {
          await harness.syncStore.get('__probe__');
          return 'open';
        } catch (err: any) {
          const code = err?.code as string | undefined;
          if (code === 'LEVEL_NOT_FOUND' || err?.notFound === true) {
            return 'open';
          }
          if (code === 'LEVEL_DATABASE_NOT_OPEN') {
            return 'closed';
          }
          return `error:${code ?? err?.message ?? 'unknown'}`;
        }
      };

      // Start closeStorage without awaiting.
      const closePromise = harness.closeStorage();

      // While the drain is blocked on the deferred, closeStorage must NOT resolve.
      expect(await raceAgainstTick(closePromise, 30)).toBe('tick');

      // Probe: the store is still open because closeStorage's drain is blocked.
      expect(await probeLevel()).toBe('open');

      // Resolve the deferred → drain completes → closeStorage proceeds to close.
      deferred.resolve();
      await closePromise;

      // The store is now closed — probe must throw `LEVEL_DATABASE_NOT_OPEN`.
      expect(await probeLevel()).toBe('closed');
    } finally {
      // closeStorage already ran; clearStorage would target closed stores.
      try { await harness.clearStorage(); } catch { /* stores are closed */ }
    }
  }, 30000);
});

describe('PlatformAgentTestHarness teardown subprocess', () => {
  it('should not surface forbidden diagnostic strings in stderr after teardown with rejecting eager send (VAL-HARNESS-005)', async () => {
    // Run ONLY the TH-INNER fixture test below as a separate `bun test`
    // sub-process. The filter `-t 'TH-INNER'` matches this file's inner
    // describe block and no other tests, so the subprocess does NOT recurse
    // back into this spawn-and-grep test.
    const innerFilter = 'TH-INNER';
    const proc = Bun.spawn(
      [
        'bun', 'test',
        'tests/test-harness.spec.ts',
        '-t', innerFilter,
      ],
      {
        cwd    : path.resolve(import.meta.dir, '..'),
        env    : process.env,
        stderr : 'pipe',
        stdout : 'pipe',
      },
    );

    const [stderr, stdout] = await Promise.all([
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    await proc.exited;

    const combined = `${stderr}\n${stdout}`;

    // These forbidden strings are the known signatures of the orphan
    // eager-send leak that this mission eliminates.
    const forbiddenStrings = [
      '# Unhandled error between tests',
      'TestAgent: Agent DID is not set',
      'LEVEL_DATABASE_NOT_OPEN',
      'DB is not open',
    ];
    for (const forbidden of forbiddenStrings) {
      const count = combined.split(forbidden).length - 1;
      expect({ forbidden, count }).toEqual({ forbidden, count: 0 });
    }

    // The inner test itself must pass cleanly.
    expect(proc.exitCode).toBe(0);
  }, 60000);
});

/**
 * TH-INNER fixture — the sub-process launched by VAL-HARNESS-005 runs ONLY
 * this describe block (filtered by `-t 'TH-INNER'`). The test performs the
 * full scenario: creates the harness, creates the agent DID, stubs
 * `sendDwnRpcRequest` to reject, writes a contextKey record, and relies on
 * `afterAll` to tear down. Any forbidden diagnostic strings produced during
 * this flow would surface in the subprocess's stderr and fail the outer
 * assertion.
 */
describe('TH-INNER teardown drain internal fixture', () => {
  let innerHarness: PlatformAgentTestHarness | undefined;

  afterAll(async () => {
    sinon.restore();
    if (innerHarness) {
      try { await innerHarness.clearStorage(); } catch { /* ok */ }
      try { await innerHarness.closeStorage(); } catch { /* ok */ }
    }
  });

  it('TH-INNER: writes a contextKey record with rejecting RPC and tears down cleanly', async () => {
    innerHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/harness-drain-005-inner',
    });
    await innerHarness.createAgentDid();

    // Install the key-delivery protocol so writeContextKeyRecord's local
    // write succeeds without re-installing during the eager-send path.
    await innerHarness.agent.dwn.ensureKeyDeliveryProtocol(innerHarness.agent.agentDid.uri);

    // Stub DID dereference so the eager-send path resolves DWN endpoints
    // without hitting the network.
    sinon.stub(innerHarness.agent.did, 'dereference').resolves({
      dereferencingMetadata : {},
      contentMetadata       : {},
      contentStream         : {
        id              : '#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : ['https://dwn.example.com'],
      },
    } as any);

    // Stub `sendDwnRpcRequest` on the AgentDwnApi instance to reject — the
    // eager-send chain will surface this error through the .catch handler
    // which logs a console.warn. This matches the VAL-HARNESS-005 scenario
    // ("sendDwnRpcRequest is stubbed to reject").
    sinon.stub(innerHarness.agent.dwn as any, 'sendDwnRpcRequest').rejects(
      new Error('network down'),
    );

    const recordId = await innerHarness.agent.dwn.writeContextKeyRecord({
      tenantDid       : innerHarness.agent.agentDid.uri,
      recipientDid    : innerHarness.agent.agentDid.uri,
      contextKeyData  : mockContextKeyData,
      sourceProtocol  : 'https://proto.example.com/th-inner',
      sourceContextId : 'ctx-inner',
    });
    expect(typeof recordId).toBe('string');

    // Teardown runs in afterAll. With the fix in place, afterAll's
    // clearStorage()/closeStorage() await the drain, so the orphan
    // eager-send cannot touch closed stores or a nulled agentDid.
  }, 60000);
});
