/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { DidMethodResolver } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  BearerIdentity,
  DwnDataEncodedRecordsWriteMessage,
  DwnMessagesPermissionScope,
  DwnProtocolDefinition,
  DwnRecordsPermissionScope,
  HdIdentityVault,
  LocalDwnStrategy,
  Permission,
  WalletConnectOptions,
  Web5Agent,
} from '@enbox/agent';

import type { SchemaMap, TypedProtocol } from './protocol-types.js';

import { AnonymousDwnApi, WalletConnect, Web5UserAgent } from '@enbox/agent';
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';
import { DwnRegistrar, Web5RpcClient } from '@enbox/dwn-clients';

import { DidApi } from './did-api.js';
import { DwnApi } from './dwn-api.js';
import { DwnReaderApi } from './dwn-reader-api.js';
import { PermissionGrant } from './permission-grant.js';
import { TypedWeb5 } from './typed-web5.js';
import { VcApi } from './vc-api.js';

/** Override defaults configured during the technical preview phase. */
export type TechPreviewOptions = {
  /** Override default dwnEndpoints provided for technical preview. */
  dwnEndpoints?: string[];
};

/** Override defaults for DID creation. */
export type DidCreateOptions = {
  /** Override default dwnEndpoints provided during DID creation. */
  dwnEndpoints?: string[];
};

/**
 * Represents a permission request for a protocol definition.
 */
export type ConnectPermissionRequest = {
  /**
   * The protocol definition for the protocol being requested.
   */
  protocolDefinition: DwnProtocolDefinition;

  /**
   * The permissions being requested for the protocol. If none are provided, the default is to request all permissions.
   */
  permissions?: Permission[];
};

/**
 * Options for connecting to a Web5 agent. This includes the ability to connect to an external wallet.
 *
 * NOTE: the returned `ConnectPermissionRequest` type is different to the `ConnectPermissionRequest` type in the `@enbox/agent` package.
 */
export type ConnectOptions = Omit<WalletConnectOptions, 'permissionRequests'> & {
  /** The user friendly name of the client/app to be displayed when prompting end-user with permission requests. */
  displayName: string;

  /**
   * The permissions that are being requested for the connected DID.
   * This is used to create the {@link ConnectPermissionRequest} for the wallet connect flow.
   */
  permissionRequests: ConnectPermissionRequest[];
};

/**
 * Options for creating an anonymous (read-only) Web5 instance via {@link Web5.anonymous}.
 *
 * @beta
 */
export type Web5AnonymousOptions = {
  /** Override the default DID method resolvers. Defaults to `[DidDht, DidJwk, DidKey, DidWeb]`. */
  didResolvers?: DidMethodResolver[];
};

/**
 * The result of calling {@link Web5.anonymous}.
 *
 * Contains only a read-only `dwn` property — no `did`, `vc`, or `agent`.
 *
 * @beta
 */
export type Web5AnonymousApi = {
  /** A read-only DWN API for querying public data on remote DWNs. */
  dwn: DwnReaderApi;
};

/** Parameters passed to the onProviderAuthRequired callback. */
export type ProviderAuthParams = {
  /** Full authorize URL to open in a browser (query params already appended). */
  authorizeUrl: string;
  /** The DWN endpoint URL this auth is for (informational). */
  dwnEndpoint: string;
  /** CSRF nonce — the provider will return this unchanged in the redirect. */
  state: string;
};

/** Result returned by the app after the user completes provider auth. */
export type ProviderAuthResult = {
  /** Authorization code from the provider's redirect. */
  code: string;
  /** Must match the state from ProviderAuthParams (CSRF validation). */
  state: string;
};

/** Persisted registration token data for a DWN endpoint. */
export type RegistrationTokenData = {
  /** Opaque registration token for POST /registration. */
  registrationToken: string;
  /** Refresh token for obtaining new registration tokens. */
  refreshToken?: string;
  /** Unix timestamp (ms) when the token expires. Undefined = never expires. */
  expiresAt?: number;
  /** Provider's token exchange URL (needed for code exchange). */
  tokenUrl: string;
  /** Provider's refresh URL (needed for token refresh). */
  refreshUrl?: string;
};

