/**
 * Shared mock factory for EnboxUserAgent used across tests.
 * @module
 */

import type { EnboxUserAgent } from '@enbox/agent';

import { PermissionsProtocol } from '@enbox/dwn-sdk-js';
import { DwnPermissionGrant, InMemorySecretStore } from '@enbox/agent';

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

/**
 * A deterministic AES-256-GCM key for mock vault encrypt/decrypt.
 * This simulates the real vault CEK without requiring password derivation.
 */
const MOCK_CEK = new Uint8Array(32); // all-zeros key — test-only

async function mockEncryptData({ plaintext }: { plaintext: Uint8Array }): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await globalThis.crypto.subtle.importKey('raw', MOCK_CEK, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext.buffer as ArrayBuffer));
  // Encode as a 5-segment "JWE-like" string so decryptStoredKeys detects it.
  const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
  return `eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..${b64url(iv)}.${b64url(ct.slice(0, -16))}.${b64url(ct.slice(-16))}`;
}

async function mockDecryptData({ jwe }: { jwe: string }): Promise<Uint8Array> {
  const parts = jwe.split('.');
  const iv = Buffer.from(parts[2], 'base64url');
  const ctBody = Buffer.from(parts[3], 'base64url');
  const tag = Buffer.from(parts[4], 'base64url');
  const ct = new Uint8Array([...ctBody, ...tag]);
  const key = await globalThis.crypto.subtle.importKey('raw', MOCK_CEK, 'AES-GCM', false, ['decrypt']);
  const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
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
  dwnProcessRawMessage?: (tenant: string, message: any, options?: any) => Promise<any>;
  dwnIsRemoteMode?: boolean;
  dwnImportDelegateDecryptionKeys?: (delegateDid: string, keys: any[]) => void;
  dwnImportDelegateContextKeys?: (delegateDid: string, keys: any[], multiPartyProtocols?: string[]) => void;
  dwnExportDelegateContextKeys?: (delegateDid: string) => any[];
  dwnExportDelegateMultiPartyProtocols?: (delegateDid: string) => string[];
  dwnClearDelegateDecryptionKeys?: (delegateDid?: string) => void;
  dwnEnsureKeyDeliveryProtocol?: (tenantDid: string) => Promise<void>;
  syncRegisterIdentity?: (params: any) => Promise<void>;
  syncUnregisterIdentity?: (did: string) => Promise<void>;
  syncUpdateIdentityOptions?: (params: any) => Promise<void>;
  syncStartSync?: (params: any) => Promise<void>;
  syncStopSync?: (timeout: number) => Promise<void>;
  syncSync?: (direction: string) => Promise<void>;
  syncClose?: () => Promise<void>;
  syncHasActiveSubscriptions?: boolean;
  processDwnRequest?: (params: any) => Promise<any>;
  permissionsFetchGrants?: (params: any) => Promise<any[]>;
  rpcGetServerInfo?: (url: string) => Promise<any>;
  vaultIsInitialized?: () => Promise<boolean>;
  vaultIsLocked?: () => boolean;
  vaultUnlock?: (params: any) => Promise<void>;
  vaultLock?: () => Promise<void>;
  vaultChangePassword?: (params: any) => Promise<void>;
  vaultResetPasswordWithRecoveryPhrase?: (params: any) => Promise<void>;
  vaultBackup?: () => Promise<any>;
  vaultRestore?: (params: any) => Promise<void>;
  vaultEncryptData?: (params: { plaintext: Uint8Array }) => Promise<string>;
  vaultDecryptData?: (params: { jwe: string }) => Promise<Uint8Array>;
}

/**
 * Create a fully-mocked EnboxUserAgent with sensible defaults.
 *
 * All methods are mocked with no-op defaults that can be overridden.
 */
