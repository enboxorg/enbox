/**
 * Shared mock factory for EnboxUserAgent used across tests.
 * @module
 */

import type { EnboxUserAgent } from '@enbox/agent';

/** Minimal BearerIdentity-like object for testing. */
export interface MockIdentity {
  did: { uri: string };
  metadata: {
    name: string;
    tenant: string;
    connectedDid?: string;
  };
}

/** Create a mock identity with defaults. */
export function createMockIdentity(overrides: Partial<MockIdentity> = {}): MockIdentity {
  return {
    did      : overrides.did ?? { uri: 'did:dht:testuser123' },
    metadata : {
      name         : 'Default',
      tenant       : 'did:dht:testagent',
      connectedDid : undefined,
      ...overrides.metadata,
    },
  };
}

export interface MockAgentOverrides {
  firstLaunch?: () => Promise<boolean>;
  initialize?: (params: any) => Promise<string>;
  start?: (params: any) => Promise<void>;
  identityList?: () => Promise<MockIdentity[]>;
  identityCreate?: (params: any) => Promise<MockIdentity>;
  identityGet?: (params: any) => Promise<MockIdentity | undefined>;
  identityImport?: (params: any) => Promise<MockIdentity>;
  identityDelete?: (params: any) => Promise<void>;
  identityExport?: (params: any) => Promise<any>;
  identityConnectedIdentity?: () => Promise<MockIdentity | undefined>;
  didDelete?: (params: any) => Promise<void>;
  dwnSetCachedLocalDwnEndpoint?: (endpoint: string) => Promise<boolean>;
  syncRegisterIdentity?: (params: any) => Promise<void>;
  syncStartSync?: (params: any) => Promise<void>;
  syncStopSync?: (timeout: number) => Promise<void>;
  syncSync?: (direction: string) => Promise<void>;
  processDwnRequest?: (params: any) => Promise<any>;
  rpcGetServerInfo?: (url: string) => Promise<any>;
  vaultIsInitialized?: () => Promise<boolean>;
  vaultIsLocked?: () => boolean;
  vaultUnlock?: (params: any) => Promise<void>;
  vaultLock?: () => Promise<void>;
  vaultChangePassword?: (params: any) => Promise<void>;
  vaultBackup?: () => Promise<any>;
  vaultRestore?: (params: any) => Promise<void>;
}

/**
 * Create a fully-mocked EnboxUserAgent with sensible defaults.
 *
 * All methods are mocked with no-op defaults that can be overridden.
 */
export function createMockAgent(overrides: MockAgentOverrides = {}): EnboxUserAgent {
  const defaultIdentity = createMockIdentity();

  return {
    agentDid: { uri: 'did:dht:testagent' },

    firstLaunch : overrides.firstLaunch ?? (async (): Promise<boolean> => false),
    initialize  : overrides.initialize ?? (async (): Promise<string> => 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'),
    start       : overrides.start ?? (async (): Promise<void> => {}),

    identity: {
      list              : overrides.identityList ?? (async (): Promise<MockIdentity[]> => [defaultIdentity]),
      create            : overrides.identityCreate ?? (async (): Promise<MockIdentity> => defaultIdentity),
      get               : overrides.identityGet ?? (async (): Promise<MockIdentity | undefined> => defaultIdentity),
      import            : overrides.identityImport ?? (async (): Promise<MockIdentity> => defaultIdentity),
      delete            : overrides.identityDelete ?? (async (): Promise<void> => {}),
      export            : overrides.identityExport ?? (async (): Promise<any> => ({})),
      connectedIdentity : overrides.identityConnectedIdentity ?? (async (): Promise<MockIdentity | undefined> => undefined),
    },

    did: {
      delete: overrides.didDelete ?? (async (): Promise<void> => {}),
    },

    dwn: {
      setCachedLocalDwnEndpoint: overrides.dwnSetCachedLocalDwnEndpoint
        ?? (async (): Promise<boolean> => false),
    },

    sync: {
      registerIdentity : overrides.syncRegisterIdentity ?? (async (): Promise<void> => {}),
      startSync        : overrides.syncStartSync ?? (async (): Promise<void> => {}),
      stopSync         : overrides.syncStopSync ?? (async (): Promise<void> => {}),
      sync             : overrides.syncSync ?? (async (): Promise<void> => {}),
    },

    processDwnRequest: overrides.processDwnRequest ?? (async (): Promise<any> => ({
      reply: { status: { code: 202, detail: 'Accepted' } },
    })),

    rpc: {
      getServerInfo: overrides.rpcGetServerInfo ?? (async (): Promise<any> => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
        server                   : '@enbox/dwn-server',
        sdkVersion               : '0.0.1',
        url                      : 'https://enbox-dwn.fly.dev',
        version                  : '0.0.1',
        webSocketSupport         : true,
      })),
    },

    vault: {
      isInitialized  : overrides.vaultIsInitialized ?? (async (): Promise<boolean> => true),
      isLocked       : overrides.vaultIsLocked ?? ((): boolean => false),
      unlock         : overrides.vaultUnlock ?? (async (): Promise<void> => {}),
      lock           : overrides.vaultLock ?? (async (): Promise<void> => {}),
      changePassword : overrides.vaultChangePassword ?? (async (): Promise<void> => {}),
      backup         : overrides.vaultBackup ?? (async (): Promise<any> => ({ data: 'backup' })),
      restore        : overrides.vaultRestore ?? (async (): Promise<void> => {}),
    },
  } as unknown as EnboxUserAgent;
}
