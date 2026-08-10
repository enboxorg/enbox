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
      getRemoteDwnEndpointUrls : sinon.stub().resolves(options.endpoints ?? ['https://dwn.example/']),
      getEncryptionKeyDeriver  : sinon.stub().resolves({
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

      // The upgrade re-configures locally from the definition-owned policy.
      const configures = configureCalls(processDwnRequest);
      expect(configures).toHaveLength(1);
      expect((configures[0].args[0] as Record<string, unknown>).encryption).toBeUndefined();

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

    it('should preserve endpoint resolution failures before configuring locally', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent();
      (agent.dwn.getRemoteDwnEndpointUrls as sinon.SinonStub)
        .rejects(new Error('DID does not advertise a #dwn service'));

      await expect(prepareProtocol('did:example:owner', agent, encryptedProtocol))
        .rejects.toThrow('DID does not advertise a #dwn service');

      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should throw when the local configure is rejected', async () => {
      const { agent } = stubAgent({ configureStatus: { code: 400, detail: 'Invalid definition' } });

      await expect(prepareProtocol('did:example:owner', agent, notesProtocol))
        .rejects.toThrow('Could not configure protocol locally: Invalid definition');
    });
  });
});

// ---------------------------------------------------------------------------
// Composed protocols (`uses` dependencies) and failure surfacing
// ---------------------------------------------------------------------------

/** Per-endpoint simulated DWN state for the composed-protocol tests. */
type SimEndpoint = {
  protocols: Map<string, DwnProtocolDefinition>;
  /** Returns a rejection for a configure of the given protocol URI. */
  rejectConfigure?: (protocolUri: string) => { code: number; detail: string } | undefined;
  /** Accept configures with 202 but never store them (convergence failure). */
  acceptButDrop?: boolean;
  /** Reject postcondition/verification queries with this status. */
  rejectQueries?: { code: number; detail: string };
};

type SimSend = { dwnUrl: string; kind: 'query' | 'configure'; protocolUri: string };

/**
 * Simulation stub: a local DWN keyed by protocol URI and remote endpoints
 * with mutable per-URI state — configure sends are stored (unless dropped or
 * rejected), so postcondition re-queries converge naturally. Records every
 * remote send in order for dependency-ordering assertions.
 */
function simAgent(options: {
  local: Record<string, DwnProtocolDefinition>;
  remotes: Record<string, SimEndpoint>;
}): { agent: EnboxPlatformAgent; sends: SimSend[] } {
  const local = new Map(Object.entries(options.local));
  const queryTokens = new Map<string, { descriptor: { interface: string; method: string }; protocolUri: string }>();
  const queryTokenFor = (protocolUri: string): { descriptor: { interface: string; method: string }; protocolUri: string } => {
    let token = queryTokens.get(protocolUri);
    if (token === undefined) {
      token = { descriptor: { interface: 'Protocols', method: 'Query' }, protocolUri };
      queryTokens.set(protocolUri, token);
    }
    return token;
  };
  const entryFor = (definition: DwnProtocolDefinition): { descriptor: { interface: string; method: string; definition: DwnProtocolDefinition } } =>
    ({ descriptor: { interface: 'Protocols', method: 'Configure', definition } });

  const sends: SimSend[] = [];

  const processDwnRequest = sinon.stub().callsFake(async (request: any) => {
    if (request.messageType === DwnInterface.ProtocolsConfigure) {
      const definition = request.messageParams.definition as DwnProtocolDefinition;
      local.set(definition.protocol, definition);
      return {
        messageCid : '',
        reply      : { status: { code: 202, detail: 'Accepted' } },
        message    : entryFor(definition),
      };
    }
    const protocolUri = request.messageParams.filter.protocol as string;
    const installed = local.get(protocolUri);
    return {
      messageCid : '',
      reply      : {
        status  : { code: 200, detail: 'OK' },
        entries : installed === undefined ? [] : [entryFor(installed)],
      },
      message: queryTokenFor(protocolUri),
    };
  });

  const sendDwnRequest = sinon.stub().callsFake(async (request: any) => {
    const endpoint = options.remotes[request.dwnUrl];
    if (endpoint === undefined) {
      throw new Error(`connection refused: ${request.dwnUrl}`);
    }
    const message = request.message;
    if (typeof message.protocolUri === 'string') {
      sends.push({ dwnUrl: request.dwnUrl, kind: 'query', protocolUri: message.protocolUri });
      if (endpoint.rejectQueries !== undefined) {
        return { status: endpoint.rejectQueries };
      }
      const installed = endpoint.protocols.get(message.protocolUri);
      return {
        status  : { code: 200, detail: 'OK' },
        entries : installed === undefined ? [] : [entryFor(installed)],
      };
    }
    const definition = message.descriptor.definition as DwnProtocolDefinition;
    sends.push({ dwnUrl: request.dwnUrl, kind: 'configure', protocolUri: definition.protocol });
    const rejection = endpoint.rejectConfigure?.(definition.protocol);
    if (rejection !== undefined) {
      return { status: rejection };
    }
    if (!endpoint.acceptButDrop) {
      endpoint.protocols.set(definition.protocol, definition);
    }
    return { status: { code: 202, detail: 'Accepted' } };
  });

  const agent = {
    processDwnRequest,
    rpc : { sendDwnRequest },
    dwn : {
      getRemoteDwnEndpointUrls : sinon.stub().resolves(Object.keys(options.remotes)),
      getEncryptionKeyDeriver  : sinon.stub().rejects(new Error('no encrypted types in these fixtures')),
    },
  };

  return { agent: agent as unknown as EnboxPlatformAgent, sends };
}

