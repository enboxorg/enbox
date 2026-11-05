import type { DwnModuleDefinition } from '../src/types/dwn.js';
import type { EnboxPlatformAgent } from '../src/types/agent.js';

import { KeyDerivationScheme } from '@enbox/dwn-sdk-js';
import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { DwnInterface } from '../src/types/dwn.js';
import {
  getModuleSetupStatus,
  hasEncryptedModuleTypes,
  inspectConnectModule,
  prepareModule,
} from '../src/connect-module-preparation.js';

/** The signed local ModulesQuery message reused for remote verification. */
const signedModuleQuery = { descriptor: { interface: 'Modules', method: 'Query' } };
const signedModuleConfigure = { descriptor: { interface: 'Modules', method: 'Configure' } };

const encryptedModule: DwnModuleDefinition = {
  module    : 'https://example.com/modules/demo',
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

/** The encrypted module as installed with owner-derived `$keyAgreement` keys. */
const installedEncryptedModule: DwnModuleDefinition = {
  ...encryptedModule,
  $keyAgreement : { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'module-key' } },
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
} as DwnModuleDefinition;

const notesModule: DwnModuleDefinition = {
  module    : 'https://example.com/modules/notes',
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
  entries: Array<{ descriptor: { interface: string; method: string; definition: DwnModuleDefinition } }>;
};

function moduleQueryReply(definition?: DwnModuleDefinition): StubQueryReply {
  return {
    status  : { code: 200, detail: 'OK' },
    entries : definition === undefined ? [] : [{ descriptor: { interface: 'Modules', method: 'Configure', definition } }],
  };
}

type StubAgentOptions = {
  installed?: DwnModuleDefinition;
  endpoints?: string[];
  /** Remote definition on the first query per endpoint. */
  remoteBefore?: DwnModuleDefinition;
  /** Remote definition on subsequent (postcondition) queries per endpoint. */
  remoteAfter?: DwnModuleDefinition;
  configureStatus?: { code: number; detail: string };
};

/**
 * Builds a stub agent whose local DWN reports `installed`, whose endpoints
 * report `remoteBefore` → `remoteAfter` on successive signed queries, and
 * whose key deriver returns the owner keys baked into
 * `installedEncryptedModule` for their derivation paths.
 */
