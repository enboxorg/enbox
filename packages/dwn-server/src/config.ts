import { readFileSync } from 'fs';

import bytes from 'bytes';

export type DwnServerConfig = typeof config;

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
  maxRecordDataSize : bytes(process.env.MAX_RECORD_DATA_SIZE || '100mb'),

  /**
   * Maximum number of unacknowledged subscription events the server will send
   * per subscription before pausing delivery. Clients must send `rpc.ack` to
   * advance the window. Configurable via `DWN_MAX_IN_FLIGHT` env var.
   */
  maxInFlight: parseInt(process.env.DWN_MAX_IN_FLIGHT || '32'),

  // whether to enable 'ws:'
  webSocketSupport: { on: true, off: false }[process.env.DS_WEBSOCKET_SERVER] ?? true,

  /**
   * Path to DWN EventLog plugin to use. Default in-memory implementation will be used if left empty.
   * Also accepts the legacy `DWN_EVENT_STREAM_PLUGIN_PATH` env var for backward compatibility.
   */
  eventLogPluginPath: process.env.DWN_EVENT_LOG_PLUGIN_PATH || process.env.DWN_EVENT_STREAM_PLUGIN_PATH,

  // where to store persistent data
  messageStore       : process.env.DWN_STORAGE_MESSAGES || process.env.DWN_STORAGE || 'level://data',
  dataStore          : process.env.DWN_STORAGE_DATA || process.env.DWN_STORAGE || 'level://data',
  stateIndex         : process.env.DWN_STORAGE_STATE_INDEX || process.env.DWN_STORAGE || 'level://data',
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
   * Maximum HTTP requests per second per IP address. 0 = unlimited (default).
   */
  rateLimitRequestsPerSecond: parseInt(process.env.DWN_RATE_LIMIT_REQUESTS_PER_SECOND || '0'),

  /**
   * Maximum burst size for per-IP rate limiting. Defaults to 50.
   */
  rateLimitBurst: parseInt(process.env.DWN_RATE_LIMIT_BURST || '50'),

  /**
   * Maximum DWN requests per second per tenant DID. 0 = unlimited (default).
   */
  rateLimitTenantRequestsPerSecond: parseInt(process.env.DWN_RATE_LIMIT_TENANT_REQUESTS_PER_SECOND || '0'),

  /**
   * Maximum burst size for per-tenant rate limiting. Defaults to 50.
   */
  rateLimitTenantBurst: parseInt(process.env.DWN_RATE_LIMIT_TENANT_BURST || '50'),
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
