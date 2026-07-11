import type { DwnProtocolDefinition } from '../src/types/dwn.js';
import type { EnboxPlatformAgent } from '../src/types/agent.js';

import { KeyDerivationScheme } from '@enbox/dwn-sdk-js';
import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { DwnInterface } from '../src/types/dwn.js';
import {
  getProtocolSetupStatus,
  hasEncryptedProtocolTypes,
  prepareProtocol,
  protocolDefinitionsMatch,
} from '../src/connect-protocol-preparation.js';

/** The signed local ProtocolsQuery message reused for remote verification. */
const signedProtocolQuery = { descriptor: { interface: 'Protocols', method: 'Query' } };
const signedProtocolConfigure = { descriptor: { interface: 'Protocols', method: 'Configure' } };

const encryptedProtocol: DwnProtocolDefinition = {
  protocol  : 'https://example.com/protocols/demo',
  published : false,
  types     : {
    mint  : { schema: 'mint' },
    proof : { schema: 'proof', encryptionRequired: true },
  },
  structure: {
    mint: {
      $actions : [],
      proof    : {
        $actions: [],
      },
    },
  },
};

/** The encrypted protocol as installed with owner-derived `$keyAgreement` keys. */
const installedEncryptedProtocol: DwnProtocolDefinition = {
  ...encryptedProtocol,
  $keyAgreement : { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'protocol-key' } },
  structure     : {
    mint: {
      $actions      : [],
      $keyAgreement : { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'mint-key' } },
      proof         : {
        $actions      : [],
        $keyAgreement : { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'proof-key' } },
      },
    },
  },
} as DwnProtocolDefinition;

const notesProtocol: DwnProtocolDefinition = {
  protocol  : 'https://example.com/protocols/notes',
  published : false,
  types     : {
    note: { schema: 'note' },
  },
  structure: {
    note: {
      $actions: [],
    },
  },
};

type StubQueryReply = {
  status: { code: number; detail: string };
  entries: Array<{ descriptor: { interface: string; method: string; definition: DwnProtocolDefinition } }>;
};

function protocolQueryReply(definition?: DwnProtocolDefinition): StubQueryReply {
  return {
    status  : { code: 200, detail: 'OK' },
    entries : definition === undefined ? [] : [{ descriptor: { interface: 'Protocols', method: 'Configure', definition } }],
  };
}

type StubAgentOptions = {
  installed?: DwnProtocolDefinition;
  endpoints?: string[];
  /** Remote definition on the first query per endpoint. */
  remoteBefore?: DwnProtocolDefinition;
  /** Remote definition on subsequent (postcondition) queries per endpoint. */
  remoteAfter?: DwnProtocolDefinition;
  configureStatus?: { code: number; detail: string };
};

/**
 * Builds a stub agent whose local DWN reports `installed`, whose endpoints
 * report `remoteBefore` → `remoteAfter` on successive signed queries, and
 * whose key deriver returns the owner keys baked into
 * `installedEncryptedProtocol` for their derivation paths.
 */
function stubAgent(options: StubAgentOptions = {}): {
  agent: EnboxPlatformAgent;
  processDwnRequest: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
} {
  const keysByPath = new Map([
    [JSON.stringify([KeyDerivationScheme.ProtocolPath, encryptedProtocol.protocol]), 'protocol-key'],
    [JSON.stringify([KeyDerivationScheme.ProtocolPath, encryptedProtocol.protocol, 'mint']), 'mint-key'],
    [JSON.stringify([KeyDerivationScheme.ProtocolPath, encryptedProtocol.protocol, 'mint', 'proof']), 'proof-key'],
  ]);

  const processDwnRequest = sinon.stub().callsFake(async (request: { messageType: string }) =>
    request.messageType === DwnInterface.ProtocolsConfigure
      ? {
        messageCid : '',
        reply      : { status: options.configureStatus ?? { code: 202, detail: 'Accepted' } },
        message    : signedProtocolConfigure,
      }
      : {
        messageCid : '',
        reply      : protocolQueryReply(options.installed),
        message    : signedProtocolQuery,
      });

  const queriesSeen = new Map<string, number>();
  const sendDwnRequest = sinon.stub().callsFake(async (request: { dwnUrl: string; message: unknown }) => {
    if (request.message === signedProtocolQuery) {
      const seen = queriesSeen.get(request.dwnUrl) ?? 0;
      queriesSeen.set(request.dwnUrl, seen + 1);
      return protocolQueryReply(seen === 0 ? options.remoteBefore : options.remoteAfter);
    }
    return { status: { code: 202, detail: 'Accepted' } };
  });

  const agent = {
    processDwnRequest,
    rpc : { sendDwnRequest },
    dwn : {
      getDwnEndpointUrlsForTarget : sinon.stub().resolves(options.endpoints ?? []),
      getEncryptionKeyDeriver     : sinon.stub().resolves({
        rootKeyId        : 'urn:test:owner-root',
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        derivePublicKey  : async (path: string[]) => ({
          kty : 'OKP',
          crv : 'X25519',
          x   : keysByPath.get(JSON.stringify(path)) ?? 'unexpected-path-key',
        }),
      }),
    },
  };

  return { agent: agent as unknown as EnboxPlatformAgent, processDwnRequest, sendDwnRequest };
}