function stubAgent(options: StubAgentOptions = {}): {
  agent: EnboxPlatformAgent;
  processDwnRequest: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
} {
  const keysByPath = new Map([
    [JSON.stringify([KeyDerivationScheme.ModulePath, encryptedModule.module]), 'module-key'],
    [JSON.stringify([KeyDerivationScheme.ModulePath, encryptedModule.module, 'mint']), 'mint-key'],
    [JSON.stringify([KeyDerivationScheme.ModulePath, encryptedModule.module, 'mint', 'proof']), 'proof-key'],
  ]);

  const processDwnRequest = sinon.stub().callsFake(async (request: { messageType: string }) =>
    request.messageType === DwnInterface.ModulesConfigure
      ? {
        messageCid : '',
        reply      : { status: options.configureStatus ?? { code: 202, detail: 'Accepted' } },
        message    : signedModuleConfigure,
      }
      : {
        messageCid : '',
        reply      : moduleQueryReply(options.installed),
        message    : signedModuleQuery,
      });

  const queriesSeen = new Map<string, number>();
  const sendDwnRequest = sinon.stub().callsFake(async (request: { dwnUrl: string; message: unknown }) => {
    if (request.message === signedModuleQuery) {
      const seen = queriesSeen.get(request.dwnUrl) ?? 0;
      queriesSeen.set(request.dwnUrl, seen + 1);
      return moduleQueryReply(seen === 0 ? options.remoteBefore : options.remoteAfter);
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
        derivationScheme : KeyDerivationScheme.ModulePath,
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
    (call) => call.args[0].messageType === DwnInterface.ModulesConfigure,
  );
}

function remoteConfigureSends(sendDwnRequest: sinon.SinonStub): sinon.SinonSpyCall[] {
  return sendDwnRequest.getCalls().filter(
    (call) => call.args[0].message !== signedModuleQuery,
  );
}

describe('connect module preparation', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('setup-status analysis', () => {
    it('should detect encrypted modules', () => {
      expect(hasEncryptedModuleTypes(encryptedModule)).toBe(true);
      expect(hasEncryptedModuleTypes(notesModule)).toBe(false);
    });

    it('should treat owner-injected encryption metadata as policy-identical', () => {
      expect(getModuleSetupStatus(installedEncryptedModule, encryptedModule)).toBe('configured');
    });

    it('should reject requester-supplied wallet key metadata', () => {
      const requestedWithKeys = {
        ...notesModule,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'requester-key' } },
      } as DwnModuleDefinition;

      expect(getModuleSetupStatus(undefined, requestedWithKeys)).toBe('conflict');
    });

    it('should reject non-normalized module URIs', () => {
      const nonNormalized = {
        ...notesModule,
        module: 'HTTPS://example.com/modules/notes',
      } as DwnModuleDefinition;

      expect(getModuleSetupStatus(undefined, nonNormalized)).toBe('conflict');
    });

    it('should detect differing installed definitions as conflicts', () => {
      const olderInstalled = {
        ...notesModule,
        types: { note: { schema: 'old-note' } },
      } as DwnModuleDefinition;

      expect(getModuleSetupStatus(olderInstalled, notesModule)).toBe('conflict');
    });
  });

  describe('inspectConnectModule', () => {
    it('should report an install without mutating module state', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent();

      await expect(inspectConnectModule({
        agent      : agent,
        ownerDid   : 'did:example:owner',
        definition : notesModule,
      })).resolves.toEqual({ status: 'install' });
      expect(processDwnRequest.callCount).toBe(1);
      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should report verified encryption upgrades and the installed definition', async () => {
      const { agent } = stubAgent({ installed: encryptedModule });

      await expect(inspectConnectModule({
        agent      : agent,
        ownerDid   : 'did:example:owner',
        definition : encryptedModule,
      })).resolves.toEqual({
        status              : 'upgrade',
        installedDefinition : encryptedModule,
      });
    });

    it('should identify owner-derived definition conflicts as override-eligible', async () => {
      const installedDefinition = {
        ...installedEncryptedModule,
        types: { ...installedEncryptedModule.types, legacy: { schema: 'legacy' } },
      } as DwnModuleDefinition;
      const { agent } = stubAgent({ installed: installedDefinition });

      await expect(inspectConnectModule({
        agent      : agent,
        ownerDid   : 'did:example:owner',
        definition : encryptedModule,
      })).resolves.toEqual({
        status                     : 'conflict',
        installedDefinition        : installedDefinition,
        definitionOverrideEligible : true,
        conflictReason             : `Module '${encryptedModule.module}' is already installed with a different definition. `
          + 'Replacement requires explicit owner approval and owner-derived encryption keys.',
      });
    });

    it('should not advertise an override when a definition conflict also has foreign owner keys', async () => {
      const installedDefinition = {
        ...installedEncryptedModule,
        types         : { ...installedEncryptedModule.types, legacy: { schema: 'legacy' } },
        $keyAgreement : { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'foreign-key' } },
      } as DwnModuleDefinition;
      const { agent } = stubAgent({ installed: installedDefinition });

      await expect(inspectConnectModule({
        agent      : agent,
        ownerDid   : 'did:example:owner',
        definition : encryptedModule,
      })).resolves.toEqual({
        status              : 'conflict',
        installedDefinition : installedDefinition,
        conflictReason      : `Module '${encryptedModule.module}' is already installed with a different definition. `
          + 'Replacement requires explicit owner approval and owner-derived encryption keys.',
      });
    });

    it('should distinguish owner-key conflicts from overridable definition conflicts', async () => {
      const installedDefinition = {
        ...installedEncryptedModule,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'attacker-key' } },
      } as DwnModuleDefinition;
      const { agent } = stubAgent({ installed: installedDefinition });

      await expect(inspectConnectModule({
        agent      : agent,
        ownerDid   : 'did:example:owner',
        definition : encryptedModule,
      })).resolves.toEqual({
        status              : 'conflict',
        installedDefinition : installedDefinition,
        conflictReason      : `Module '${encryptedModule.module}' has encryption keys that do not match this wallet owner.`,
      });
    });
  });

  describe('prepareModule', () => {
    it('should verify remotes without configuring when local and remote installs are current', async () => {
      const endpoints = ['https://dwn-a.example/', 'https://dwn-b.example/'];
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed    : installedEncryptedModule,
        endpoints,
        remoteBefore : installedEncryptedModule,
      });

      await prepareModule('did:example:owner', agent, encryptedModule);

      expect(processDwnRequest.callCount).toBe(1);
      expect(remoteConfigureSends(sendDwnRequest)).toHaveLength(0);
      // Every endpoint was verified with the signed query.
      const queried = sendDwnRequest.getCalls().map((call) => call.args[0].dwnUrl);
      expect(new Set(queried)).toEqual(new Set(endpoints));
    });

    it('should perform an encryption upgrade when the installed definition is missing $keyAgreement keys', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed    : encryptedModule, // policy-identical, no keys
        endpoints    : ['https://dwn-a.example/'],
        remoteBefore : encryptedModule,
        remoteAfter  : installedEncryptedModule, // converges after fan-out
      });

      await prepareModule('did:example:owner', agent, encryptedModule);

      // The upgrade re-configures locally from the definition-owned policy.
      const configures = configureCalls(processDwnRequest);
      expect(configures).toHaveLength(1);
      expect((configures[0].args[0] as Record<string, unknown>).encryption).toBeUndefined();

      // The freshly signed configure is fanned out to the behind endpoint.
      const sends = remoteConfigureSends(sendDwnRequest);
      expect(sends).toHaveLength(1);
      expect(sends[0].args[0].message).toBe(signedModuleConfigure);
    });

    it('should fan out the stored configure entry when local is current but a remote is missing it', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed   : installedEncryptedModule,
        endpoints   : ['https://dwn-a.example/'],
        remoteAfter : installedEncryptedModule,
      });

      await prepareModule('did:example:owner', agent, encryptedModule);

      // No re-sign: the single processDwnRequest call is the local query, and
      // the fan-out reuses the stored configure entry from the local reply.
      expect(processDwnRequest.callCount).toBe(1);
      const sends = remoteConfigureSends(sendDwnRequest);
      expect(sends).toHaveLength(1);
      expect((sends[0].args[0].message as { descriptor: { definition?: unknown } }).descriptor.definition)
        .toEqual(installedEncryptedModule);
    });

    it('should throw on a local definition conflict without configuring anything', async () => {
      const olderInstalled = {
        ...notesModule,
        types: { note: { schema: 'old-note' } },
      } as DwnModuleDefinition;
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed : olderInstalled,
        endpoints : ['https://dwn-a.example/'],
      });

      await expect(prepareModule('did:example:owner', agent, notesModule))
        .rejects.toThrow('already installed with a different definition');
      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should replace an owner-approved authored-definition conflict locally and remotely', async () => {
      const olderInstalled = {
        ...notesModule,
        types: { note: { schema: 'old-note' } },
      } as DwnModuleDefinition;
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed    : olderInstalled,
        remoteBefore : olderInstalled,
        remoteAfter  : notesModule,
      });

      await prepareModule('did:example:owner', agent, notesModule, {
        allowDefinitionOverride: true,
      });

      expect(configureCalls(processDwnRequest)).toHaveLength(1);
      expect(remoteConfigureSends(sendDwnRequest)).toHaveLength(1);
    });

    it('should replace an owner-approved remote definition without reconfiguring current local state', async () => {
      const olderRemote = {
        ...notesModule,
        types: { note: { schema: 'old-note' } },
      } as DwnModuleDefinition;
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({
        installed    : notesModule,
        remoteBefore : olderRemote,
        remoteAfter  : notesModule,
      });

      await prepareModule('did:example:owner', agent, notesModule, {
        allowDefinitionOverride: true,
      });

      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(remoteConfigureSends(sendDwnRequest)).toHaveLength(1);
    });

    it('should keep owner-key conflicts fail-closed when definition replacement is approved', async () => {
      const installedWithForeignKeys = {
        ...installedEncryptedModule,
        types         : { ...installedEncryptedModule.types, legacy: { schema: 'legacy' } },
        $keyAgreement : { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'foreign-key' } },
      } as DwnModuleDefinition;
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({ installed: installedWithForeignKeys });

      await expect(prepareModule('did:example:owner', agent, encryptedModule, {
        allowDefinitionOverride: true,
      })).rejects.toThrow('already installed with a different definition');

      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should keep requester-managed encryption metadata fail-closed when replacement is approved', async () => {
      const requestedWithKeys = {
        ...notesModule,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'requester-key' } },
      } as DwnModuleDefinition;
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent({ installed: notesModule });

      await expect(prepareModule('did:example:owner', agent, requestedWithKeys, {
        allowDefinitionOverride: true,
      })).rejects.toThrow('contains wallet-managed encryption keys');

      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should throw when installed encryption keys are not derived from the wallet owner', async () => {
      const poisonedInstall = {
        ...installedEncryptedModule,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'attacker-key' } },
      } as DwnModuleDefinition;
      const { agent, sendDwnRequest } = stubAgent({
        installed : poisonedInstall,
        endpoints : ['https://dwn-a.example/'],
      });

      await expect(prepareModule('did:example:owner', agent, encryptedModule))
        .rejects.toThrow('encryption keys that do not match this wallet owner');
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should throw when requester-supplied key metadata reaches preparation', async () => {
      const requestedWithKeys = {
        ...notesModule,
        $keyAgreement: { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'requester-key' } },
      } as DwnModuleDefinition;
      const { agent } = stubAgent();

      await expect(prepareModule('did:example:owner', agent, requestedWithKeys))
        .rejects.toThrow('contains wallet-managed encryption keys');
    });

    it('should throw on a remote conflict before configuring locally', async () => {
      const remoteConflict = {
        ...notesModule,
        types: { note: { schema: 'https://example.com/schemas/other' } },
      } as DwnModuleDefinition;
      const { agent, processDwnRequest } = stubAgent({
        endpoints    : ['https://dwn-a.example/'],
        remoteBefore : remoteConflict,
      });

      await expect(prepareModule('did:example:owner', agent, notesModule))
        .rejects.toThrow('conflicts with the latest definition');
      expect(configureCalls(processDwnRequest)).toHaveLength(0);
    });

    it('should fail closed when a reachable endpoint rejects the module query', async () => {
      const { agent, sendDwnRequest } = stubAgent({ endpoints: ['https://dwn-a.example/', 'https://dwn-b.example/'] });
      sendDwnRequest.callsFake(async (request: { dwnUrl: string }) =>
        request.dwnUrl === 'https://dwn-a.example/'
          ? { status: { code: 500, detail: 'Server error' } }
          : moduleQueryReply());

      await expect(prepareModule('did:example:owner', agent, notesModule))
        .rejects.toThrow('Could not verify module on https://dwn-a.example/: Server error');
    });

    it('should fail closed when every endpoint is unreachable', async () => {
      const { agent, sendDwnRequest } = stubAgent({ endpoints: ['https://dwn-a.example/', 'https://dwn-b.example/'] });
      sendDwnRequest.rejects(new Error('connection refused'));

      await expect(prepareModule('did:example:owner', agent, notesModule))
        .rejects.toThrow('Could not verify the module definition');
    });

    it('should fail closed when endpoints do not converge after the configure fan-out', async () => {
      const { agent } = stubAgent({
        endpoints: ['https://dwn-a.example/'],
        // Missing before AND after fan-out — the endpoint silently dropped it.
      });

      await expect(prepareModule('did:example:owner', agent, notesModule))
        .rejects.toThrow('Could not verify the latest module definition on every reachable DWN endpoint');
    });

    it('should preserve endpoint resolution failures before configuring locally', async () => {
      const { agent, processDwnRequest, sendDwnRequest } = stubAgent();
      (agent.dwn.getRemoteDwnEndpointUrls as sinon.SinonStub)
        .rejects(new Error('DID does not advertise a #dwn service'));

      await expect(prepareModule('did:example:owner', agent, encryptedModule))
        .rejects.toThrow('DID does not advertise a #dwn service');

      expect(configureCalls(processDwnRequest)).toHaveLength(0);
      expect(sendDwnRequest.callCount).toBe(0);
    });

    it('should throw when the local configure is rejected', async () => {
      const { agent } = stubAgent({ configureStatus: { code: 400, detail: 'Invalid definition' } });

      await expect(prepareModule('did:example:owner', agent, notesModule))
        .rejects.toThrow('Could not configure module locally: Invalid definition');
    });
  });
});