export function createMockAgent(overrides: MockAgentOverrides = {}): EnboxUserAgent {
  const defaultIdentity = createMockIdentity();
  const processDwnRequest = overrides.processDwnRequest ?? (async (params: any): Promise<any> => {
    // RecordsQuery returns 200 with empty entries (used by _deriveProtocolsFromGrants).
    // All other DWN messages return 202 Accepted.
    if (params?.messageType === 'RecordsQuery') {
      return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
    }
    return { reply: { status: { code: 202, detail: 'Accepted' } } };
  });
  const permissionsFetchGrants = overrides.permissionsFetchGrants ?? (async (params: any): Promise<any[]> => {
    const tags = params.protocol !== undefined ? { protocol: params.protocol } : undefined;
    const { reply } = await processDwnRequest({
      author        : params.author,
      target        : params.target,
      messageType   : 'RecordsQuery',
      messageParams : {
        filter: {
          author       : params.grantor,
          recipient    : params.grantee,
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.grantPath,
          tags,
        },
      },
    });
    if (reply.status.code !== 200) {
      throw new Error(`mock fetchGrants failed: ${reply.status.detail}`);
    }

    return (reply.entries ?? []).map((entry: any) => ({
      grant   : DwnPermissionGrant.parse(entry),
      message : entry,
    }));
  });

  return {
    agentDid : { uri: 'did:dht:testagent' },
    secrets  : new InMemorySecretStore(),

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

    sync: {
      registerIdentity       : overrides.syncRegisterIdentity ?? (async (): Promise<void> => {}),
      unregisterIdentity     : overrides.syncUnregisterIdentity ?? (async (): Promise<void> => {}),
      updateIdentityOptions  : overrides.syncUpdateIdentityOptions ?? (async (): Promise<void> => {}),
      startSync              : overrides.syncStartSync ?? (async (): Promise<void> => {}),
      stopSync               : overrides.syncStopSync ?? (async (): Promise<void> => {}),
      sync                   : overrides.syncSync ?? (async (): Promise<void> => {}),
      close                  : overrides.syncClose ?? (async (): Promise<void> => {}),
      hasActiveSubscriptions : overrides.syncHasActiveSubscriptions ?? false,
    },

    dwn: {
      setCachedLocalDwnEndpoint: overrides.dwnSetCachedLocalDwnEndpoint
        ?? (async (): Promise<boolean> => false),
      processRawMessage: overrides.dwnProcessRawMessage
        ?? (async (): Promise<any> => ({ status: { code: 202, detail: 'Accepted' } })),

      isRemoteMode                      : overrides.dwnIsRemoteMode ?? false,
      importDelegateDecryptionKeys      : overrides.dwnImportDelegateDecryptionKeys ?? ((): void => {}),
      importDelegateContextKeys         : overrides.dwnImportDelegateContextKeys ?? ((): void => {}),
      exportDelegateContextKeys         : overrides.dwnExportDelegateContextKeys ?? ((): any[] => []),
      exportDelegateMultiPartyProtocols : overrides.dwnExportDelegateMultiPartyProtocols ?? ((): string[] => []),
      clearDelegateDecryptionKeys       : overrides.dwnClearDelegateDecryptionKeys ?? ((): void => {}),
      ensureKeyDeliveryProtocol         : overrides.dwnEnsureKeyDeliveryProtocol ?? (async (): Promise<void> => {}),
    },

    processDwnRequest,

    permissions: {
      fetchGrants: permissionsFetchGrants,
    },

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
      resetPasswordWithRecoveryPhrase:
        overrides.vaultResetPasswordWithRecoveryPhrase ?? (async (): Promise<void> => {}),
      backup      : overrides.vaultBackup ?? (async (): Promise<any> => ({ data: 'backup' })),
      restore     : overrides.vaultRestore ?? (async (): Promise<void> => {}),
      encryptData : overrides.vaultEncryptData ?? mockEncryptData,
      decryptData : overrides.vaultDecryptData ?? mockDecryptData,
    },
  } as unknown as EnboxUserAgent;
}
