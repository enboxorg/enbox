import type { BearerDid } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { DwnApi, ProtocolsQueryRequest } from '../src/dwn-api.js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { ProtocolsConfigure } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi as DwnApiClass } from '../src/dwn-api.js';
import { recordCodecs } from '../src/record-codec.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { stripEncryptionBlocks, TypedEnbox, WalletReapprovalRequiredError } from '../src/typed-enbox.js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// TypedEnbox.verifyInstalled() — strict, read-only install verification:
// canonical definition compare + $keyAgreement coverage, with owner/delegate
// aware statuses. Owner statuses run against the real harness; delegate
// statuses stub the DwnApi boundary (the real flow needs a wallet-connect
// ceremony against external infra).
// ---------------------------------------------------------------------------

function makePlainDefinition(protocolUri: string): ProtocolDefinition {
  return {
    protocol  : protocolUri,
    published : true,
    types     : {
      note: { schema: `${protocolUri}/schemas/note`, dataFormats: ['application/json'] },
    },
    structure: {
      note: { $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
    },
  };
}

function makeEncryptedDefinition(protocolUri: string): ProtocolDefinition {
  return {
    protocol  : protocolUri,
    published : true,
    types     : {
      secret: {
        schema             : `${protocolUri}/schemas/secret`,
        dataFormats        : ['application/json'],
        encryptionRequired : true,
      },
    },
    structure: {
      secret: {},
    },
  };
}

const encryptedCodecs = { secret: recordCodecs.json<unknown>() };
const plainCodecs = { note: recordCodecs.json<unknown>() };

/**
 * A minimal DwnApi stand-in for delegate-mode and crafted-installation cases:
 * `verifyInstalled()` touches only `isDelegate`, `connectedDid`,
 * `protocols.query`, and (never, if correct) `importProtocolConfiguration`.
 */
function makeFakeDwn(options: {
  isDelegate: boolean;
  installedDefinition?: ProtocolDefinition;
  queryStatus?: { code: number; detail: string };
}): { dwn: DwnApi; queryRequests: ProtocolsQueryRequest[]; importCalls: number } {
  const state = { importCalls: 0 };
  const queryRequests: ProtocolsQueryRequest[] = [];
  const dwn = {
    get isDelegate(): boolean { return options.isDelegate; },
    get connectedDid(): string { return 'did:example:owner'; },
    get protocols(): { query: (request: ProtocolsQueryRequest) => Promise<unknown> } {
      return {
        query: async (request: ProtocolsQueryRequest): Promise<unknown> => {
          queryRequests.push(request);
          return {
            status    : options.queryStatus ?? { code: 200, detail: 'OK' },
            protocols : options.installedDefinition === undefined
              ? []
              : [{ definition: options.installedDefinition }],
          };
        },
      };
    },
    importProtocolConfiguration: async (): Promise<never> => {
      state.importCalls += 1;
      throw new Error('verifyInstalled() must never import a protocol configuration');
    },
  } as unknown as DwnApi;

  return { dwn, queryRequests, get importCalls(): number { return state.importCalls; } };
}

describe('TypedEnbox.verifyInstalled()', () => {
  describe('owner sessions (real harness)', () => {
    let aliceDid: BearerDid;
    let dwnAlice: DwnApiClass;
    let testHarness: PlatformAgentTestHarness;
    let protocolUri: string;

    beforeAll(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass       : EnboxUserAgent,
        agentStores      : 'memory',
        testDataLocation : '__TESTDATA__/typed-verify-installed',
      });

      await testHarness.clearStorage();
      await testHarness.createAgentDid();

      const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
      aliceDid = alice.did;

      dwnAlice = new DwnApiClass({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    });

    beforeEach(async () => {
      sinon.restore();
      await testHarness.syncStore.clear();
      await testHarness.dwnDataStore.clear();
      await testHarness.dwnMessageStore.clear();
      await testHarness.dwnResumableTaskStore.clear();
      await testHarness.agent.permissions.clear();
      testHarness.dwnStores.clear();

      protocolUri = `https://example.com/protocols/verify-${TestDataGenerator.randomString(15)}`;
    });

    afterAll(async () => {
      sinon.restore();
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    it('should report owner-can-update when the protocol is not installed', async () => {
      const definition = makePlainDefinition(protocolUri);
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, plainCodecs));

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('owner-can-update');
      expect(result.installed).toBe(false);
      expect(result.definitionsMatch).toBe(false);
      expect(result.reason).toContain('not installed');
      expect(result.error).toBeUndefined();
    });

    it('should report up-to-date for a matching plain installation', async () => {
      const definition = makePlainDefinition(protocolUri);
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, plainCodecs));

      const { status } = await typed.configure();
      expect(status.code).toBe(202);

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('up-to-date');
      expect(result.installed).toBe(true);
      expect(result.definitionsMatch).toBe(true);
      expect(result.missingKeyAgreementPaths).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    it('should report owner-can-update when the installed definition drifted', async () => {
      const installedDefinition = makePlainDefinition(protocolUri);
      const { status } = await dwnAlice.protocols.configure({ definition: installedDefinition });
      expect(status.code).toBe(202);

      // The application now ships a revised definition (an extra type + path).
      const revisedDefinition: ProtocolDefinition = {
        ...makePlainDefinition(protocolUri),
        types: {
          ...installedDefinition.types,
          attachment: { dataFormats: ['application/octet-stream'] },
        },
        structure: {
          ...installedDefinition.structure,
          attachment: {},
        },
      };
      const typed = new TypedEnbox(dwnAlice, defineProtocol(revisedDefinition, {
        attachment: recordCodecs.bytes(),
        ...plainCodecs,
      }));

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('owner-can-update');
      expect(result.installed).toBe(true);
      expect(result.definitionsMatch).toBe(false);
      expect(result.reason).toContain('differs');
      expect(result.error).toBeUndefined();
    });

    it('should report up-to-date for an encrypted install with full $keyAgreement coverage', async () => {
      const definition = makeEncryptedDefinition(protocolUri);
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, encryptedCodecs));

      // configure() auto-enables encryption for encrypted types, deriving and
      // injecting $keyAgreement at the root and every structure path.
      const { status } = await typed.configure();
      expect(status.code).toBe(202);

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('up-to-date');
      expect(result.missingKeyAgreementPaths).toEqual([]);
    });

    it('should report owner-can-update with the missing paths when $keyAgreement coverage is partial', async () => {
      // The engine fail-closes on keys missing at the root or at ENCRYPTED
      // paths, but accepts an install whose non-encrypted paths lack keys —
      // while the injection covers EVERY path. Install exactly that
      // engine-accepted, partially-keyed state as a pre-constructed raw
      // ProtocolsConfigure so the agent does not derive the missing keys.
      const keyAgreement = {
        publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo' },
      };
      const codeDefinition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : true,
        types     : {
          secret : { schema: `${protocolUri}/schemas/secret`, dataFormats: ['application/json'], encryptionRequired: true },
          note   : { schema: `${protocolUri}/schemas/note`, dataFormats: ['application/json'] },
        },
        structure: {
          secret : {},
          note   : {},
        },
      };
      const partiallyKeyedDefinition = {
        ...codeDefinition,
        $keyAgreement : keyAgreement,
        structure     : {
          secret : { $keyAgreement: keyAgreement },
          note   : {},
        },
      } as unknown as ProtocolDefinition;

      const didSigner = await aliceDid.getSigner();
      const protocolsConfigure = await ProtocolsConfigure.create({
        definition : partiallyKeyedDefinition,
        signer     : {
          algorithm : didSigner.algorithm,
          keyId     : didSigner.keyId,
          sign      : async (data: Uint8Array): Promise<Uint8Array> => didSigner.sign({ data }),
        },
      });
      const rawReply = await testHarness.agent.dwn.processRawMessage(aliceDid.uri, protocolsConfigure.message);
      expect(rawReply.status.code).toBe(202);

      const typed = new TypedEnbox(dwnAlice, defineProtocol(codeDefinition, {
        note   : recordCodecs.json<unknown>(),
        secret : recordCodecs.json<unknown>(),
      }));
      const result = await typed.verifyInstalled();

      expect(result.status).toBe('owner-can-update');
      expect(result.installed).toBe(true);
      // The definitions still canonically match ($keyAgreement is stripped
      // before comparison) — the key coverage check is what fails.
      expect(result.definitionsMatch).toBe(true);
      // Root and `secret` carry keys; the uncovered path is `note`.
      expect(result.missingKeyAgreementPaths).toEqual(['note']);
      expect(result.reason).toContain('$keyAgreement');
    });

    it('should not change configure() auto-configure state (read-only)', async () => {
      const definition = makePlainDefinition(protocolUri);
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, plainCodecs));

      await typed.verifyInstalled();

      // verifyInstalled() must not install or mark the protocol configured.
      expect(typed.isConfigured).toBe(false);
      const { protocols } = await dwnAlice.protocols.query({ filter: { protocol: protocolUri } });
      expect(protocols).toHaveLength(0);
    });
  });

  describe('delegate sessions (stubbed DwnApi boundary)', () => {
    const protocolUri = 'https://example.com/protocols/verify-delegate';

    it('should report up-to-date when the wallet-installed definition matches', async () => {
      const definition = makePlainDefinition(protocolUri);
      const fake = makeFakeDwn({ isDelegate: true, installedDefinition: definition });
      const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, plainCodecs));

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('up-to-date');
      // The wallet's definition is fetched from the OWNER tenant, remotely.
      expect(fake.queryRequests).toHaveLength(1);
      expect(fake.queryRequests[0].from).toBe('did:example:owner');
      expect(fake.importCalls).toBe(0);
    });

    it('should return wallet-reapproval-required with a typed error for a stale wallet definition', async () => {
      const definition = makePlainDefinition(protocolUri);
      const staleWalletDefinition: ProtocolDefinition = {
        ...definition,
        types: {
          note    : definition.types.note,
          archive : { dataFormats: ['application/json'] },
        },
        structure: {
          ...definition.structure,
          archive: {},
        },
      };
      const fake = makeFakeDwn({ isDelegate: true, installedDefinition: staleWalletDefinition });
      const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, plainCodecs));

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('wallet-reapproval-required');
      expect(result.installed).toBe(true);
      expect(result.definitionsMatch).toBe(false);
      expect(result.error).toBeInstanceOf(WalletReapprovalRequiredError);
      expect(result.error!.protocol).toBe(protocolUri);
      expect(result.error!.message).toContain('re-approve');
      expect(result.reason).toBe(result.error!.message);
      // The stale definition is REPORTED, never silently imported.
      expect(fake.importCalls).toBe(0);
    });

    it('should return wallet-reapproval-required when the wallet never installed the protocol', async () => {
      const definition = makePlainDefinition(protocolUri);
      const fake = makeFakeDwn({ isDelegate: true });
      const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, plainCodecs));

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('wallet-reapproval-required');
      expect(result.installed).toBe(false);
      expect(result.error).toBeInstanceOf(WalletReapprovalRequiredError);
    });

    it('should return wallet-reapproval-required for an encrypted wallet install missing $keyAgreement keys', async () => {
      const definition = makeEncryptedDefinition(protocolUri);
      // Wallet installed the right shape but never injected encryption keys.
      const fake = makeFakeDwn({ isDelegate: true, installedDefinition: definition });
      const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, encryptedCodecs));

      const result = await typed.verifyInstalled();

      expect(result.status).toBe('wallet-reapproval-required');
      expect(result.definitionsMatch).toBe(true);
      expect(result.missingKeyAgreementPaths).toEqual(['', 'secret']);
    });

    it('should reject composed typed protocols until referenced policy is explicit', () => {
      const definition = {
        protocol  : 'https://example.com/protocols/verify-ref',
        published : true,
        uses      : { threads: 'https://example.com/protocols/threads' },
        types     : {
          comment: {
            schema      : 'https://example.com/protocols/verify-ref/schemas/comment',
            dataFormats : ['application/json'],
          },
        },
        structure: {
          thread: {
            $ref    : 'threads:thread',
            comment : {},
          },
        },
      } as const satisfies ProtocolDefinition;
      const codecs = {
        comment : recordCodecs.json<unknown>(),
        thread  : recordCodecs.json<unknown>(),
      };

      expect(() => defineProtocol(definition, codecs)).toThrow(
        'Typed protocols do not yet support $ref at \'thread\'',
      );
      expect(() => new TypedEnbox({} as DwnApi, { definition, codecs })).toThrow(
        'Typed protocols do not yet support $ref at \'thread\'',
      );
    });

    it('should throw (not classify) when the delegate protocol query itself fails', async () => {
      const definition = makePlainDefinition(protocolUri);
      const fake = makeFakeDwn({
        isDelegate  : true,
        queryStatus : { code: 401, detail: 'grant revoked' },
      });
      const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, plainCodecs));

      await expect(typed.verifyInstalled()).rejects.toThrow('401 grant revoked');
    });

    it('should throw (not classify) when the owner protocol query itself fails', async () => {
      const definition = makePlainDefinition(protocolUri);
      const fake = makeFakeDwn({
        isDelegate  : false,
        queryStatus : { code: 500, detail: 'store unavailable' },
      });
      const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, plainCodecs));

      // A failed local read must never be classified as "not installed".
      await expect(typed.verifyInstalled()).rejects.toThrow('500 store unavailable');
    });
  });

  describe('stripEncryptionBlocks()', () => {
    it('should strip $encryption and $keyAgreement blocks recursively without mutating the input', () => {
      const input = {
        protocol      : 'https://example.com/p',
        $keyAgreement : { publicKeyJwk: { x: 'root' } },
        structure     : {
          doc: {
            $keyAgreement : { publicKeyJwk: { x: 'doc' } },
            $encryption   : { rootKeyId: 'k' },
            child         : { $keyAgreement: { publicKeyJwk: { x: 'child' } } },
          },
        },
      };

      const stripped = stripEncryptionBlocks(input) as Record<string, unknown>;

      expect(stripped).toEqual({
        protocol  : 'https://example.com/p',
        structure : { doc: { child: {} } },
      });
      // The original is untouched.
      expect(input.$keyAgreement).toBeDefined();
      expect(input.structure.doc.$encryption).toBeDefined();
    });
  });
});