/** Optional overrides that can be provided when calling {@link Web5.connect}. */
export type Web5ConnectOptions = {
  /**
   * Controls local DWN discovery behavior for remote-target DWN sends/sync.
   * `'off'` (default) disables local probing, `'prefer'` tries local first
   * then falls back to DID-document endpoints, `'only'` requires a local server.
   */
  localDwnStrategy?: LocalDwnStrategy;

  /**
   * When specified, external wallet connect flow is triggered.
   * This param currently will not work in apps that are currently connected.
   * It must only be invoked at registration with a reset and empty DWN and agent.
   */
  walletConnectOptions?: ConnectOptions;

  /**
   * Provide a {@link Web5Agent} implementation. Defaults to creating a local
   * {@link Web5UserAgent} if one isn't provided
   **/
  agent?: Web5Agent;

  /**
   * Provide an instance of a {@link HdIdentityVault} implementation. Defaults to
   * a LevelDB-backed store with an insecure, static unlock password if one
   * isn't provided. To allow the app user to enter a secure password of
   * their choosing, provide an initialized {@link HdIdentityVault} instance.
   **/
  agentVault?: HdIdentityVault;

  /** Specify an existing DID to connect to. */
  connectedDid?: string;

  /**
   * The Web5 app `password` is used to protect data on the device the application is running on.
   *
   * Only the end user should know this password: it should not be stored on the device or
   * transmitted over the network.
   *
   * This password is crucial for the security of an identity vault that stores the local Agent's
   * cryptographic keys and decentralized identifier (DID). The vault's content is encrypted using
   * the password, making it accessible only to those who know the password.
   *
   * App users should be advised to use a strong, unique passphrase that is not shared across
   * different services or applications. The password should be kept confidential and not be
   * exposed to unauthorized entities. Losing the password may result in irreversible loss of
   * access to the vault's contents.
   */
  password?: string;

  /**
   * The `recoveryPhrase` is a unique, secure key for recovering the identity vault.
   *
   * This phrase is a series of 12 words generated securely and known only to the user. It plays a
   * critical role in the security of the identity vault by enabling the recovery of the vault's
   * contents, including cryptographic keys and the Agent's decentralized identifier (DID), across
   * different devices or if the original device is compromised or lost.
   *
   * The recovery phrase is akin to a master key, as anyone with access to this phrase can restore
   * and access the vault's contents. It’s combined with the app `password` to encrypt the vault's
   * content.
   *
   * Unlike a password, the recovery phrase is not intended for regular use but as a secure backup
   * method for vault recovery. Losing this phrase can result in permanent loss of access to the
   * vault's contents, as it cannot be reset or retrieved if forgotten.
   *
   * Users should treat the recovery phrase with the highest level of security, ensuring it is
   * never shared, stored online, or exposed to potential threats. It is the user's responsibility
   * to keep this phrase safe to maintain the integrity and accessibility of their secured data. It
   * is recommended to write it down and store it in a secure location, separate from the device and
   * digital backups.
   */
  recoveryPhrase?: string;

  /**
   * Enable synchronization of DWN records between local and remote DWNs.
   *
   * - **Omitted / `undefined`**: Live sync mode (default). Opens real-time
   *   `MessagesSubscribe` WebSocket subscriptions for instant pull and
   *   push-on-write, with a background SMT integrity check every 5 minutes.
   * - **Interval string** (e.g. `'2m'`, `'30s'`): Poll mode. Performs a full
   *   SMT set-reconciliation sync at the specified interval.
   * - **`'off'`**: Sync is disabled entirely.
   */
  sync?: string;

  /**
   * Override defaults configured during the technical preview phase.
   * See {@link TechPreviewOptions} for available options.
   */
  techPreview?: TechPreviewOptions;

  /**
   * Override defaults configured options for creating a DID during connect.
   * See {@link DidCreateOptions} for available options.
   */
  didCreateOptions?: DidCreateOptions;

  /**
   * If the `registration` option is provided, the agent DID and the connected DID will be
   * registered with the DWN endpoints provided by `techPreview` or `didCreateOptions`.
   *
   * If registration fails, the `onFailure` callback will be called with the error.
   * If registration is successful, the `onSuccess` callback will be called.
   */
  registration? : {
    /** Called when all of the DWN registrations are successful. */
    onSuccess : () => void;
    /** Called when any of the DWN registrations fail. */
    onFailure : (error: any) => void;

    /**
     * Called when a DWN endpoint requires provider auth (`'provider-auth-v0'`).
     * The app is responsible for opening the authorizeUrl in a browser,
     * capturing the redirect back, and returning the auth code.
     * If not provided, provider-auth endpoints fall back to PoW registration.
     */
    onProviderAuthRequired? : (params: ProviderAuthParams) => Promise<ProviderAuthResult>;

    /**
     * Pre-existing registration tokens from a previous session, keyed by DWN endpoint URL.
     * If a valid (non-expired) token exists for an endpoint, it is used directly.
     */
    registrationTokens? : Record<string, RegistrationTokenData>;

    /**
     * Called when new registration tokens are obtained so the app can persist them.
     */
    onRegistrationTokens? : (tokens: Record<string, RegistrationTokenData>) => void;
  }
};

