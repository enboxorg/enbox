import { readFileSync } from 'fs';

export type DwnServerConfig = typeof config;

const byteSizeUnits: Record<string, number> = {
  b  : 1,
  gb : 1024 ** 3,
  kb : 1024,
  mb : 1024 ** 2,
};

function parseCommaSeparatedList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(',')
    .map((entry: string): string => entry.trim())
    .filter((entry: string): boolean => entry.length > 0);
}

/**
 * Parses a byte-size string with optional b/kb/mb/gb suffix into bytes.
 */
export function parseByteSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(value.trim());
  if (match === null) {
    throw new TypeError(`Invalid byte size '${value}'. Use a byte count or b/kb/mb/gb suffix.`);
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase() ?? 'b';
  const byteSize = Math.floor(amount * byteSizeUnits[unit]);

  if (!Number.isSafeInteger(byteSize)) {
    throw new TypeError(`Invalid byte size '${value}'. Parsed value is outside the safe integer range.`);
  }

  return byteSize;
}

export const config = {
  /**
   * Used to populate the `server` property returned by the `/info` endpoint.
   */
  serverName: process.env.DWN_SERVER_PACKAGE_NAME || '@enbox/dwn-server',

  /**
   * The base external URL of this DWN.
   * This is used to construct URL paths such as the `Request URI` in the Web5 Connect flow.
   * Should NOT be pointing to `localhost` for production use.
   */
  baseUrl: process.env.DWN_BASE_URL || 'http://localhost:3000',

  /**
   * Port that server listens on.
   */
  port: parseInt(process.env.DS_PORT || '3000'),

  /**
   * Hostname or interface that the HTTP server binds to. When the local-node
   * profile is enabled, this defaults to loopback and non-loopback values are rejected.
   */
  hostname: process.env.DS_HOST || (process.env.DWN_LOCAL_NODE_PROFILE === 'true' ? '127.0.0.1' : undefined),

  /**
   * Enables the local DWN node trust profile. This profile is opt-in so cloud
   * deployments keep their existing behavior unless explicitly configured.
   */
  localNodeProfileEnabled: process.env.DWN_LOCAL_NODE_PROFILE === 'true',

  /**
   * Origins supplied by local-node wrappers for development/CI policy.
   * Protected local-node routes are authorized by per-origin pairing tokens.
   */
  localNodeAllowedOrigins: parseCommaSeparatedList(process.env.DWN_LOCAL_NODE_ALLOWED_ORIGINS),

  /**
   * The URL of the TTL cache used by the DWN.
   * NOTE: Used for session/state keeping, thus requires the cache to be commonly addressable by nodes in a cloud cluster environment.
   *
   * Currently only supports SQL databases, e.g.
   * Postgres: 'postgres://root:dwn@localhost:5432/dwn'
   * MySQL: 'mysql://root:dwn@localhost:3306/dwn'
   */
  ttlCacheUrl: process.env.DWN_TTL_CACHE_URL || 'sqlite://',

  /**
   * Used to populate the `version` and `sdkVersion` properties returned by the `/info` endpoint.
   *
   * The `version` and `sdkVersion` are pulled from `package.json` at runtime.
   * If `DWN_SERVER_PACKAGE_JSON` is set, we use that path.
   * Otherwise we resort to the path within the docker server image, located at `/dwn-server/package.json`.
   */
  packageJsonPath   : process.env.DWN_SERVER_PACKAGE_JSON || '/dwn-server/package.json',
  /**
   * Maximum size of data that can be provided with a RecordsWrite.
   * Request bodies up to this size are buffered fully into memory, so the
   * default should be conservative enough to prevent memory exhaustion from
   * concurrent large uploads. Operators can raise the limit via the
   * `MAX_RECORD_DATA_SIZE` env var (e.g. `'1gb'`).
   */
  maxRecordDataSize : parseByteSize(process.env.MAX_RECORD_DATA_SIZE || '100mb'),

  /**
   * Maximum number of unacknowledged subscription events the server will send
   * per subscription before pausing delivery. Clients must send `rpc.ack` to
   * advance the window. Configurable via `DWN_MAX_IN_FLIGHT` env var.
   */
  maxInFlight: parseInt(process.env.DWN_MAX_IN_FLIGHT || '32'),

  // whether to enable 'ws:'
  webSocketSupport: { on: true, off: false }[process.env.DS_WEBSOCKET_SERVER] ?? true,

  /**
   * Path to DWN EventBus plugin to use for cross-process durable-log wakes.
   * Default in-memory implementation will be used if left empty.
   */
  eventBusPluginPath: process.env.DWN_EVENT_BUS_PLUGIN_PATH,

  // where to store persistent data
  messageStore       : process.env.DWN_STORAGE_MESSAGES || process.env.DWN_STORAGE || 'level://data',
  dataStore          : process.env.DWN_STORAGE_DATA || process.env.DWN_STORAGE || 'level://data',
  resumableTaskStore : process.env.DWN_STORAGE_RESUMABLE_TASKS || process.env.DWN_STORAGE || 'level://data',

  /**
   * PostgreSQL connection pool tuning. When multiple DWN stores share the same
   * Postgres connection URL, a single shared pool is used instead of one pool
   * per store (which would be 4 pools x 10 default connections = 40 connections).
   */
  pgPoolMin         : parseInt(process.env.DWN_PG_POOL_MIN || '5'),
  pgPoolMax         : parseInt(process.env.DWN_PG_POOL_MAX || '30'),
  pgPoolIdleTimeout : parseInt(process.env.DWN_PG_POOL_IDLE_TIMEOUT || '30000'),

  // tenant registration feature configuration
  registrationStoreUrl                  : process.env.DWN_REGISTRATION_STORE_URL || process.env.DWN_STORAGE,
  registrationProofOfWorkSeed           : process.env.DWN_REGISTRATION_PROOF_OF_WORK_SEED,
  registrationProofOfWorkEnabled        : process.env.DWN_REGISTRATION_PROOF_OF_WORK_ENABLED === 'true',
  registrationProofOfWorkInitialMaxHash : process.env.DWN_REGISTRATION_PROOF_OF_WORK_INITIAL_MAX_HASH,
  termsOfServiceFilePath                : process.env.DWN_TERMS_OF_SERVICE_FILE_PATH,

  // Provider auth configuration for paid DWN registration
  providerAuthEnabled       : process.env.DWN_PROVIDER_AUTH_ENABLED === 'true',
  providerAuthAuthorizeUrl  : process.env.DWN_PROVIDER_AUTH_AUTHORIZE_URL,
  providerAuthTokenUrl      : process.env.DWN_PROVIDER_AUTH_TOKEN_URL,
  providerAuthRefreshUrl    : process.env.DWN_PROVIDER_AUTH_REFRESH_URL,
  providerAuthManagementUrl : process.env.DWN_PROVIDER_AUTH_MANAGEMENT_URL,
  providerAuthPluginPath    : process.env.DWN_PROVIDER_AUTH_PLUGIN_PATH,
  providerAuthJwtSecret     : process.env.DWN_PROVIDER_AUTH_JWT_SECRET,
  providerAuthJwtJwksUrl    : process.env.DWN_PROVIDER_AUTH_JWT_JWKS_URL,

  // log level - trace/debug/info/warn/error
  logLevel: process.env.DWN_SERVER_LOG_LEVEL || 'INFO',

  /**
   * Bearer token for the admin API. If unset (or empty), the admin API is disabled entirely.
   * Can also be read from a file path via `DWN_ADMIN_TOKEN_FILE` (useful for Docker secrets).
   */
  adminToken: process.env.DWN_ADMIN_TOKEN || (
    process.env.DWN_ADMIN_TOKEN_FILE
      ? readAdminTokenFromFile(process.env.DWN_ADMIN_TOKEN_FILE)
      : undefined
  ),

  /**
   * Maximum number of recent DWN activity events retained in the in-memory
   * ring buffer for the admin `/events` endpoint. Defaults to 10,000.
   */
  adminActivityLogCapacity: parseInt(process.env.DWN_ADMIN_ACTIVITY_LOG_CAPACITY || '10000'),

  /**
   * Interval (in seconds) at which Prometheus gauge metrics are updated from
   * the admin store. Defaults to 30 seconds.
   */
  adminMetricsUpdateIntervalSeconds: parseInt(process.env.DWN_ADMIN_METRICS_UPDATE_INTERVAL || '30'),

  /**
   * WebAuthn Relying Party ID for admin passkey authentication. Typically
   * the hostname of the DWN server (e.g. `dev.aws.dwn.enbox.id`). When not
   * set, the hostname is extracted from `DWN_BASE_URL` at runtime.
   *
   * @see https://github.com/enboxorg/enbox/issues/546
   */
  adminWebAuthnRpId: process.env.DWN_ADMIN_WEBAUTHN_RP_ID || undefined,

  /**
   * Human-readable Relying Party name shown during passkey registration.
   * Defaults to `"DWN Admin"`.
   */
  adminWebAuthnRpName: process.env.DWN_ADMIN_WEBAUTHN_RP_NAME || 'DWN Admin',

  /**
   * Session time-to-live (in seconds) for passkey-authenticated sessions.
   * Defaults to 86400 (24 hours).
   */
  adminSessionTtlSeconds: parseInt(process.env.DWN_ADMIN_SESSION_TTL || '86400'),

  // ---------------------------------------------------------------------------
  // Per-tenant storage quotas
  // ---------------------------------------------------------------------------

  /**
   * Default maximum number of messages a tenant may store. 0 = unlimited (default).
   * Per-tenant overrides are managed via the admin API.
   */
  quotaMaxMessages: parseInt(process.env.DWN_QUOTA_MAX_MESSAGES || '0'),

  /**
   * Default maximum data storage in bytes a tenant may use. 0 = unlimited (default).
   * Per-tenant overrides are managed via the admin API.
   */
  quotaMaxStorageBytes: parseInt(process.env.DWN_QUOTA_MAX_STORAGE_BYTES || '0'),

  // ---------------------------------------------------------------------------
  // Audit log retention
  // ---------------------------------------------------------------------------

  /**
   * Maximum age of audit log entries in days. Entries older than this are purged.
   * 0 = no age limit (default: 90 days).
   *
   * @see https://github.com/enboxorg/enbox/issues/394
   */
  auditLogMaxAgeDays: parseInt(process.env.DWN_AUDIT_LOG_MAX_AGE_DAYS || '90'),

  /**
   * Maximum number of audit log rows to retain. Oldest entries are purged when exceeded.
   * 0 = no row limit (default: 100000).
   *
   * @see https://github.com/enboxorg/enbox/issues/394
   */
  auditLogMaxRows: parseInt(process.env.DWN_AUDIT_LOG_MAX_ROWS || '100000'),

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  /**
   * Maximum HTTP requests per second per IP address. Set to 0 to disable.
   * Defaults to 30 req/s which is generous for normal usage while limiting abuse.
   * Can be reconfigured at runtime via the admin `PATCH /config` endpoint.
   */
  rateLimitRequestsPerSecond: parseInt(process.env.DWN_RATE_LIMIT_REQUESTS_PER_SECOND || '30'),

  /**
   * Maximum burst size for per-IP rate limiting. Allows short spikes above the
   * sustained rate without triggering 429s. Defaults to 50.
   */
  rateLimitBurst: parseInt(process.env.DWN_RATE_LIMIT_BURST || '50'),

  /**
   * Maximum DWN requests per second per tenant DID. Set to 0 to disable.
   * Defaults to 20 req/s. Applies to both HTTP and WebSocket transports.
   * Can be reconfigured at runtime via the admin `PATCH /config` endpoint.
   */
  rateLimitTenantRequestsPerSecond: parseInt(process.env.DWN_RATE_LIMIT_TENANT_REQUESTS_PER_SECOND || '20'),

  /**
   * Maximum burst size for per-tenant rate limiting. Defaults to 50.
   */
  rateLimitTenantBurst: parseInt(process.env.DWN_RATE_LIMIT_TENANT_BURST || '50'),

  // ---------------------------------------------------------------------------
  // Record delivery & endpoint forwarding
  // ---------------------------------------------------------------------------

  /**
   * Enable endpoint forwarding: when a RecordsWrite/RecordsDelete is processed,
   * forward the original signed message to the tenant's other DWN service
   * endpoints (discovered via DID resolution). Disabled by default.
   */
  forwardingEnabled: process.env.DWN_FORWARDING_ENABLED === 'true',

  /**
   * Enable protocol-aware record delivery: when a RecordsWrite/RecordsDelete is
   * processed at a protocol path with `$delivery`, proactively deliver to
   * participants' DWN endpoints. Disabled by default.
   */
  deliveryEnabled: process.env.DWN_DELIVERY_ENABLED === 'true',

  /**
   * Maximum number of concurrent outbound delivery/forwarding requests.
   * Prevents unbounded parallelism when delivering to many providers.
   * Defaults to 10.
   */
  deliveryMaxConcurrency: parseInt(process.env.DWN_DELIVERY_MAX_CONCURRENCY || '10'),

  /**
   * TTL in seconds for caching DID document service endpoint resolution results.
   * Avoids resolving the same DID document on every delivery. Defaults to 300 (5 min).
   */
  deliveryEndpointCacheTtlSeconds: parseInt(process.env.DWN_DELIVERY_ENDPOINT_CACHE_TTL || '300'),

  /**
   * TTL in seconds for the recently-forwarded messageCid deduplication cache.
   * Messages with CIDs in this cache are not forwarded again, reducing redundant
   * outbound requests between peer endpoints. Defaults to 60.
   */
  forwardingDeduplicationTtlSeconds: parseInt(process.env.DWN_FORWARDING_DEDUP_TTL || '60'),
};

/**
 * Reads the admin token from a file path, trimming whitespace.
 * Returns `undefined` if the file cannot be read.
 */
function readAdminTokenFromFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}