// ---------------------------------------------------------------------------
// Composed modules (`uses` dependencies) and failure surfacing
// ---------------------------------------------------------------------------

/** Per-endpoint simulated DWN state for the composed-module tests. */
type SimEndpoint = {
  modules: Map<string, DwnModuleDefinition>;
  /** Returns a rejection for a configure of the given module URI. */
  rejectConfigure?: (moduleUri: string) => { code: number; detail: string } | undefined;
  /** Accept configures with 202 but never store them (convergence failure). */
  acceptButDrop?: boolean;
  /** Reject postcondition/verification queries with this status. */
  rejectQueries?: { code: number; detail: string };
};

type SimSend = { dwnUrl: string; kind: 'query' | 'configure'; moduleUri: string };

/**
 * Simulation stub: a local DWN keyed by module URI and remote endpoints
 * with mutable per-URI state — configure sends are stored (unless dropped or
 * rejected), so postcondition re-queries converge naturally. Records every
 * remote send in order for dependency-ordering assertions.
 */
function simAgent(options: {
  local: Record<string, DwnModuleDefinition>;
  remotes: Record<string, SimEndpoint>;
}): { agent: EnboxPlatformAgent; sends: SimSend[] } {
  const local = new Map(Object.entries(options.local));
  const queryTokens = new Map<string, { descriptor: { interface: string; method: string }; moduleUri: string }>();
  const queryTokenFor = (moduleUri: string): { descriptor: { interface: string; method: string }; moduleUri: string } => {
    let token = queryTokens.get(moduleUri);
    if (token === undefined) {
      token = { descriptor: { interface: 'Modules', method: 'Query' }, moduleUri };
      queryTokens.set(moduleUri, token);
    }
    return token;
  };
  const entryFor = (definition: DwnModuleDefinition): { descriptor: { interface: string; method: string; definition: DwnModuleDefinition } } =>
    ({ descriptor: { interface: 'Modules', method: 'Configure', definition } });

  const sends: SimSend[] = [];

  const processDwnRequest = sinon.stub().callsFake(async (request: any) => {
    if (request.messageType === DwnInterface.ModulesConfigure) {
      const definition = request.messageParams.definition as DwnModuleDefinition;
      local.set(definition.module, definition);
      return {
        messageCid : '',
        reply      : { status: { code: 202, detail: 'Accepted' } },
        message    : entryFor(definition),
      };
    }
    const moduleUri = request.messageParams.filter.module as string;
    const installed = local.get(moduleUri);
    return {
      messageCid : '',
      reply      : {
        status  : { code: 200, detail: 'OK' },
        entries : installed === undefined ? [] : [entryFor(installed)],
      },
      message: queryTokenFor(moduleUri),
    };
  });

  const sendDwnRequest = sinon.stub().callsFake(async (request: any) => {
    const endpoint = options.remotes[request.dwnUrl];
    if (endpoint === undefined) {
      throw new Error(`connection refused: ${request.dwnUrl}`);
    }
    const message = request.message;
    if (typeof message.moduleUri === 'string') {
      sends.push({ dwnUrl: request.dwnUrl, kind: 'query', moduleUri: message.moduleUri });
      if (endpoint.rejectQueries !== undefined) {
        return { status: endpoint.rejectQueries };
      }
      const installed = endpoint.modules.get(message.moduleUri);
      return {
        status  : { code: 200, detail: 'OK' },
        entries : installed === undefined ? [] : [entryFor(installed)],
      };
    }
    const definition = message.descriptor.definition as DwnModuleDefinition;
    sends.push({ dwnUrl: request.dwnUrl, kind: 'configure', moduleUri: definition.module });
    const rejection = endpoint.rejectConfigure?.(definition.module);
    if (rejection !== undefined) {
      return { status: rejection };
    }
    if (!endpoint.acceptButDrop) {
      endpoint.modules.set(definition.module, definition);
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

const DEPENDENCY_URI = 'https://example.com/modules/membership';
const COMPOSED_URI = 'https://example.com/modules/board';
const BASE_URI = 'https://example.com/modules/base';

const dependencyModule: DwnModuleDefinition = {
  module    : DEPENDENCY_URI,
  published : true,
  types     : { link: { schema: 'link' } },
  structure : { link: { $actions: [] } },
};

/** A module with one composition dependency. */
const composedModule: DwnModuleDefinition = {
  module    : COMPOSED_URI,
  published : true,
  uses      : { membership: DEPENDENCY_URI },
  types     : { card: { schema: 'card' } },
  structure : { card: { $actions: [] } },
} as DwnModuleDefinition;

describe('connect module preparation — composed modules', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should propagate an out-of-batch uses dependency to endpoints missing the dependent', async () => {
    // Locally: composed + its dependency installed (identity bootstrap).
    // Remotely: the endpoint has NEITHER (sync lag / wiped dev server) —
    // exactly the state where the dependent's configure would be rejected
    // with ModulesConfigureComposedModuleNotInstalled.
    const { agent, sends } = simAgent({
      local   : { [COMPOSED_URI]: composedModule, [DEPENDENCY_URI]: dependencyModule },
      remotes : { 'https://dwn-a.example/': { modules: new Map() } },
    });

    await prepareModule('did:example:owner', agent, composedModule);

    const configures = sends.filter((send) => send.kind === 'configure');
    expect(configures.map((send) => send.moduleUri)).toEqual([DEPENDENCY_URI, COMPOSED_URI]);
  });

  it('should not send a uses dependency that the endpoint already has', async () => {
    const { agent, sends } = simAgent({
      local   : { [COMPOSED_URI]: composedModule, [DEPENDENCY_URI]: dependencyModule },
      remotes : {
        'https://dwn-a.example/': { modules: new Map([[DEPENDENCY_URI, dependencyModule]]) },
      },
    });

    await prepareModule('did:example:owner', agent, composedModule);

    const configures = sends.filter((send) => send.kind === 'configure');
    expect(configures.map((send) => send.moduleUri)).toEqual([COMPOSED_URI]);
  });

  it('should propagate transitive uses dependencies depth-first', async () => {
    const baseModule: DwnModuleDefinition = {
      module    : BASE_URI,
      published : true,
      types     : { atom: { schema: 'atom' } },
      structure : { atom: { $actions: [] } },
    };
    const midModule = {
      ...dependencyModule,
      uses: { base: BASE_URI },
    } as DwnModuleDefinition;
    const topModule = {
      ...composedModule,
      uses: { membership: DEPENDENCY_URI },
    } as DwnModuleDefinition;

    const { agent, sends } = simAgent({
      local   : { [COMPOSED_URI]: topModule, [DEPENDENCY_URI]: midModule, [BASE_URI]: baseModule },
      remotes : { 'https://dwn-a.example/': { modules: new Map() } },
    });

    await prepareModule('did:example:owner', agent, topModule);

    const configures = sends.filter((send) => send.kind === 'configure');
    expect(configures.map((send) => send.moduleUri)).toEqual([BASE_URI, DEPENDENCY_URI, COMPOSED_URI]);
  });

  it('should surface the endpoint rejection reason in the postcondition error', async () => {
    const { agent } = simAgent({
      local   : { [COMPOSED_URI]: composedModule },
      remotes : {
        'https://dwn-a.example/': {
          modules         : new Map(),
          rejectConfigure : (uri) => uri === COMPOSED_URI
            ? { code: 400, detail: `composed module '${DEPENDENCY_URI}' (alias 'membership') is not installed for tenant` }
            : undefined,
        },
      },
    });

    // The dependency is missing locally too, so it cannot be propagated —
    // the error must carry BOTH the local-dependency reason (first wins)
    // and identify the failing endpoint.
    await expect(prepareModule('did:example:owner', agent, composedModule))
      .rejects.toThrow(/dwn-a\.example.*uses dependency '.*membership' is not installed locally/);
  });

  it('should surface a configure rejection when dependencies are satisfied', async () => {
    const { agent } = simAgent({
      local   : { [COMPOSED_URI]: composedModule, [DEPENDENCY_URI]: dependencyModule },
      remotes : {
        'https://dwn-a.example/': {
          modules         : new Map([[DEPENDENCY_URI, dependencyModule]]),
          rejectConfigure : () => ({ code: 401, detail: 'Not a registered tenant.' }),
        },
      },
    });

    await expect(prepareModule('did:example:owner', agent, composedModule))
      .rejects.toThrow(/dwn-a\.example.*configure rejected \(401\): Not a registered tenant\./);
  });

  it('should surface the observed state when an endpoint accepts but never converges', async () => {
    const { agent } = simAgent({
      local   : { [DEPENDENCY_URI]: dependencyModule },
      remotes : {
        'https://dwn-a.example/': { modules: new Map(), acceptButDrop: true },
      },
    });

    await expect(prepareModule('did:example:owner', agent, dependencyModule))
      .rejects.toThrow(/dwn-a\.example.*still reports 'install' after configure/);
  });
});