/**
 * Represents the result of the Web5 connection process, including the Web5 instance,
 * the connected decentralized identifier (DID), and optionally the recovery phrase used
 * during the agent's initialization.
 */
export type Web5ConnectResult = {
  /** The Web5 instance, providing access to the agent, DID, DWN, and VC APIs. */
  web5: Web5;

  /** The DID that has been connected or created during the connection process. */
  did: string;

  /**
   * The first time a Web5 agent is initialized, the recovery phrase that was used to generate the
   * agent's DID and keys is returned. This phrase can be used to recover the agent's vault contents
   * and should be stored securely by the user.
   */
  recoveryPhrase?: string;

  /**
   * The resulting did of a successful wallet connect. Only returned on success if
   * {@link WalletConnectOptions} was provided.
   */
  delegateDid?: string;
};

/**
 * Parameters that are passed to Web5 constructor.
 *
 * @see {@link Web5ConnectOptions}
 */
export type Web5Params = {
  /**
   * A {@link Web5Agent} instance that handles DIDs, DWNs and VCs requests. The agent manages the
   * user keys and identities, and is responsible to sign and verify messages.
   */
  agent: Web5Agent;

  /** The DID of the tenant under which all DID, DWN, and VC requests are being performed. */
  connectedDid: string;

  /** The DID that will be signing Web5 messages using grants from the connectedDid */
  delegateDid?: string;
};

/**
 * The main Web5 API interface. It manages the creation of a DID if needed, the connection to the
 * local DWN and all the web5 main foundational APIs such as VC, syncing, etc.
 */
export class Web5 {
  /**
   * A {@link Web5Agent} instance that handles DIDs, DWNs and VCs requests. The agent manages the
   * user keys and identities, and is responsible to sign and verify messages.
   */
  agent: Web5Agent;

  /** Exposed instance to the DID APIs, allow users to create and resolve DIDs  */
  did: DidApi;

  /** Internal DWN API instance. Use {@link Web5.using} for protocol-scoped access. */
  private _dwn: DwnApi;

  /**
   * Cache of {@link TypedWeb5} instances keyed by protocol URI.
   *
   * Ensures that `web5.using(Protocol)` returns the **same** `TypedWeb5`
   * instance for a given protocol across multiple call sites, avoiding
   * redundant protocol installations and duplicated internal state.
   */
  private _typedInstances = new Map<string, TypedWeb5<ProtocolDefinition, SchemaMap>>();

  /** Exposed instance to the VC APIs, allow users to issue, present and verify VCs */
  vc: VcApi;

  constructor({ agent, connectedDid, delegateDid }: Web5Params) {
    this.agent = agent;
    this.did = new DidApi({ agent, connectedDid });
    this._dwn = new DwnApi({ agent, connectedDid, delegateDid });
    this.vc = new VcApi({ agent, connectedDid });
  }

