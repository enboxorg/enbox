import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { BearerIdentity } from '../src/bearer-identity.js';

import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

/**
 * Cross-area integration coverage for the `writeContextKeyRecord` →
 * `trackEagerSend` → `drainPendingEagerSends` → `clearStorage/closeStorage`
 * happy path and rejection path.
 *
 * Validation contract: VAL-CROSS-001 through VAL-CROSS-003.
 *
 * Unlike the unit-level `drainPendingEagerSends` tests in `dwn-api.spec.ts`
 * (which stub `eagerSendContextKeyRecord` directly), these tests exercise the
 * full cross-area integration via `agent.rpc.sendDwnRequest`:
 *
 *     writeContextKeyRecord (agent.dwn)
 *       └─ eagerSendContextKeyRecord (agent.dwn internal)
 *           └─ getDwnEndpointUrlsForTarget → agent.did.dereference (stubbed)
 *           └─ getDwnMessage → real local DWN
 *           └─ agent.rpc.sendDwnRequest (stubbed — resolves or rejects)
 *
 * Determinism is achieved via `drainPendingEagerSends()` — NEVER via
 * `setTimeout(resolve, …)` workarounds.
 */

const testDwnUrls: string[] = [testDwnUrl];

describe('AgentDwnApi drain integration', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn',
    });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    await testHarness.agent.dwn.ensureKeyDeliveryProtocol(alice.did.uri);
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('VAL-CROSS-001: writeContextKeyRecord + drainPendingEagerSends', () => {
    it('should deterministically settle happy- and reject-path eager-sends with no tail-sentinel activity', async () => {
      const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

      // Stub DID dereference so endpoint lookup does not hit the network.
      sinon.stub(testHarness.agent.did, 'dereference').resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : {
          id              : '#dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://dwn.example.com'],
        },
      });

      const sendDwnRequestStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest');
      const warnStub = sinon.stub(console, 'warn');

      // ---------------------------------------------------------------
      // Sub-assertion 1 — happy path (stub resolves with 202).
      // ---------------------------------------------------------------
      sendDwnRequestStub.resetBehavior();
      sendDwnRequestStub.resolves({ status: { code: 202, detail: 'Accepted' } });

      const happyContextKey = {
        rootKeyId         : `${alice.did.uri}#enc`,
        derivationScheme  : 'protocolContext',
        derivationPath    : ['protocolContext', 'cross-001-happy'],
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'test', d: 'test' },
      };

      const happyRecordId = await testHarness.agent.dwn.writeContextKeyRecord({
        tenantDid       : alice.did.uri,
        recipientDid    : bob.did.uri,
        contextKeyData  : happyContextKey as any,
        sourceProtocol  : 'https://protocol.xyz/cross-001-happy',
        sourceContextId : 'cross-001-happy',
      });
      expect(typeof happyRecordId).toBe('string');

      // Deterministic wait for the fire-and-forget eager-send to settle.
      await testHarness.agent.dwn.drainPendingEagerSends();

      // Happy path: the RPC was invoked exactly once and resolved.
      expect(sendDwnRequestStub.callCount).toBe(1);
      const happyRpcArgs = sendDwnRequestStub.firstCall.args[0];
      expect(happyRpcArgs.targetDid).toBe(alice.did.uri);
      expect(happyRpcArgs.message).toHaveProperty('recordId', happyRecordId);

      // No console.warn during the happy path.
      expect(warnStub.called).toBe(false);

      // 250 ms tail sentinel — no additional RPC or warn activity after drain.
      const rpcCallsAfterHappyDrain = sendDwnRequestStub.callCount;
      const warnCallsAfterHappyDrain = warnStub.callCount;
      await new Promise((resolve: (value: void) => void) => {
        setTimeout(resolve, 250);
      });
      expect(sendDwnRequestStub.callCount).toBe(rpcCallsAfterHappyDrain);
      expect(warnStub.callCount).toBe(warnCallsAfterHappyDrain);

      // ---------------------------------------------------------------
      // Sub-assertion 2 — reject path (stub rejects with Error).
      // ---------------------------------------------------------------
      sendDwnRequestStub.resetBehavior();
      sendDwnRequestStub.rejects(new Error('network down'));

      const rejectContextKey = {
        rootKeyId         : `${alice.did.uri}#enc`,
        derivationScheme  : 'protocolContext',
        derivationPath    : ['protocolContext', 'cross-001-reject'],
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'test', d: 'test' },
      };

      const rejectRecordId = await testHarness.agent.dwn.writeContextKeyRecord({
        tenantDid       : alice.did.uri,
        recipientDid    : bob.did.uri,
        contextKeyData  : rejectContextKey as any,
        sourceProtocol  : 'https://protocol.xyz/cross-001-reject',
        sourceContextId : 'cross-001-reject',
      });
      expect(typeof rejectRecordId).toBe('string');

      // Deterministic wait; drain swallows rejections via allSettled.
      await expect(testHarness.agent.dwn.drainPendingEagerSends()).resolves.toBeUndefined();

      // RPC was invoked a second time (and rejected).
      expect(sendDwnRequestStub.callCount).toBe(2);

      // The verbatim observability-contract warn pattern was emitted and
      // includes both the reject-path recordId and the underlying error.
      const warnArgs = warnStub.args.map((args: any[]): unknown => args[0]);
      const matched = warnArgs.find(
        (msg: unknown): boolean => typeof msg === 'string'
          && /AgentDwnApi: Eager send of contextKey record '.+' to remote DWN failed: .+\. Sync will deliver it later\./.test(msg as string),
      );
      expect(matched).toBeDefined();
      expect(matched as string).toContain(rejectRecordId);
      expect(matched as string).toContain('network down');

      // 250 ms tail sentinel — no additional RPC or warn activity after drain.
      const rpcCallsAfterRejectDrain = sendDwnRequestStub.callCount;
      const warnCallsAfterRejectDrain = warnStub.callCount;
      await new Promise((resolve: (value: void) => void) => {
        setTimeout(resolve, 250);
      });
      expect(sendDwnRequestStub.callCount).toBe(rpcCallsAfterRejectDrain);
      expect(warnStub.callCount).toBe(warnCallsAfterRejectDrain);

      warnStub.restore();
    }, 20000);
  });

  describe('VAL-CROSS-002: post-clearStorage sanity', () => {
    it('should not surface "TestAgent: Agent DID is not set" after clearStorage drains a rejecting eager send', async () => {
      const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

      sinon.stub(testHarness.agent.did, 'dereference').resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : {
          id              : '#dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://dwn.example.com'],
        },
      });

      // Force the eager-send to reject — maximum probability of exercising
      // the fire-and-forget catch handler that used to touch a nulled
      // `agentDid` after teardown.
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').rejects(
        new Error('cross-002 network down'),
      );

      // Capture every observable diagnostic channel so we can grep for the
      // forbidden string across warn/error/unhandled-rejection output.
      const warnStub = sinon.stub(console, 'warn');
      const errorStub = sinon.stub(console, 'error');
      const capturedRejections: string[] = [];
      const unhandledRejectionHandler = (reason: unknown): void => {
        capturedRejections.push(String(reason));
      };
      process.on('unhandledRejection', unhandledRejectionHandler);

      try {
        const mockContextKey = {
          rootKeyId         : `${alice.did.uri}#enc`,
          derivationScheme  : 'protocolContext',
          derivationPath    : ['protocolContext', 'cross-002'],
          derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'test', d: 'test' },
        };

        await testHarness.agent.dwn.writeContextKeyRecord({
          tenantDid       : alice.did.uri,
          recipientDid    : bob.did.uri,
          contextKeyData  : mockContextKey as any,
          sourceProtocol  : 'https://protocol.xyz/cross-002',
          sourceContextId : 'cross-002',
        });

        // clearStorage() internally drains before nulling agentDid — the
        // fire-and-forget rejection must not outlive this call.
        await testHarness.clearStorage();

        // 250 ms tail sentinel — any orphan promise landing after clearStorage
        // would surface here.
        await new Promise((resolve: (value: void) => void) => {
          setTimeout(resolve, 250);
        });

        const combined = [
          ...warnStub.args.map((a: unknown[]): string => a.map((v): string => String(v)).join(' ')),
          ...errorStub.args.map((a: unknown[]): string => a.map((v): string => String(v)).join(' ')),
          ...capturedRejections,
        ].join('\n');

        // VAL-CROSS-002: the forbidden signature of the orphan leak never
        // surfaces after clearStorage() + the sentinel wait.
        expect(combined).not.toContain('TestAgent: Agent DID is not set');
        // Additional defense in depth: neither LevelDB-closed nor
        // unhandled-rejection banners should appear.
        expect(combined).not.toContain('LEVEL_DATABASE_NOT_OPEN');
      } finally {
        process.off('unhandledRejection', unhandledRejectionHandler);
        warnStub.restore();
        errorStub.restore();
      }
    }, 15000);
  });

  describe('VAL-CROSS-003: end-to-end no-unhandled-rejection', () => {
    it('should complete the full writeContextKeyRecord → drain cycle without unhandled rejections', async () => {
      const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

      sinon.stub(testHarness.agent.did, 'dereference').resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : {
          id              : '#dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://dwn.example.com'],
        },
      });

      // Exercise both outcomes in a single test to prove the contract holds
      // regardless of RPC success or failure. First call succeeds, second
      // call rejects — drain must not surface an unhandled rejection either
      // way.
      const sendDwnRequestStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest');
      sendDwnRequestStub.onFirstCall().resolves({ status: { code: 202, detail: 'Accepted' } });
      sendDwnRequestStub.onSecondCall().rejects(new Error('cross-003 failure'));

      // Silence expected console.warn from the reject path so test output
      // stays clean; the message content is exercised by VAL-CROSS-001.
      const warnStub = sinon.stub(console, 'warn');

      let unhandledRejectionCount = 0;
      const capturedReasons: string[] = [];
      const unhandledRejectionHandler = (reason: unknown): void => {
        unhandledRejectionCount += 1;
        capturedReasons.push(String(reason));
      };
      process.on('unhandledRejection', unhandledRejectionHandler);

      try {
        const mockContextKey = {
          rootKeyId         : `${alice.did.uri}#enc`,
          derivationScheme  : 'protocolContext',
          derivationPath    : ['protocolContext', 'cross-003'],
          derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'test', d: 'test' },
        };

        // Happy-path write: real processDwnRequest (RecordsWrite to local
        // DWN), real eager-send attempt, real tracker registration, real
        // drain. The local write must succeed (202) and the drain must
        // resolve without throwing regardless of RPC outcome.
        const happyRecordId = await testHarness.agent.dwn.writeContextKeyRecord({
          tenantDid       : alice.did.uri,
          recipientDid    : bob.did.uri,
          contextKeyData  : mockContextKey as any,
          sourceProtocol  : 'https://protocol.xyz/cross-003',
          sourceContextId : 'cross-003-happy',
        });
        expect(typeof happyRecordId).toBe('string');

        await expect(testHarness.agent.dwn.drainPendingEagerSends()).resolves.toBeUndefined();

        // Second write exercises the reject path.
        const rejectRecordId = await testHarness.agent.dwn.writeContextKeyRecord({
          tenantDid       : alice.did.uri,
          recipientDid    : bob.did.uri,
          contextKeyData  : mockContextKey as any,
          sourceProtocol  : 'https://protocol.xyz/cross-003',
          sourceContextId : 'cross-003-reject',
        });
        expect(typeof rejectRecordId).toBe('string');

        await expect(testHarness.agent.dwn.drainPendingEagerSends()).resolves.toBeUndefined();

        // Black-box tracker-empty check (mirrors VAL-TRACKER-006 pattern):
        // a fresh drain must fast-path without awaiting anything.
        const raceWinner = await Promise.race<'drain' | 'tick'>([
          testHarness.agent.dwn.drainPendingEagerSends().then((): 'drain' => 'drain'),
          new Promise<'tick'>((resolve): void => {
            setTimeout((): void => resolve('tick'), 0);
          }),
        ]);
        expect(raceWinner).toBe('drain');

        // 250 ms tail sentinel — any lingering orphan work would surface
        // as an unhandled rejection here.
        await new Promise((resolve: (value: void) => void) => {
          setTimeout(resolve, 250);
        });

        // Both RPC invocations happened; the reject path produced a warn.
        expect(sendDwnRequestStub.callCount).toBe(2);

        // Core VAL-CROSS-003 assertion: zero unhandled rejections across
        // the entire integration path.
        expect(unhandledRejectionCount).toBe(0);
        expect(capturedReasons).toEqual([]);
      } finally {
        process.off('unhandledRejection', unhandledRejectionHandler);
        warnStub.restore();
      }
    }, 20000);
  });
});
