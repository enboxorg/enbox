/**
 * End-to-end test: delegate DID writes to a protocol with encrypted types.
 *
 * Exercises the exact flow that real dapps (like nutsd) hit when connected
 * via DWeb Connect to an external wallet:
 *
 *   1. Wallet agent creates a did:dht identity with Ed25519 + X25519 keys.
 *   2. Wallet installs a protocol WITH `$keyAgreement` keys on the remote DWN.
 *   3. Wallet creates a delegate did:jwk and grants permissions.
 *   4. Dapp agent imports the delegate, processes grants.
 *   5. Dapp uses `Enbox.using(Protocol).records.create(...)` to write records.
 *   6. Auto-configure fetches the remote protocol definition (with `$keyAgreement`).
 *   7. The delegate encrypts records using only the public keys from `$keyAgreement`.
 *
 * The test validates:
 *   - The delegate agent has NO owner private signing key.
 *   - Non-encrypted record writes via delegate succeed.
 *   - Encrypted record writes via delegate succeed (ProtocolPath encryption).
 *   - The TypedEnbox / `Enbox.using()` path handles delegates.
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

import type { PrivateKeyJwk } from '@enbox/crypto';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { BearerDid, PortableDid } from '@enbox/dids';
import type { ConnectHandler, ConnectRequestType, ConnectResult } from '@enbox/auth';
import type { DwnDataEncodedRecordsWriteMessage, DwnProtocolDefinition, EnboxPlatformAgent } from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DidJwk } from '@enbox/dids';
import { Ed25519 } from '@enbox/crypto';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import {
  AuthManager, MemoryStorage, processConnectedGrants, WalletConnect,
} from '@enbox/auth';
import {
  createGrantKeyRecordsForGrants, createPermissionGrants, DwnInterface, EnboxUserAgent, getEncryptionKeyInfo,
} from '@enbox/agent';
import { DwnInterfaceName, DwnMethodName, Encoder, EncryptionProtocol, Jws, WRAPPED_GRANT_KEY_FORMAT } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { Enbox } from '../src/enbox.js';
import { publishProtocol } from './utils/test-dwn-operations.js';
import { recordCodecs } from '../src/record-codec.js';
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

const encryptedCodecs = {
  mint        : recordCodecs.json<{ url: string; unit: string }>(),
  preference  : recordCodecs.json<{ defaultMint: string }>(),
  proof       : recordCodecs.json<{ amount: number; secret: string; C: string }>(),
  transaction : recordCodecs.json<{ type: string; amount: number }>(),
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
    // 1. Wallet installs the protocol WITH encryption (derives `$keyAgreement` keys).
    const { status: configStatus, protocol: walletProtocol } = await walletDwn.protocols.configure({
      definition: protocolDef,
    });
    expect(configStatus.code).toBe(202);

    // Send the protocol (with `$keyAgreement`) to the wallet's remote DWN.
    // This is what real wallets do in `prepareProtocol()`.
    const { status: sendStatus } = await publishProtocol(
      walletHarness.agent,
      walletProtocol!,
      walletDid.uri,
      walletDid.uri,
    );
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

    const grants = await createPermissionGrants(
      walletDid.uri,
      delegatedBearerDid.uri,
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

      const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

      const typed = dappEnbox.using(EncTestProtocol);

      // Write a `mint` record (non-encrypted type) through the typed API.
      const record = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });

      // Author is the wallet DID, signer is the delegate DID.
      const signerDid = Jws.getSignerDid(
        record.rawMessage.authorization.signature.signatures[0],
      );
      expect(signerDid).toBe(delegateDid.uri);
    });

    it('should write an encrypted child record via typed protocol as delegate', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { delegateDid, dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

      const typed = dappEnbox.using(EncTestProtocol);

      // First create the parent `mint` record.
      const mintRecord = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });

      // Write a `mint/proof` record (encrypted child type).
      // The delegate encrypts using the public keys from the owner's protocol
      // definition — no owner private key needed.
      const proofRecord = await typed.records.create(
        'mint/proof' as any,
        {
          data            : { amount: 100, secret: 'abc', C: 'def' },
          parentContextId : mintRecord.contextId,
        },
      );

      // Verify encryption metadata is present on the record.
      expect((proofRecord.rawMessage as any).encryption).toBeDefined();

      // Verify delegate signed the record (not the owner).
      const signerDid = Jws.getSignerDid(
        proofRecord.rawMessage.authorization.signature.signatures[0],
      );
      expect(signerDid).toBe(delegateDid.uri);
    });

    it('should write a top-level encrypted record via typed protocol as delegate', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { delegateDid, dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

      const typed = dappEnbox.using(EncTestProtocol);

      // Write a `transaction` record (top-level encrypted type).
      const record = await typed.records.create('transaction', {
        data: { type: 'receive', amount: 500 },
      });

      // Verify encryption metadata is present.
      expect((record.rawMessage as any).encryption).toBeDefined();

      const signerDid = Jws.getSignerDid(
        record.rawMessage.authorization.signature.signatures[0],
      );
      expect(signerDid).toBe(delegateDid.uri);
    });

    it('should handle the full nutsd-style flow: mint → proof → transaction', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { delegateDid, dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

      const typed = dappEnbox.using(EncTestProtocol);

      // Step 1: Create a mint (non-encrypted, with tags).
      const mintRecord = await typed.records.create('mint', {
        data: { url: 'https://testnut.cash', unit: 'sat' },
      });

      // Step 2: Store proofs under the mint (encrypted child records).
      // This is the exact path that fails in nutsd.
      const proof1 = await typed.records.create('mint/proof' as any, {
        data            : { amount: 100, secret: 'secret1', C: 'C1' },
        parentContextId : mintRecord.contextId,
      });
      expect((proof1.rawMessage as any).encryption).toBeDefined();

      const proof2 = await typed.records.create('mint/proof' as any, {
        data            : { amount: 200, secret: 'secret2', C: 'C2' },
        parentContextId : mintRecord.contextId,
      });

      // Step 3: Create a transaction record (encrypted top-level).
      const txnRecord = await typed.records.create('transaction', {
        data: { type: 'mint', amount: 300 },
      });
      expect((txnRecord.rawMessage as any).encryption).toBeDefined();

      // Step 4: Verify non-encrypted records are queryable.
      const { records: mints } = await typed.records.query('mint');
      expect(mints).toHaveLength(1);

      // Step 5: Verify no owner private key was used — all signed by delegate.
      // Check the non-encrypted mint record.
      const mintSigner = Jws.getSignerDid(
        mints[0].rawMessage.authorization.signature.signatures[0],
      );
      expect(mintSigner).toBe(delegateDid.uri);

      // Also verify the encrypted writes were signed by the delegate
      // (checked via the returned record objects, not re-queried,
      // because the delegate cannot decrypt query results).
      for (const r of [proof1, proof2, txnRecord]) {
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

      const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

      const typed = dappEnbox.using(EncTestProtocol);

      const record = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });

      const updated = await record.update({
        data: { url: 'https://mint2.example', unit: 'usd' },
      });
      expect(updated).toBe(record);
      expect(await record.value()).toEqual({ url: 'https://mint2.example', unit: 'usd' });
    });

    it('should delete a delegate-written record', async () => {
      const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
      const protocolDef = createEncryptedProtocol(protocolUri);
      const { dappEnbox } = await setupDelegateFlow(protocolDef);

      const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

      const typed = dappEnbox.using(EncTestProtocol);

      const record = await typed.records.create('mint', {
        data: { url: 'https://mint.example', unit: 'sat' },
      });

      await record.delete();
      expect(record.deleted).toBe(true);
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
    private options: { preSupplyDelegateDid?: boolean } = {},
  ) {
    this.walletDwn = new DwnApi({
      agent: walletAgent, connectedDid: ownerDid,
    });
  }

  async requestAccess(params: {
    permissionRequests: any[];
    delegatePortableDid?: PortableDid;
    requestType?: ConnectRequestType;
  }): Promise<ConnectResult | undefined> {
    const delegatePortableDid = params.requestType === 'refresh'
      ? params.delegatePortableDid
      : this.options.preSupplyDelegateDid === true
        ? await createClientDelegatePortableDid()
        : await createWalletMintedDelegatePortableDid(this.walletAgent);
    if (delegatePortableDid === undefined) {
      throw new Error('refresh requests must supply the existing delegate DID.');
    }
    const reusesDelegate = params.requestType === 'refresh' || this.options.preSupplyDelegateDid === true;
    const delegateRootPrivateKey = delegatePortableDid.privateKeys!.find((key) => key.crv === 'X25519') as PrivateKeyJwk | undefined;
    if (!reusesDelegate && delegateRootPrivateKey === undefined) {
      throw new Error('test delegate DID must include an X25519 private key.');
    }

    const allGrants: any[] = [];
    const allGrantKeyRecords: DwnDataEncodedRecordsWriteMessage[] = [];

    for (const permissionRequest of params.permissionRequests) {
      const { protocolDefinition, permissionScopes } = permissionRequest;

      // Install the protocol with encryption on the wallet agent (local + remote).
      const { status: configStatus, protocol: walletProtocol } =
        await this.walletDwn.protocols.configure({
          definition: protocolDefinition,
        });
      if (configStatus.code !== 202) {
        throw new Error(
          `Failed to install protocol: ${configStatus.code} ${configStatus.detail}`
        );
      }

      // Send to the wallet's remote DWN (same as a real wallet does).
      await publishProtocol(this.walletAgent, walletProtocol!, this.ownerDid, this.ownerDid);

      // Create permission grants.
      const grants = await createPermissionGrants(
        this.ownerDid, delegatePortableDid.uri, this.walletAgent, permissionScopes,
      );
      allGrants.push(...grants);

      if (permissionRequestHasEncryptedReadScopes(permissionRequest)) {
        const delegateRootPublicKey = reusesDelegate
          ? (await getEncryptionKeyInfo(this.walletAgent, delegatePortableDid.uri)).publicKeyJwk
          : undefined;
        const grantKeyRecords = await createGrantKeyRecordsForGrants({
          agent      : this.walletAgent,
          ownerDid   : this.ownerDid,
          granteeDid : delegatePortableDid.uri,
          ...(delegateRootPublicKey === undefined
            ? { granteeRootPrivateKey: delegateRootPrivateKey! }
            : { granteeRootPublicKey: delegateRootPublicKey }),
          grantMessages       : grants,
          protocolDefinitions : [protocolDefinition],
        });
        allGrantKeyRecords.push(...grantKeyRecords);
      }
    }

    await fanOutDataEncodedRecords(this.walletAgent, this.ownerDid, allGrantKeyRecords);

    return {
      delegatePortableDid,
      delegateGrants : allGrants,
      connectedDid   : this.ownerDid,
    };
  }
}

async function createWalletMintedDelegatePortableDid(
  walletAgent: EnboxPlatformAgent,
): Promise<PortableDid> {
  const delegateBearerDid = await walletAgent.did.create({
    store  : false,
    method : 'jwk',
  });
  return addX25519PrivateKey(await delegateBearerDid.export());
}

async function createClientDelegatePortableDid(): Promise<PortableDid> {
  const delegateBearerDid = await DidJwk.create();
  return addX25519PrivateKey(await delegateBearerDid.export());
}

async function addX25519PrivateKey(delegatePortableDid: PortableDid): Promise<PortableDid> {
  const privateKeys = [...(delegatePortableDid.privateKeys ?? [])];
  const delegateEdPrivateKey = privateKeys.find((key) => key.crv === 'Ed25519');
  if (delegateEdPrivateKey === undefined) {
    throw new Error('test delegate DID must include an Ed25519 private key.');
  }

  if (!privateKeys.some((key) => key.crv === 'X25519')) {
    privateKeys.push(await Ed25519.convertPrivateKeyToX25519({
      privateKey: delegateEdPrivateKey as PrivateKeyJwk,
    }) as PrivateKeyJwk);
  }

  return {
    ...delegatePortableDid,
    privateKeys,
  };
}

function permissionRequestHasEncryptedReadScopes(permissionRequest: any): boolean {
  return Object.values(permissionRequest.protocolDefinition.types ?? {})
    .some((type: any) => type?.encryptionRequired === true) &&
    permissionRequest.permissionScopes.some(
      (scope: any) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Read
    );
}

async function fanOutDataEncodedRecords(
  agent: EnboxPlatformAgent,
  ownerDid: string,
  records: DwnDataEncodedRecordsWriteMessage[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(ownerDid);
  await Promise.all(records.flatMap((record) => {
    const { encodedData, ...rawMessage } = record;
    const data = Encoder.base64UrlToBytes(encodedData);
    return dwnEndpointUrls.map(async (dwnUrl) => {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : ownerDid,
        message   : rawMessage,
        data      : new Blob([data as BlobPart]),
      });
      expect([202, 409]).toContain(reply.status.code);
    });
  }));
}

async function queryWrappedGrantKeyEnvelope(params: {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  delegateDid: string;
  protocol: string;
}): Promise<any> {
  const { reply } = await params.agent.processDwnRequest({
    author        : params.ownerDid,
    target        : params.ownerDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.wrappedGrantKeyPath,
        recipient    : params.delegateDid,
        tags         : { protocol: params.protocol },
      },
    },
  });

  expect(reply.status.code).toBe(200);
  const wrappedEntry = reply.entries?.find((entry: any) => entry.encryption === undefined && entry.encodedData !== undefined);
  expect(wrappedEntry).toBeDefined();
  return Encoder.bytesToObject(Encoder.base64UrlToBytes((wrappedEntry as any).encodedData));
}

async function queryDataEncodedRecord(params: {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  recordId: string;
}): Promise<DwnDataEncodedRecordsWriteMessage> {
  const { reply } = await params.agent.processDwnRequest({
    author        : params.ownerDid,
    target        : params.ownerDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        recordId: params.recordId,
      },
    },
  });

  expect(reply.status.code).toBe(200);
  const record = reply.entries?.[0] as DwnDataEncodedRecordsWriteMessage | undefined;
  expect(record?.encodedData).toBeDefined();
  return record!;
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

  beforeEach(() => {
    sinon.restore();
  });

  it('should write encrypted records through the full auth.connect() → Enbox.using() flow', async () => {
    sinon.stub(console, 'warn');

    const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
    const protocolDef = createEncryptedProtocol(protocolUri);

    const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

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
    const mintRecord = await typed.records.create('mint', {
      data: { url: 'https://testnut.cash', unit: 'sat' },
    });

    // Write an encrypted child record (the exact nutsd failure path).
    const proofRecord = await typed.records.create(
      'mint/proof' as any,
      {
        data            : { amount: 100, secret: 'abc', C: 'def' },
        parentContextId : mintRecord.contextId,
      },
    );
    expect((proofRecord.rawMessage as any).encryption).toBeDefined();

    // Write a top-level encrypted record.
    const txnRecord = await typed.records.create('transaction', {
      data: { type: 'receive', amount: 500 },
    });
    expect((txnRecord.rawMessage as any).encryption).toBeDefined();

    // All records are signed by the delegate, not the owner.
    for (const rec of [mintRecord, proofRecord, txnRecord]) {
      const signer = Jws.getSignerDid(
        rec.rawMessage.authorization.signature.signatures[0],
      );
      expect(signer).toBe(session.delegateDid);
    }
  });

  it('should refresh real grants for the existing delegate and continue encrypted writes', async () => {
    sinon.stub(console, 'warn');

    const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
    const protocolDef = createEncryptedProtocol(protocolUri);
    const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

    const auth = await AuthManager.create({
      agent          : dappAgent,
      password       : 'test-password',
      storage        : new MemoryStorage(),
      connectHandler : new InProcessWalletHandler(
        walletHarness.agent, walletDid.uri,
      ),
    });

    const initialSession = await auth.connect({ protocols: [protocolDef] });
    const initialStatus = await auth.getConnectionStatus();
    expect(initialStatus.state).toBe('active');
    expect(initialStatus.connectSessionId).toBeDefined();

    const refreshedSession = await auth.refresh({ protocols: [protocolDef] });
    const refreshedStatus = await auth.getConnectionStatus();
    expect(refreshedSession.did).toBe(initialSession.did);
    expect(refreshedSession.delegateDid).toBe(initialSession.delegateDid);
    expect(refreshedStatus.state).toBe('active');
    expect(refreshedStatus.connectSessionId).toBeDefined();
    expect(refreshedStatus.connectSessionId).not.toBe(initialStatus.connectSessionId);

    const typed = Enbox.fromSession(refreshedSession).using(EncTestProtocol);
    const record = await typed.records.create('transaction', {
      data: { type: 'receive', amount: 900 },
    });
    expect((record.rawMessage as any).encryption).toBeDefined();
    expect(Jws.getSignerDid(
      record.rawMessage.authorization.signature.signatures[0],
    )).toBe(initialSession.delegateDid);
  });

  it('should hydrate wrapped grantKeys for a pre-supplied delegate DID through auth.connect()', async () => {
    sinon.stub(console, 'warn');

    const suppliedDappHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : `__TESTDATA__/e2e-auth-connect-presupplied-${TestDataGenerator.randomString(8)}`,
    });
    await suppliedDappHarness.clearStorage();
    await suppliedDappHarness.createAgentDid();

    const protocolUri = `https://e2e-test.example/${TestDataGenerator.randomString(15)}`;
    const protocolDef = createEncryptedProtocol(protocolUri);

    const EncTestProtocol = defineProtocol(protocolDef as ProtocolDefinition, encryptedCodecs);

    try {
      const auth = await AuthManager.create({
        agent          : suppliedDappHarness.agent as EnboxUserAgent,
        password       : 'test-password',
        storage        : new MemoryStorage(),
        connectHandler : new InProcessWalletHandler(
          walletHarness.agent,
          walletDid.uri,
          { preSupplyDelegateDid: true },
        ),
      });

      const session = await auth.connect({
        protocols: [protocolDef],
      });

      expect(session.did).toBe(walletDid.uri);
      expect(session.delegateDid).toBeDefined();
      expect(session.delegateDid).not.toBe(walletDid.uri);

      const envelope = await queryWrappedGrantKeyEnvelope({
        agent       : walletHarness.agent,
        ownerDid    : walletDid.uri,
        delegateDid : session.delegateDid!,
        protocol    : protocolUri,
      });
      expect(envelope.format).toBe(WRAPPED_GRANT_KEY_FORMAT);

      const walletRecordData = { type: 'receive', amount: 700 };
      const walletWrite = await walletHarness.agent.processDwnRequest({
        author        : walletDid.uri,
        target        : walletDid.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : protocolUri,
          protocolPath : 'transaction',
          schema       : protocolDef.types.transaction.schema,
          dataFormat   : 'application/json',
        },
        dataStream: new Blob([JSON.stringify(walletRecordData)]),
      });
      expect(walletWrite.reply.status.code).toBe(202);
      expect((walletWrite.message as any).encryption).toBeDefined();
      const walletWriteMessage = await queryDataEncodedRecord({
        agent    : walletHarness.agent,
        ownerDid : walletDid.uri,
        recordId : walletWrite.message!.recordId,
      });
      await fanOutDataEncodedRecords(walletHarness.agent, walletDid.uri, [
        walletWriteMessage,
      ]);

      const enbox = Enbox.fromSession(session);
      const typed = enbox.using(EncTestProtocol);
      const hydratedRecord = await typed.records.read('transaction', {
        from   : walletDid.uri,
        filter : { recordId: walletWrite.message!.recordId },
      });
      expect(hydratedRecord).toBeDefined();
      expect(await hydratedRecord!.value()).toEqual(walletRecordData);

      const delegateRecordData = { type: 'send', amount: 250 };
      const delegateRecord = await typed.records.create('transaction', {
        data: delegateRecordData,
      });
      expect((delegateRecord.rawMessage as any).encryption).toBeDefined();
      expect(await delegateRecord.value()).toEqual(delegateRecordData);
    } finally {
      await suppliedDappHarness.clearStorage();
      await suppliedDappHarness.closeStorage();
    }
  });
});