const DEPENDENCY_URI = 'https://example.com/protocols/membership';
const COMPOSED_URI = 'https://example.com/protocols/board';
const BASE_URI = 'https://example.com/protocols/base';

const dependencyProtocol: DwnProtocolDefinition = {
  protocol  : DEPENDENCY_URI,
  published : true,
  types     : { link: { schema: 'link' } },
  structure : { link: { $actions: [] } },
};

/** A protocol with one composition dependency. */
const composedProtocol: DwnProtocolDefinition = {
  protocol  : COMPOSED_URI,
  published : true,
  uses      : { membership: DEPENDENCY_URI },
  types     : { card: { schema: 'card' } },
  structure : { card: { $actions: [] } },
} as DwnProtocolDefinition;

describe('connect protocol preparation — composed protocols', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should propagate an out-of-batch uses dependency to endpoints missing the dependent', async () => {
    // Locally: composed + its dependency installed (identity bootstrap).
    // Remotely: the endpoint has NEITHER (sync lag / wiped dev server) —
    // exactly the state where the dependent's configure would be rejected
    // with ProtocolsConfigureComposedProtocolNotInstalled.
    const { agent, sends } = simAgent({
      local   : { [COMPOSED_URI]: composedProtocol, [DEPENDENCY_URI]: dependencyProtocol },
      remotes : { 'https://dwn-a.example/': { protocols: new Map() } },
    });

    await prepareProtocol('did:example:owner', agent, composedProtocol);

    const configures = sends.filter((send) => send.kind === 'configure');
    expect(configures.map((send) => send.protocolUri)).toEqual([DEPENDENCY_URI, COMPOSED_URI]);
  });

  it('should not send a uses dependency that the endpoint already has', async () => {
    const { agent, sends } = simAgent({
      local   : { [COMPOSED_URI]: composedProtocol, [DEPENDENCY_URI]: dependencyProtocol },
      remotes : {
        'https://dwn-a.example/': { protocols: new Map([[DEPENDENCY_URI, dependencyProtocol]]) },
      },
    });

    await prepareProtocol('did:example:owner', agent, composedProtocol);

    const configures = sends.filter((send) => send.kind === 'configure');
    expect(configures.map((send) => send.protocolUri)).toEqual([COMPOSED_URI]);
  });

  it('should propagate transitive uses dependencies depth-first', async () => {
    const baseProtocol: DwnProtocolDefinition = {
      protocol  : BASE_URI,
      published : true,
      types     : { atom: { schema: 'atom' } },
      structure : { atom: { $actions: [] } },
    };
    const midProtocol = {
      ...dependencyProtocol,
      uses: { base: BASE_URI },
    } as DwnProtocolDefinition;
    const topProtocol = {
      ...composedProtocol,
      uses: { membership: DEPENDENCY_URI },
    } as DwnProtocolDefinition;

    const { agent, sends } = simAgent({
      local   : { [COMPOSED_URI]: topProtocol, [DEPENDENCY_URI]: midProtocol, [BASE_URI]: baseProtocol },
      remotes : { 'https://dwn-a.example/': { protocols: new Map() } },
    });

    await prepareProtocol('did:example:owner', agent, topProtocol);

    const configures = sends.filter((send) => send.kind === 'configure');
    expect(configures.map((send) => send.protocolUri)).toEqual([BASE_URI, DEPENDENCY_URI, COMPOSED_URI]);
  });

  it('should surface the endpoint rejection reason in the postcondition error', async () => {
    const { agent } = simAgent({
      local   : { [COMPOSED_URI]: composedProtocol },
      remotes : {
        'https://dwn-a.example/': {
          protocols       : new Map(),
          rejectConfigure : (uri) => uri === COMPOSED_URI
            ? { code: 400, detail: `composed protocol '${DEPENDENCY_URI}' (alias 'membership') is not installed for tenant` }
            : undefined,
        },
      },
    });

    // The dependency is missing locally too, so it cannot be propagated —
    // the error must carry BOTH the local-dependency reason (first wins)
    // and identify the failing endpoint.
    await expect(prepareProtocol('did:example:owner', agent, composedProtocol))
      .rejects.toThrow(/dwn-a\.example.*uses dependency '.*membership' is not installed locally/);
  });

  it('should surface a configure rejection when dependencies are satisfied', async () => {
    const { agent } = simAgent({
      local   : { [COMPOSED_URI]: composedProtocol, [DEPENDENCY_URI]: dependencyProtocol },
      remotes : {
        'https://dwn-a.example/': {
          protocols       : new Map([[DEPENDENCY_URI, dependencyProtocol]]),
          rejectConfigure : () => ({ code: 401, detail: 'Not a registered tenant.' }),
        },
      },
    });

    await expect(prepareProtocol('did:example:owner', agent, composedProtocol))
      .rejects.toThrow(/dwn-a\.example.*configure rejected \(401\): Not a registered tenant\./);
  });

  it('should surface the observed state when an endpoint accepts but never converges', async () => {
    const { agent } = simAgent({
      local   : { [DEPENDENCY_URI]: dependencyProtocol },
      remotes : {
        'https://dwn-a.example/': { protocols: new Map(), acceptButDrop: true },
      },
    });

    await expect(prepareProtocol('did:example:owner', agent, dependencyProtocol))
      .rejects.toThrow(/dwn-a\.example.*still reports 'install' after configure/);
  });
});