  /**
   * Returns a {@link TypedWeb5} instance scoped to the given protocol.
   *
   * This is the **primary developer interface** for interacting with
   * protocol-backed records. It auto-injects the protocol URI, protocolPath,
   * and schema into every operation, and provides compile-time path
   * autocompletion plus typed data payloads via the schema map.
   *
   * Instances are **cached by protocol URI** — calling `using()` multiple
   * times with the same protocol returns the same `TypedWeb5` instance,
   * so auto-configure only runs once and all call sites share state.
   *
   * @param protocol - A typed protocol created via `defineProtocol()`.
   * @returns A `TypedWeb5` instance bound to the given protocol.
   *
   * @example
   * ```ts
   * const social = web5.using(SocialProtocol);
   *
   * await social.configure();
   *
   * const { record } = await social.records.write('friend', {
   *   data: { did: 'did:example:alice', alias: 'Alice' },
   * });
   *
   * const { records } = await social.records.query('friend');
   * ```
   */
  public using<D extends ProtocolDefinition, M extends SchemaMap>(
    protocol: TypedProtocol<D, M>,
  ): TypedWeb5<D, M> {
    const uri = protocol.definition.protocol;
    const cached = this._typedInstances.get(uri);

    if (cached) {
      // The map stores a type-erased instance; restore the caller's generics.
      return cached as unknown as TypedWeb5<D, M>;
    }

    const instance = new TypedWeb5<D, M>(this._dwn, protocol);
    // Store with erased generics so the map value type stays uniform.
    this._typedInstances.set(uri, instance as unknown as TypedWeb5<ProtocolDefinition, SchemaMap>);
    return instance;
  }

  /**
   * Creates a lightweight, read-only Web5 instance for querying public DWN data.
   *
   * No identity, vault, password, or signing keys are required. The returned
   * API supports querying and reading published records and protocols from any
   * remote DWN, using **unsigned** (anonymous) DWN messages.
   *
   * @param options - Optional configuration overrides.
   * @returns A {@link Web5AnonymousApi} with a read-only `dwn` property.
   *
   * @example
   * ```ts
   * const { dwn } = Web5.anonymous();
   *
   * const { records } = await dwn.records.query({
   *   from: 'did:dht:alice...',
   *   filter: { protocol: 'https://social.example/posts', protocolPath: 'post' },
   * });
   *
   * for (const record of records) {
   *   console.log(record.id, await record.data.text());
   * }
   * ```
   *
   * @beta
   */
  static anonymous(options?: Web5AnonymousOptions): Web5AnonymousApi {
    const didResolver = new UniversalResolver({
      didResolvers : options?.didResolvers ?? [DidDht, DidJwk, DidKey, DidWeb],
      cache        : new DidResolverCacheMemory(),
    });

    const rpcClient = new Web5RpcClient();
    const anonymousDwn = new AnonymousDwnApi({ didResolver, rpcClient });

    return {
      dwn: new DwnReaderApi(anonymousDwn),
    };
  }

