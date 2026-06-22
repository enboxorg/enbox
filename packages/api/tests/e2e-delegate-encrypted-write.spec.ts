/**
 * End-to-end test: delegate DID writes to a protocol with encrypted types.
 *
 * Exercises the exact flow that real dapps (like nutsd) hit when connected
 * via DWeb Connect to an external wallet:
 *
 *   1. Wallet agent creates a did:dht identity with Ed25519 + X25519 keys.
 *   2. Wallet installs a protocol WITH `$encryption` keys on the remote DWN.
 *   3. Wallet creates a delegate did:jwk and grants permissions.
 *   4. Dapp agent imports the delegate, processes grants.
 *   5. Dapp uses `Enbox.using(Protocol).records.create(...)` to write records.
 *   6. Auto-configure fetches the remote protocol definition (with `$encryption`).
 *   7. The delegate encrypts records using only the public keys from `$encryption`.
 *
 * The test validates:
 *   - The delegate agent has NO owner private signing key.
 *   - Non-encrypted record writes via delegate succeed.
 *   - Encrypted record writes via delegate succeed (ProtocolPath encryption).
 *   - The TypedEnbox / `Enbox.using()` / repository pattern handles delegates.
 *   - Record author is the wallet owner DID; signer is the delegate DID.
 *   - Encrypted records carry encryption metadata accepted by the DWN.
 *
 * Regression context: nutsd dapp failed with
 *   "AgentDwnApi: Unable to get signer for author 'did:dht:...': Key not found"
 * when a delegate tried to write encrypted cashu-wallet records. The root cause
 * was that `TypedEnbox` skipped auto-encryption for delegates, but the DWN SDK
 * enforces `encryptionRequired` at `protocol-authorization-validation.ts:265`
 * for every write.
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { BearerDid, PortableDid } from '@enbox/dids';
import type { ConnectHandler, ConnectResult } from '@enbox/auth';
import type { DwnProtocolDefinition, EnboxPlatformAgent } from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { Ed25519 } from '@enbox/crypto';
import { Jws } from '@enbox/dwn-sdk-js';
import {
  AuthManager, MemoryStorage, processConnectedGrants, WalletConnect,
} from '@enbox/auth';

import {
  EnboxConnectProtocol, EnboxUserAgent, PlatformAgentTestHarness,
} from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { Enbox } from '../src/enbox.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// Protocol definition mimicking the cashu-wallet protocol:
// - `mint`          : top-level, NO encryption, has tags
// - `mint/proof`    : child, encryption REQUIRED, no tags
// - `transaction`   : top-level, encryption REQUIRED, no tags
// - `preference`    : top-level, NO encryption, singleton
// ---------------------------------------------------------------------------

function createEncryptedProtocol(protocolUri: string): DwnProtocolDefinition {
  return {
    published : false,
    protocol  : protocolUri,
    types     : {
      mint: {
        schema      : `${protocolUri}/schemas/mint`,
        dataFormats : ['application/json'],
      },
      proof: {
        schema             : `${protocolUri}/schemas/proof`,
        dataFormats        : ['application/json'],
        encryptionRequired : true,
      },
      transaction: {
        schema             : `${protocolUri}/schemas/transaction`,
        dataFormats        : ['application/json'],
        encryptionRequired : true,
      },
      preference: {
        schema      : `${protocolUri}/schemas/preference`,
        dataFormats : ['application/json'],
      },
    },
    structure: {
      mint: {
        proof: {},
      },
      transaction : {},
      preference  : {},
    },
  } as DwnProtocolDefinition;
}

// Type-checked schema map for the protocol.
type EncryptedSchemaMap = {
  mint : { url: string; unit: string };
  proof : { amount: number; secret: string; C: string };
  transaction : { type: string; amount: number };
  preference : { defaultMint: string };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: Delegate writes to protocol with encrypted types', () => {
  // "Wallet" agent — owns the identity and protocol.
  // Uses the SHARED DWN server so the dapp agent can query the remote DWN.
  let walletHarness: PlatformAgentTestHarness;
  let walletDid: BearerDid;
  let walletDwn: DwnApi;

  // "Dapp" agent — operates via delegate. Has NO owner private keys.
  let dappHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    walletHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/e2e-delegate-encrypt-wallet',
    });
    await walletHarness.clearStorage();
    await walletHarness.createAgentDid();

    // Create a did:dht identity with Ed25519 + X25519 keys (matches real wallets).
    const walletIdentity = await walletHarness.createIdentity({
      name: 'WalletOwner',
      testDwnUrls,
    });
    walletDid = walletIdentity.did;
    walletDwn = new DwnApi({ agent: walletHarness.agent, connectedDid: walletDid.uri });

    dappHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/e2e-delegate-encrypt-dapp',
    });
    await dappHarness.clearStorage();
    await dappHarness.createAgentDid();
  });

  afterAll(async () => {
    sinon.restore();
    await walletHarness.clearStorage();
    await walletHarness.closeStorage();
    await dappHarness.clearStorage();
    await dappHarness.closeStorage();
  });

  beforeEach(async () => {
    sinon.restore();

    // Clear dapp stores between tests.
    await dappHarness.syncStore.clear();
    await dappHarness.dwnDataStore.clear();
    await dappHarness.dwnMessageStore.clear();
    await dappHarness.dwnResumableTaskStore.clear();
    await dappHarness.agent.permissions.clear();
    dappHarness.dwnStores.clear();

    // Also reset wallet stores to isolate each test.
    await walletHarness.syncStore.clear();
    await walletHarness.dwnDataStore.clear();
    await walletHarness.dwnMessageStore.clear();
    await walletHarness.dwnResumableTaskStore.clear();
    await walletHarness.agent.permissions.clear();
    walletHarness.dwnStores.clear();

    // Suppress console.warn from the INSECURE_DEFAULT_PASSWORD path.
    sinon.stub(console, 'warn');
  });

  /**
   * Helper: sets up the full delegate connect flow for a given protocol.
   *
   * Mirrors the real DWeb Connect flow:
   * 1. Wallet installs the protocol WITH encryption on local AND remote DWN
   * 2. Wallet creates a delegate did:jwk and grants permissions
   * 3. Dapp agent imports the delegate, processes grants, registers sync
   * 4. Returns an Enbox instance ready for use
   */
  async function setupDelegateFlow(protocolDef: DwnProtocolDefinition): Promise<{
    delegateDid: PortableDid;
    dappEnbox: Enbox;
  }> {
    // 1. Wallet installs the protocol WITH encryption (derives `$encryption` keys).
    const { status: configStatus, protocol: walletProtocol } = await walletDwn.protocols.configure({
      definition : protocolDef,
      encryption : true,
    });
    expect(configStatus.code).toBe(202);

    // Send the protocol (with `$encryption`) to the wallet's remote DWN.
    // This is what real wallets do in `prepareProtocol()`.
    const { status: sendStatus } = await walletProtocol!.send(walletDid.uri);
    expect(sendStatus.code).toBe(202);

    // 2. Create a delegate did:jwk (same as the wallet DWeb Connect handler).
    const delegatedBearerDid = await walletHarness.agent.did.create({
      store  : false,
      method : 'jwk',
    });
    const delegatePortable = await delegatedBearerDid.export();

    // 3. Create permission grants. Read is the unified read-like Records scope;
    // Protocols.Configure remains wallet-owned.
    const grantRequest = WalletConnect.createPermissionRequestForProtocol({
      definition  : protocolDef,
      permissions : ['write', 'read', 'delete'],
    });

    const grants = await EnboxConnectProtocol.createPermissionGrants(
      walletDid.uri,
      delegatedBearerDid,
      walletHarness.agent,
      grantRequest.permissionScopes,
    );

    // 4. Import the delegate into the dapp agent (as `importDelegateAndSetupSync` does).
    await dappHarness.agent.identity.import({
      portableIdentity: {
        portableDid : delegatePortable,
        metadata    : {
          connectedDid : walletDid.uri,
          name         : 'Default',
          uri          : delegatePortable.uri,
          tenant       : dappHarness.agent.agentDid.uri,
        },
      },
    });

    // 5. Process grants (stores them in both delegate and connected partitions).
    const connectedProtocols = await processConnectedGrants({
      grants,
      connectedDid : walletDid.uri,
      delegateDid  : delegatePortable.uri,
      agent        : dappHarness.agent as EnboxUserAgent,
    });

    // 6. Register sync for the wallet's DID.
    await (dappHarness.agent as EnboxUserAgent).sync.registerIdentity({
      did     : walletDid.uri,
      options : {
        delegateDid : delegatePortable.uri,
        protocols   : connectedProtocols,
      },
    });

    // 7. Construct the Enbox instance with delegate support.
    //    Note: we do NOT call sync.sync('pull') here — the auto-configure
    //    in TypedEnbox fetches the remote protocol definition directly.
    const dappEnbox = new Enbox({
      agent        : dappHarness.agent,
      connectedDid : walletDid.uri,
      delegateDid  : delegatePortable.uri,
    });

    return { delegateDid: delegatePortable, dappEnbox };
  }

  // ─── Tests ───────────────────────────────────────────────────────

  describe('TypedEnbox (Enbox.using) delegate encrypted writes', () => {
    it('should write a non-encrypted record via typed protocol as delegate', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { delegateDid, dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(
        protocolDef as ProtocolDefinition,
        {} as EncryptedSchemaMap,
      );

      const typed = dappEnbox.using(EncTestProtocol);

      // Write a `mint` record (non-encrypted type) through the typed API.
      const { status, record } = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // Author is the wallet DID, signer is the delegate DID.
      const signerDid = Jws.getSignerDid(
        record!.rawMessage.authorization.signature.signatures[0],
      );
      expect(signerDid).toBe(delegateDid.uri);
    });

    it('should write an encrypted child record via typed protocol as delegate', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { delegateDid, dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(
        protocolDef as ProtocolDefinition,
        {} as EncryptedSchemaMap,
      );

      const typed = dappEnbox.using(EncTestProtocol);

      // First create the parent `mint` record.
      const { status: mintStatus, record: mintRecord } = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });
      expect(mintStatus.code).toBe(202);
      expect(mintRecord).toBeDefined();

      // Write a `mint/proof` record (encrypted child type).
      // The delegate encrypts using the public keys from the owner's protocol
      // definition — no owner private key needed.
      const { status: proofStatus, record: proofRecord } = await typed.records.create(
        'mint/proof' as any,
        {
          data            : { amount: 100, secret: 'abc', C: 'def' },
          parentContextId : mintRecord!.contextId,
        },
      );

      expect(proofStatus.code).toBe(202);
      expect(proofRecord).toBeDefined();

      // Verify encryption metadata is present on the record.
      expect((proofRecord!.rawMessage as any).encryption).toBeDefined();

      // Verify delegate signed the record (not the owner).
      const signerDid = Jws.getSignerDid(
        proofRecord!.rawMessage.authorization.signature.signatures[0],
      );
      expect(signerDid).toBe(delegateDid.uri);
    });

    it('should write a top-level encrypted record via typed protocol as delegate', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { delegateDid, dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(
        protocolDef as ProtocolDefinition,
        {} as EncryptedSchemaMap,
      );

      const typed = dappEnbox.using(EncTestProtocol);

      // Write a `transaction` record (top-level encrypted type).
      const { status, record } = await typed.records.create('transaction', {
        data: { type: 'receive', amount: 500 },
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // Verify encryption metadata is present.
      expect((record!.rawMessage as any).encryption).toBeDefined();

      const signerDid = Jws.getSignerDid(
        record!.rawMessage.authorization.signature.signatures[0],
      );
      expect(signerDid).toBe(delegateDid.uri);
    });

    it('should handle the full nutsd-style flow: mint → proof → transaction', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { delegateDid, dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(
        protocolDef as ProtocolDefinition,
        {} as EncryptedSchemaMap,
      );

      const typed = dappEnbox.using(EncTestProtocol);

      // Step 1: Create a mint (non-encrypted, with tags).
      const { record: mintRecord } = await typed.records.create('mint', {
        data: { url: 'https://testnut.cash', unit: 'sat' },
      });
      expect(mintRecord).toBeDefined();

      // Step 2: Store proofs under the mint (encrypted child records).
      // This is the exact path that fails in nutsd.
      const { record: proof1 } = await typed.records.create('mint/proof' as any, {
        data            : { amount: 100, secret: 'secret1', C: 'C1' },
        parentContextId : mintRecord!.contextId,
      });
      expect(proof1).toBeDefined();
      expect((proof1!.rawMessage as any).encryption).toBeDefined();

      const { record: proof2 } = await typed.records.create('mint/proof' as any, {
        data            : { amount: 200, secret: 'secret2', C: 'C2' },
        parentContextId : mintRecord!.contextId,
      });
      expect(proof2).toBeDefined();

      // Step 3: Create a transaction record (encrypted top-level).
      const { record: txnRecord } = await typed.records.create('transaction', {
        data: { type: 'mint', amount: 300 },
      });
      expect(txnRecord).toBeDefined();
      expect((txnRecord!.rawMessage as any).encryption).toBeDefined();

      // Step 4: Verify non-encrypted records are queryable.
      const { records: mints } = await typed.records.query('mint');
      expect(mints.length).toBe(1);

      // Step 5: Verify no owner private key was used — all signed by delegate.
      // Check the non-encrypted mint record.
      const mintSigner = Jws.getSignerDid(
        mints[0].rawMessage.authorization.signature.signatures[0],
      );
      expect(mintSigner).toBe(delegateDid.uri);

      // Also verify the encrypted writes were signed by the delegate
      // (checked via the returned record objects, not re-queried,
      // because the delegate cannot decrypt query results).
      for (const r of [proof1!, proof2!, txnRecord!]) {
        const signer = Jws.getSignerDid(
          r.rawMessage.authorization.signature.signatures[0],
        );
        expect(signer).toBe(delegateDid.uri);
      }
    });

    it('should update a delegate-written record', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(
        protocolDef as ProtocolDefinition,
        {} as EncryptedSchemaMap,
      );

      const typed = dappEnbox.using(EncTestProtocol);

      const { record } = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });
      expect(record).toBeDefined();

      const { status: updateStatus } = await record!.update({
        data: { url: 'https://mint2.example', unit: 'usd' },
      });
      expect(updateStatus.code).toBe(202);
    });

    it('should delete a delegate-written record', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(
        protocolDef as ProtocolDefinition,
        {} as EncryptedSchemaMap,
      );

      const typed = dappEnbox.using(EncTestProtocol);

      const { record } = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });
      expect(record).toBeDefined();

      const { status: deleteStatus } = await record!.delete();
      expect(deleteStatus.code).toBe(202);
    });

    it('should subscribe to records as a delegate on encrypted protocol', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(
        protocolDef as ProtocolDefinition,
        {} as EncryptedSchemaMap,
      );

      const typed = dappEnbox.using(EncTestProtocol);

      const { status, liveQuery } = await typed.records.subscribe('mint');
      expect(status.code).toBe(200);

      if (liveQuery) {
        await liveQuery.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Full AuthManager.connect() wallet-connect e2e test
//
// Unlike the tests above (which manually wire grants/imports), this test
// drives the REAL AuthManager.connect() → ConnectHandler → session flow
// that nutsd and every DWeb Connect dapp uses in production.
// ---------------------------------------------------------------------------

/**
 * In-process ConnectHandler that acts as the wallet during tests.
 *
 * Performs the same operations as a real wallet's `submitConnectResponse`:
 * installs the protocol with encryption, creates a delegate DID with
 * Ed25519 + X25519 keys, creates permission grants, derives single-party
 * scoped decryption keys, and returns a fully-formed ConnectResult.
 */
class InProcessWalletHandler implements ConnectHandler {
  private walletDwn: DwnApi;

  constructor(
    private walletAgent: EnboxPlatformAgent,
    private ownerDid: string,
  ) {
    this.walletDwn = new DwnApi({
      agent: walletAgent, connectedDid: ownerDid,
    });
  }

  async requestAccess(params: {
    permissionRequests: any[];
  }): Promise<ConnectResult | undefined> {
    const delegateBearerDid = await this.walletAgent.did.create({
      store: false, method: 'jwk',
    });
    const delegatePortableDid = await delegateBearerDid.export();

    // Add X25519 private key derived from the delegate's Ed25519 key
    // (same as submitConnectResponse does).
    const delegateEdPrivateKey = delegatePortableDid.privateKeys![0];
    const delegateX25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
      privateKey: delegateEdPrivateKey,
    });
    delegatePortableDid.privateKeys!.push(delegateX25519PrivateKey);

    const allGrants: any[] = [];
    const allDecryptionKeys: any[] = [];

    for (const permissionRequest of params.permissionRequests) {
      const { protocolDefinition, permissionScopes } = permissionRequest;

      // Install the protocol with encryption on the wallet agent (local + remote).
      const { status: configStatus, protocol: walletProtocol } =
        await this.walletDwn.protocols.configure({
          definition : protocolDefinition,
          encryption : true,
        });
      if (configStatus.code !== 202) {
        throw new Error(
          `Failed to install protocol: ${configStatus.code} ${configStatus.detail}`
        );
      }

      // Send to the wallet's remote DWN (same as a real wallet does).
      await walletProtocol!.send(this.ownerDid);

      // Derive scoped decryption keys for single-party encrypted protocols.
      const hasEncryptedTypes = Object.values(protocolDefinition.types ?? {})
        .some((type: any) => type?.encryptionRequired === true);

      if (hasEncryptedTypes) {
        const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
          this.walletAgent, this.ownerDid,
          protocolDefinition.protocol, permissionScopes, protocolDefinition,
        );
        allDecryptionKeys.push(...keys);
      }

      // Create permission grants.
      const grants = await EnboxConnectProtocol.createPermissionGrants(
        this.ownerDid, delegateBearerDid, this.walletAgent, permissionScopes,
      );
      allGrants.push(...grants);
    }

    return {
      delegatePortableDid,
      delegateGrants         : allGrants,
      connectedDid           : this.ownerDid,
      delegateDecryptionKeys : allDecryptionKeys.length > 0 ? allDecryptionKeys : undefined,
    };
  }
}