function configureCalls(processDwnRequest: sinon.SinonStub): sinon.SinonSpyCall[] {
  return processDwnRequest.getCalls().filter(
    (call) => call.args[0].messageType === DwnInterface.ProtocolsConfigure,
  );
}

function remoteConfigureSends(sendDwnRequest: sinon.SinonStub): sinon.SinonSpyCall[] {
  return sendDwnRequest.getCalls().filter(
    (call) => call.args[0].message !== signedProtocolQuery,
  );
}

describe('connect protocol preparation', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('setup-status analysis', () => {
    it('should detect encrypted protocols', () => {
      expect(hasEncryptedProtocolTypes(encryptedProtocol)).toBe(true);
      expect(hasEncryptedProtocolTypes(notesProtocol)).toBe(false);
    });

    it('should treat owner-injected encryption metadata as policy-identical', () => {
      expect(protocolDefinitionsMatch(installedEncryptedProtocol, encryptedProtocol)).toBe(true);
      expect(getProtocolSetupStatus(installedEncryptedProtocol, encryptedProtocol)).toBe('configured');
    });

    it('should reject requester-supplied wallet key metadata', () => {
      const requestedWithKeys = {
        ...notesProtocol,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'requester-key' } },
      } as DwnProtocolDefinition;

      expect(getProtocolSetupStatus(undefined, requestedWithKeys)).toBe('conflict');
    });

    it('should reject non-normalized protocol URIs', () => {
      const nonNormalized = {
        ...notesProtocol,
        protocol: 'HTTPS://example.com/protocols/notes',
      } as DwnProtocolDefinition;

      expect(getProtocolSetupStatus(undefined, nonNormalized)).toBe('conflict');
    });

    it('should detect differing installed definitions as conflicts', () => {
      const olderInstalled = {
        ...notesProtocol,
        types: { note: { schema: 'old-note' } },
      } as DwnProtocolDefinition;

      expect(getProtocolSetupStatus(olderInstalled, notesProtocol)).toBe('conflict');
    });
  });

  describe('prepareProtocol', () => {
    it('should verify remotes without configuring when local and remote installs are current', async () => {
      const endpoints = ['https://dwn-a.example/', 'https://dwn-b.example/'];
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed    : installedEncryptedProtocol,
        endpoints,
        remoteBefore : installedEncryptedProtocol,
      });

      await prepareProtocol('did:example:owner', agent, encryptedProtocol);

      expect(processDwnRequest.callCount).toBe(1);
      expect(remoteConfigureSends(sendDwnRequest)).toHaveLength(0);
      // Every endpoint was verified with the signed query.
      const queried = sendDwnRequest.getCalls().map((call) => call.args[0].dwnUrl);
      expect(new Set(queried)).toEqual(new Set(endpoints));
    });

    it('should perform an encryption upgrade when the installed definition is missing $keyAgreement keys', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed    : encryptedProtocol, // policy-identical, no keys
        endpoints    : ['https://dwn-a.example/'],
        remoteBefore : encryptedProtocol,
        remoteAfter  : installedEncryptedProtocol, // converges after fan-out
      });

      await prepareProtocol('did:example:owner', agent, encryptedProtocol);

      // The upgrade re-configures locally WITH encryption derivation.
      const configures = configureCalls(processDwnRequest);
      expect(configures).toHaveLength(1);
      expect((configures[0].args[0] as { encryption?: boolean }).encryption).toBe(true);

      // The freshly signed configure is fanned out to the behind endpoint.
      const sends = remoteConfigureSends(sendDwnRequest);
      expect(sends).toHaveLength(1);
      expect(sends[0].args[0].message).toBe(signedProtocolConfigure);
    });

    it('should fan out the stored configure entry when local is current but a remote is missing it', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed   : installedEncryptedProtocol,
        endpoints   : ['https://dwn-a.example/'],
        remoteAfter : installedEncryptedProtocol,
      });

      await prepareProtocol('did:example:owner', agent, encryptedProtocol);

      // No re-sign: the single processDwnRequest call is the local query, and
      // the fan-out reuses the stored configure entry from the local reply.
      expect(processDwnRequest.callCount).toBe(1);
      const sends = remoteConfigureSends(sendDwnRequest);
      expect(sends).toHaveLength(1);
      expect((sends[0].args[0].message as { descriptor: { definition?: unknown } }).descriptor.definition)
        .toEqual(installedEncryptedProtocol);
    });

    it('should throw on a local definition conflict without configuring anything', async () => {
      const olderInstalled = {
        ...notesProtocol,
        types: { note: { schema: 'old-note' } },
      } as DwnProtocolDefinition;
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed : olderInstalled,
        endpoints : ['https://dwn-a.example/'],
      });

      await expect(prepareProtocol('did:example:owner', agent, notesProtocol))
        .rejects.toThrow('already installed with a different definition');
      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should throw when installed encryption keys are not derived from the wallet owner', async () => {
      const poisonedInstall = {
        ...installedEncryptedProtocol,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'attacker-key' } },
      } as DwnProtocolDefinition;
      const { agent, sendDwnRequest } = stubAgent({
        installed : poisonedInstall,
        endpoints : ['https://dwn-a.example/'],
      });

      await expect(prepareProtocol('did:example:owner', agent, encryptedProtocol))
        .rejects.toThrow('encryption keys that do not match this wallet owner');
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should throw when requester-supplied key metadata reaches preparation', async () => {
      const requestedWithKeys = {
        ...notesProtocol,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'requester-key' } },
      } as DwnProtocolDefinition;
      const { agent } = stubAgent();

      await expect(prepareProtocol('did:example:owner', agent, requestedWithKeys))
        .rejects.toThrow('contains wallet-managed encryption keys');
    });

    it('should throw on a remote conflict before configuring locally', async () => {
      const remoteConflict = {
        ...notesProtocol,
        types: { note: { schema: 'https://example.com/schemas/other' } },
      } as DwnProtocolDefinition;
      const { agent, processDwnRequest } = stubAgent({
        endpoints    : ['https://dwn-a.example/'],
        remoteBefore : remoteConflict,
      });

      await expect(prepareProtocol('did:example:owner', agent, notesProtocol))
        .rejects.toThrow('conflicts with the latest definition');
      expect(configureCalls(processDwnRequest)).toHaveLength(0);
    });

    it('should fail closed when a reachable endpoint rejects the protocol query', async () => {
      const { agent, sendDwnRequest } = stubAgent({ endpoints: ['https://dwn-a.example/', 'https://dwn-b.example/'] });
      sendDwnRequest.callsFake(async (request: { dwnUrl: string }) =>
        request.dwnUrl === 'https://dwn-a.example/'
          ? { status: { code: 500, detail: 'Server error' } }
          : protocolQueryReply());

      await expect(prepareProtocol('did:example:owner', agent, notesProtocol))
        .rejects.toThrow('Could not verify protocol on https://dwn-a.example/: Server error');
    });

    it('should fail closed when every endpoint is unreachable', async () => {
      const { agent, sendDwnRequest } = stubAgent({ endpoints: ['https://dwn-a.example/', 'https://dwn-b.example/'] });
      sendDwnRequest.rejects(new Error('connection refused'));

      await expect(prepareProtocol('did:example:owner', agent, notesProtocol))
        .rejects.toThrow('Could not verify the protocol definition');
    });

    it('should fail closed when endpoints do not converge after the configure fan-out', async () => {
      const { agent } = stubAgent({
        endpoints: ['https://dwn-a.example/'],
        // Missing before AND after fan-out — the endpoint silently dropped it.
      });

      await expect(prepareProtocol('did:example:owner', agent, notesProtocol))
        .rejects.toThrow('Could not verify the latest protocol definition on every reachable DWN endpoint');
    });

    it('should configure locally without remote traffic when no endpoints resolve', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent();

      await prepareProtocol('did:example:owner', agent, encryptedProtocol);

      const configures = configureCalls(processDwnRequest);
      expect(configures).toHaveLength(1);
      expect((configures[0].args[0] as { encryption?: boolean }).encryption).toBe(true);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should throw when the local configure is rejected', async () => {
      const { agent } = stubAgent({ configureStatus: { code: 400, detail: 'Invalid definition' } });

      await expect(prepareProtocol('did:example:owner', agent, notesProtocol))
        .rejects.toThrow('Could not configure protocol locally: Invalid definition');
    });
  });
});