  /**
   * Connects to a {@link Web5Agent}. Defaults to creating a local {@link Web5UserAgent} if one
   * isn't provided.
   *
   * If `walletConnectOptions` are provided, a WalletConnect flow will be initiated to import a delegated DID from an external wallet.
   * If there is a failure at any point during connecting and processing grants, all created DIDs and Identities as well as the provided grants
   * will be cleaned up and an error thrown. This allows for subsequent Connect attempts to be made without any errors.
   *
   * @param options - Optional overrides that can be provided when calling {@link Web5.connect}.
   * @returns A promise that resolves to a {@link Web5} instance and the connected DID.
   */
  static async connect({
    agent,
    agentVault,
    localDwnStrategy = 'off',
    connectedDid,
    password,
    recoveryPhrase,
    sync,
    techPreview,
    didCreateOptions,
    registration,
    walletConnectOptions,
  }: Web5ConnectOptions = {}): Promise<Web5ConnectResult> {
    let delegateDid: string | undefined;
    if (agent === undefined) {
      let registerSync = false;
      // A custom Web5Agent implementation was not specified, so use default managed user agent.
      const userAgent = await Web5UserAgent.create({ agentVault, localDwnStrategy });
      agent = userAgent;

      // Warn the developer and application user of the security risks of using a static password.
      if (password === undefined) {
        password = 'insecure-static-phrase';
        console.warn(
          '%cSECURITY WARNING:%c ' +
          'You have not set a password, which defaults to a static, guessable value. ' +
          'This significantly compromises the security of your data. ' +
          'Please configure a secure, unique password.',
          'font-weight: bold; color: red;',
          'font-weight: normal; color: inherit;'
        );
      }

      // Use the specified DWN endpoints or the latest TBD hosted DWN
      const serviceEndpointNodes = techPreview?.dwnEndpoints ?? didCreateOptions?.dwnEndpoints ?? ['https://enbox-dwn.fly.dev'];

      // Initialize, if necessary, and start the agent.
      if (await userAgent.firstLaunch()) {
        recoveryPhrase = await userAgent.initialize({ password, recoveryPhrase, dwnEndpoints: serviceEndpointNodes });
      }
      await userAgent.start({ password });
      // Attempt to retrieve the connected Identity if it exists.
      const connectedIdentity: BearerIdentity = await userAgent.identity.connectedIdentity();
      let identity: BearerIdentity;
      let connectedProtocols: string[] = [];
      if (connectedIdentity) {
        // if a connected identity is found, use it
        // TODO: In the future, implement a way to re-connect an already connected identity and apply additional grants/protocols
        identity = connectedIdentity;
      } else if (walletConnectOptions) {
        if (sync === 'off') {
          // Currently we require sync to be enabled when using WalletConnect
          // This is to ensure a connected app is not in a disjointed state from any other clients/app using the connectedDid
          throw new Error('Sync must not be disabled when using WalletConnect');
        }

        // Since we are connecting a new identity, we will want to register sync for the connectedDid
        registerSync = true;

        // No connected identity found and connectOptions are provided, attempt to import a delegated DID from an external wallet
        try {
          const { permissionRequests, ...connectOptions } = walletConnectOptions;
          const walletPermissionRequests = permissionRequests.map(
            ({ protocolDefinition, permissions }) =>
              WalletConnect.createPermissionRequestForProtocol({
                definition  : protocolDefinition,
                permissions : permissions ?? [
                  'read', 'write', 'delete', 'query', 'subscribe',
                ],
              })
          );

          const { delegatePortableDid, connectedDid, delegateGrants } = await WalletConnect.initClient({
            ...connectOptions,
            permissionRequests: walletPermissionRequests,
          });

          // Import the delegated DID as an Identity in the User Agent.
          // Setting the connectedDID in the metadata applies a relationship between the signer identity and the one it is impersonating.
          identity = await userAgent.identity.import({ portableIdentity: {
            portableDid : delegatePortableDid,
            metadata    : {
              connectedDid,
              name   : 'Default',
              uri    : delegatePortableDid.uri,
              tenant : agent.agentDid.uri,
            }
          } });

          // Attempts to process the connected grants to be used by the delegateDID
          // If the process fails, we want to clean up the identity
          // the connected grants will return a de-duped array of protocol URIs that are used to register sync for those protocols
          connectedProtocols = await this.processConnectedGrants({ agent, delegateDid: delegatePortableDid.uri, grants: delegateGrants });
        } catch (error:any) {
          // clean up the DID and Identity if import fails and throw
          // TODO: Implement the ability to purge all of our messages as a tenant
          await this.cleanUpIdentity({ identity, userAgent });
          throw new Error(`Failed to connect to wallet: ${error.message}`);
        }
      } else {
        // No connected (WalletConnect) identity and no walletConnectOptions provided.
        // Look for an existing local identity, or create one on first use.
        const identities = await userAgent.identity.list();

        if (identities.length === 0) {
          registerSync = true;

          // First use — generate a new Identity for the end-user.
          identity = await userAgent.identity.create({
            didMethod  : 'dht',
            metadata   : { name: 'Default' },
            didOptions : {
              services: [
                {
                  id              : 'dwn',
                  type            : 'DecentralizedWebNode',
                  serviceEndpoint : serviceEndpointNodes,
                  enc             : '#enc',
                  sig             : '#sig',
                }
              ],
              verificationMethods: [
                {
                  algorithm : 'Ed25519',
                  id        : 'sig',
                  purposes  : ['assertionMethod', 'authentication']
                },
                {
                  algorithm : 'X25519',
                  id        : 'enc',
                  purposes  : ['keyAgreement']
                }
              ]
            }
          });

        } else {
          // Reconnecting — use the first local identity. When the agent manages
          // multiple identities (e.g. created via agent.identity.create()), the
          // first one returned by the store is used as the default for connect().
          identity = identities[0];
        }
      }

      // If the stored identity has a connected DID, use it as the connected DID, otherwise use the identity's DID.
      connectedDid = identity.metadata.connectedDid ?? identity.did.uri;
      // If the stored identity has a connected DID, use the identity DID as the delegated DID, otherwise it is undefined.
      delegateDid = identity.metadata.connectedDid ? identity.did.uri : undefined;
      if (registration !== undefined) {
        const updatedTokens: Record<string, RegistrationTokenData> = {
          ...(registration.registrationTokens ?? {}),
        };

        try {
          for (const dwnEndpoint of serviceEndpointNodes) {
            const serverInfo = await userAgent.rpc.getServerInfo(dwnEndpoint);

            if (serverInfo.registrationRequirements.length === 0) {
              continue;
            }

            // Deduplicate DIDs to register.
            const didsToRegister = [agent.agentDid.uri, connectedDid]
              .filter((did, i, arr): did is string => arr.indexOf(did) === i);

            const hasProviderAuth = serverInfo.registrationRequirements.includes('provider-auth-v0')
              && serverInfo.providerAuth !== undefined;

            if (hasProviderAuth && registration.onProviderAuthRequired) {
              // --- Provider Auth Path ---
              let tokenData = updatedTokens[dwnEndpoint];

              // Refresh expired tokens.
              if (tokenData?.expiresAt !== undefined && tokenData.expiresAt < Date.now()) {
                if (tokenData.refreshUrl && tokenData.refreshToken) {
                  const refreshed = await DwnRegistrar.refreshRegistrationToken(
                    tokenData.refreshUrl, tokenData.refreshToken,
                  );
                  tokenData = {
                    registrationToken : refreshed.registrationToken,
                    refreshToken      : refreshed.refreshToken,
                    expiresAt         : refreshed.expiresIn !== undefined
                      ? Date.now() + (refreshed.expiresIn * 1000) : undefined,
                    tokenUrl   : tokenData.tokenUrl,
                    refreshUrl : tokenData.refreshUrl,
                  };
                  updatedTokens[dwnEndpoint] = tokenData;
                } else {
                  tokenData = undefined;
                }
              }

              // Run the auth flow if no valid token exists.
              if (tokenData === undefined) {
                const state = crypto.randomUUID();
                const providerAuth = serverInfo.providerAuth!;
                const separator = providerAuth.authorizeUrl.includes('?') ? '&' : '?';
                const authorizeUrl = `${providerAuth.authorizeUrl}${separator}`
                  + `redirect_uri=${encodeURIComponent(dwnEndpoint)}`
                  + `&state=${encodeURIComponent(state)}`;

                const authResult = await registration.onProviderAuthRequired({
                  authorizeUrl,
                  dwnEndpoint,
                  state,
                });

                if (authResult.state !== state) {
                  throw new Error('Provider auth state mismatch — possible CSRF attack.');
                }

                const tokenResponse = await DwnRegistrar.exchangeAuthCode(
                  providerAuth.tokenUrl, authResult.code, dwnEndpoint,
                );

                tokenData = {
                  registrationToken : tokenResponse.registrationToken,
                  refreshToken      : tokenResponse.refreshToken,
                  expiresAt         : tokenResponse.expiresIn !== undefined
                    ? Date.now() + (tokenResponse.expiresIn * 1000) : undefined,
                  tokenUrl   : providerAuth.tokenUrl,
                  refreshUrl : providerAuth.refreshUrl,
                };
                updatedTokens[dwnEndpoint] = tokenData;
              }

              // Register each DID using the provider auth token.
              for (const did of didsToRegister) {
                await DwnRegistrar.registerTenantWithToken(
                  dwnEndpoint, did, tokenData.registrationToken,
                );
              }

            } else {
              // --- Default Path (PoW / general registration) ---
              for (const did of didsToRegister) {
                await DwnRegistrar.registerTenant(dwnEndpoint, did);
              }
            }
          }

          // Notify app of updated tokens for persistence.
          if (registration.onRegistrationTokens) {
            registration.onRegistrationTokens(updatedTokens);
          }

          registration.onSuccess();
        } catch (error) {
          registration.onFailure(error);
        }
      }

      // Enable sync, unless explicitly disabled.
      if (sync !== 'off') {
        // First, register the user identity for sync.
        // The connected protocols are used to register sync for only a subset of protocols from the connectedDid's DWN

        if (registerSync) {
          await userAgent.sync.registerIdentity({
            did     : connectedDid,
            options : {
              delegateDid,
              protocols: connectedProtocols
            }
          });

          if (walletConnectOptions !== undefined) {
            // If we are using WalletConnect, we should do a one-shot sync to pull down any messages that are associated with the connectedDid
            await userAgent.sync.sync('pull');
          }
        }

        // Enable sync using the specified interval or default.
        // When sync is unset (undefined), default to live mode.
        // When sync is an interval string (e.g. '2m', '30s'), use poll mode with that interval.
        const syncMode = sync === undefined ? 'live' : 'poll';
        const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
        userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
          .catch((error: any) => {
            console.error(`Sync failed: ${error}`);
          });
      }
    }

    const web5 = new Web5({ agent, connectedDid, delegateDid });

    return { web5, did: connectedDid, delegateDid, recoveryPhrase };
  }