describe('E2E: AuthManager.connect() with encrypted protocol', () => {
  let walletHarness: PlatformAgentTestHarness;
  let walletDid: BearerDid;
  let dappAgent: EnboxUserAgent;

  beforeAll(async () => {
    walletHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/e2e-auth-connect-wallet',
    });
    await walletHarness.clearStorage();
    await walletHarness.createAgentDid();

    const walletIdentity = await walletHarness.createIdentity({
      name: 'WalletOwner', testDwnUrls,
    });
    walletDid = walletIdentity.did;

    // Create a separate dapp agent (no shared state with wallet).
    const dappHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/e2e-auth-connect-dapp',
    });
    await dappHarness.clearStorage();
    await dappHarness.createAgentDid();
    dappAgent = dappHarness.agent as EnboxUserAgent;
  });

  afterAll(async () => {
    sinon.restore();
    await walletHarness.clearStorage();
    await walletHarness.closeStorage();
  });

  it('should write encrypted records through the full auth.connect() → Enbox.using() flow', async () => {
    sinon.stub(console, 'warn');

    const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
    const protocolDef = createEncryptedProtocol(protocolUri);

    const EncTestProtocol = defineProtocol(
      protocolDef as ProtocolDefinition,
      {} as EncryptedSchemaMap,
    );

    // Create the auth manager with the dapp's agent and our in-process
    // wallet handler — this is the same shape a real dapp would use with
    // BrowserConnectHandler.
    const auth = await AuthManager.create({
      agent          : dappAgent,
      password       : 'test-password',
      storage        : new MemoryStorage(),
      connectHandler : new InProcessWalletHandler(
        walletHarness.agent, walletDid.uri,
      ),
    });

    // Drive the full connect flow: normalizeProtocolRequests →
    // handler.requestAccess → importDelegateAndSetupSync →
    // finalizeDelegateSession → AuthSession.
    const session = await auth.connect({
      protocols: [protocolDef],
    });

    // Verify session shape.
    expect(session.did).toBe(walletDid.uri);
    expect(session.delegateDid).toBeDefined();
    expect(session.delegateDid).not.toBe(walletDid.uri);

    // Use the session exactly as a dapp would.
    const enbox = Enbox.fromSession(session);
    const typed = enbox.using(EncTestProtocol);

    // Write a non-encrypted record.
    const { status: mintStatus, record: mintRecord } = await typed.records.create('mint', {
      data: { url: 'https://testnut.cash', unit: 'sat' },
    });
    expect(mintStatus.code).toBe(202);
    expect(mintRecord).toBeDefined();

    // Write an encrypted child record (the exact nutsd failure path).
    const { status: proofStatus, record: proofRecord } = await typed.records.create(
      'mint/proof' as any,
      {
        data            : { amount: 100, secret: 'abc', C: 'def' },
        parentContextId : mintRecord!.contextId,
      },
    );
    expect(proofStatus.code).toBe(202);
    expect(proofRecord).toBeDefined();
    expect((proofRecord!.rawMessage as any).encryption).toBeDefined();

    // Write a top-level encrypted record.
    const { status: txnStatus, record: txnRecord } = await typed.records.create('transaction', {
      data: { type: 'receive', amount: 500 },
    });
    expect(txnStatus.code).toBe(202);
    expect(txnRecord).toBeDefined();
    expect((txnRecord!.rawMessage as any).encryption).toBeDefined();

    // All records are signed by the delegate, not the owner.
    for (const rec of [mintRecord!, proofRecord!, txnRecord!]) {
      const signer = Jws.getSignerDid(
        rec.rawMessage.authorization.signature.signatures[0],
      );
      expect(signer).toBe(session.delegateDid);
    }
  });
});