  /**
   * Cleans up the DID, Keys and Identity. Primarily used by a failed WalletConnect import.
   * Does not throw on error, but logs to console.
   */
  private static async cleanUpIdentity({ identity, userAgent }:{
    identity: BearerIdentity,
    userAgent: Web5UserAgent
  }): Promise<void> {
    try {
      // Delete the DID and the Associated Keys
      await userAgent.did.delete({
        didUri    : identity.did.uri,
        tenant    : identity.metadata.tenant,
        deleteKey : true,
      });
    } catch (error: any) {
      console.error(`Failed to delete DID ${identity.did.uri}: ${error.message}`);
    }

    try {
      // Delete the Identity
      await userAgent.identity.delete({ didUri: identity.did.uri });
    } catch (error: any) {
      console.error(`Failed to delete Identity ${identity.metadata.name}: ${error.message}`);
    }
  }

  /**
   * A static method to process connected grants for a delegate DID.
   *
   * This will store the grants as the DWN owner to be used later when impersonating the connected DID.
   */
  static async processConnectedGrants({ grants, agent, delegateDid }: {
    grants: DwnDataEncodedRecordsWriteMessage[],
    agent: Web5Agent,
    delegateDid: string,
  }): Promise<string[]> {
    const connectedProtocols = new Set<string>();
    for (const grantMessage of grants) {
      // use the delegateDid as the connectedDid of the grant as they do not yet support impersonation/delegation
      const grant = PermissionGrant.parse({ connectedDid: delegateDid, agent, message: grantMessage });
      // store the grant as the owner of the DWN, this will allow the delegateDid to use the grant when impersonating the connectedDid
      const { status } = await grant.store(true);
      if (status.code !== 202) {
        throw new Error(`AgentDwnApi: Failed to process connected grant: ${status.detail}`);
      }

      const protocol = (grant.scope as DwnMessagesPermissionScope | DwnRecordsPermissionScope).protocol;
      if (protocol) {
        connectedProtocols.add(protocol);
      }
    }

    // currently we return a de-duped set of protocols represented by these grants, this is used to register protocols for sync
    // we expect that any connected protocols will include MessagesSync and MessagesRead grants that will allow it to sync
    return [...connectedProtocols];
  }
}
