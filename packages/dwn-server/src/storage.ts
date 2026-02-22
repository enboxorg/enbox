import type { Dialect } from '@enbox/dwn-sql-store';
import type { DidResolver } from '@enbox/dids';
import type { DwnServerConfig } from './config.js';
import type {
  DataStore,
  DwnConfig,
  EventLog,
  MessageStore,
  ResumableTaskStore,
  StateIndex,
  TenantGate,
} from '@enbox/dwn-sdk-js';

import * as fs from 'fs';
import Cursor from 'pg-cursor';
import { createPool as MySQLCreatePool } from 'mysql2';
import pg from 'pg';

import { Kysely } from 'kysely';

import { createBunSqliteDatabase } from '@enbox/dwn-sql-store';
import { PluginLoader } from './plugin-loader.js';

import {
  DataStoreLevel,
  MessageStoreLevel,
  ResumableTaskStoreLevel,
  StateIndexLevel,
} from '@enbox/dwn-sdk-js';
import {
  DataStoreSql,
  MessageStoreSql,
  MysqlDialect,
  PostgresDialect,
  ResumableTaskStoreSql,
  runDwnStoreMigrations,
  SqliteDialect,
  StateIndexSql,
} from '@enbox/dwn-sql-store';

export enum StoreType {
  DataStore,
  MessageStore,
  StateIndex,
  ResumableTaskStore,
}

export enum BackendTypes {
  LEVEL = 'level',
  SQLITE = 'sqlite',
  MYSQL = 'mysql',
  POSTGRES = 'postgres',
}

export type DwnStore = DataStore | StateIndex | MessageStore | ResumableTaskStore;

/**
 * Cache of shared PostgreSQL dialects keyed by connection URL. When multiple
 * DWN stores share the same Postgres URL, they reuse a single dialect (and
 * thus a single `pg.Pool`) instead of each creating their own. This reduces
 * connection count from 4 × pool_max to 1 × pool_max per DWN process.
 */
const sharedDialectCache: Map<string, Dialect> = new Map();

/**
 * Returns a (potentially cached) dialect for the given Postgres connection URL.
 * Non-Postgres URLs always return a fresh dialect (no caching).
 */
function getOrCreateDialect(connectionUrl: URL, config: DwnServerConfig): Dialect {
  const protocol = connectionUrl.protocol.slice(0, -1);

  if (protocol !== BackendTypes.POSTGRES) {
    return getDialectFromUrl(connectionUrl);
  }

  const key = connectionUrl.toString();
  const cached = sharedDialectCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // Create a single pg.Pool instance with configurable sizing.
  const pool = new pg.Pool({
    connectionString  : connectionUrl.toString(),
    min               : config.pgPoolMin,
    max               : config.pgPoolMax,
    idleTimeoutMillis : config.pgPoolIdleTimeout,
  });

  const dialect = new PostgresDialect({
    pool   : async (): Promise<pg.Pool> => pool,
    cursor : Cursor,
  });

  sharedDialectCache.set(key, dialect);
  return dialect;
}

export async function getDwnConfig(
  config : DwnServerConfig,
  options : {
    didResolver? : DidResolver,
    tenantGate? : TenantGate,
    eventLog? : EventLog,
  }
): Promise<DwnConfig> {
  const { tenantGate, eventLog, didResolver } = options;

  // Run SQL schema migrations before creating stores. Uses the data store
  // connection to determine the dialect — all SQL stores typically share the
  // same database. Non-SQL backends (level://) are skipped.
  await runSqlMigrationsIfNeeded(config);

  const dataStore: DataStore = await getStore(config, config.dataStore, StoreType.DataStore);
  const stateIndex: StateIndex = await getStore(config, config.stateIndex, StoreType.StateIndex);
  const messageStore: MessageStore = await getStore(config, config.messageStore, StoreType.MessageStore);
  const resumableTaskStore: ResumableTaskStore = await getStore(config, config.resumableTaskStore, StoreType.ResumableTaskStore);

  return { didResolver, eventLog, stateIndex, dataStore, messageStore, resumableTaskStore, tenantGate };
}

/**
 * Runs DWN SQL schema migrations if the data store is configured with a SQL
 * backend. Creates a temporary Kysely instance, runs all pending migrations,
 * then destroys it. The subsequent store `open()` calls will reuse the shared
 * dialect/pool and find the schema already in place.
 */
async function runSqlMigrationsIfNeeded(config: DwnServerConfig): Promise<void> {
  // Skip if the data store config is a file path (plugin) or non-SQL backend
  if (isFilePath(config.dataStore)) {
    return;
  }

  let storeUrl: URL;
  try {
    storeUrl = new URL(config.dataStore);
  } catch {
    return; // Not a valid URL — skip
  }

  const protocol = storeUrl.protocol.slice(0, -1);
  const sqlBackends: string[] = [BackendTypes.SQLITE, BackendTypes.MYSQL, BackendTypes.POSTGRES];
  if (!sqlBackends.includes(protocol)) {
    return;
  }

  const dialect = getOrCreateDialect(storeUrl, config);
  const db = new Kysely<Record<string, unknown>>({ dialect });
  try {
    const applied = await runDwnStoreMigrations(db, dialect);
    if (applied.length > 0) {
      console.log(`DWN migrations applied: ${applied.join(', ')}`);
    }
  } finally {
    // Don't destroy the Kysely instance if using a shared Postgres pool —
    // the pool is cached in sharedDialectCache and will be reused by stores.
    // Only destroy for non-cached dialects (SQLite, MySQL).
    if (protocol !== BackendTypes.POSTGRES) {
      await db.destroy();
    }
  }
}

function getLevelStore(
  storeURI: URL,
  storeType: StoreType,
): DwnStore {
  switch (storeType) {
    case StoreType.DataStore:
      return new DataStoreLevel({
        blockstoreLocation: storeURI.host + storeURI.pathname + '/DATASTORE',
      });
    case StoreType.MessageStore:
      return new MessageStoreLevel({
        blockstoreLocation : storeURI.host + storeURI.pathname + '/MESSAGESTORE',
        indexLocation      : storeURI.host + storeURI.pathname + '/INDEX',
      });
    case StoreType.StateIndex:
      return new StateIndexLevel({
        location: storeURI.host + storeURI.pathname + '/STATEINDEX',
      });
    case StoreType.ResumableTaskStore:
      return new ResumableTaskStoreLevel({
        location: storeURI.host + storeURI.pathname + '/RESUMABLE-TASK-STORE',
      });
    default:
      throw new Error('Unexpected level store type');
  }
}

function getSqlStore(
  config: DwnServerConfig,
  connectionUrl: URL,
  storeType: StoreType,
): DwnStore {
  const dialect = getOrCreateDialect(connectionUrl, config);

  switch (storeType) {
    case StoreType.DataStore:
      return new DataStoreSql(dialect);
    case StoreType.MessageStore:
      return new MessageStoreSql(dialect);
    case StoreType.StateIndex:
      return new StateIndexSql(dialect);
    case StoreType.ResumableTaskStore:
      return new ResumableTaskStoreSql(dialect);
    default:
      throw new Error(`Unsupported store type ${storeType} for SQL store.`);
  }
}

/**
 * Check if the given string is a file path.
 */
function isFilePath(configString: string): boolean {
  const filePathPrefixes = ['/', './', '../'];
  return filePathPrefixes.some(prefix => configString.startsWith(prefix));
}

async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.DataStore): Promise<DataStore>;
async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.StateIndex): Promise<StateIndex>;
async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.MessageStore): Promise<MessageStore>;
async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.ResumableTaskStore): Promise<ResumableTaskStore>;
async function getStore(config: DwnServerConfig, storeConfigString: string, storeType: StoreType): Promise<DwnStore> {
  if (isFilePath(storeConfigString)) {
    return await loadStoreFromFilePath(storeConfigString, storeType);
  }
  // else treat the `storeConfigString` as a connection string

  const storeURI = new URL(storeConfigString);

  switch (storeURI.protocol.slice(0, -1)) {
    case BackendTypes.LEVEL:
      return getLevelStore(storeURI, storeType);

    case BackendTypes.SQLITE:
    case BackendTypes.MYSQL:
    case BackendTypes.POSTGRES:
      return getSqlStore(config, storeURI, storeType);

    default:
      throw invalidStorageSchemeMessage(storeURI.protocol);
  }
}

/**
 * Loads a DWN store plugin of the given type from the given file path.
 */
async function loadStoreFromFilePath(
  filePath: string,
  storeType: StoreType,
): Promise<DwnStore> {
  switch (storeType) {
    case StoreType.DataStore:
      return await PluginLoader.loadPlugin<DataStore>(filePath);
    case StoreType.StateIndex:
      return await PluginLoader.loadPlugin<StateIndex>(filePath);
    case StoreType.MessageStore:
      return await PluginLoader.loadPlugin<MessageStore>(filePath);
    case StoreType.ResumableTaskStore:
      return await PluginLoader.loadPlugin<ResumableTaskStore>(filePath);
    default:
      throw new Error(`Loading store for unsupported store type ${storeType} from path ${filePath}`);
  }
}

export function getDialectFromUrl(connectionUrl: URL): Dialect {
  switch (connectionUrl.protocol.slice(0, -1)) {
    case BackendTypes.SQLITE: {
      const path = connectionUrl.host + connectionUrl.pathname;
      console.log('SQL-lite relative path:', path ? path : undefined); // NOTE, using ? for lose equality comparison

      if (connectionUrl.host && !fs.existsSync(connectionUrl.host)) {
        console.log('SQL-lite directory does not exist, creating:', connectionUrl.host);
        fs.mkdirSync(connectionUrl.host, { recursive: true });
      }

      // Use in-memory database if no path is provided (for tests)
      const dbPath = path || ':memory:';

      return new SqliteDialect({
        database: async () => createBunSqliteDatabase(dbPath),
      });
    }
    case BackendTypes.MYSQL:
      return new MysqlDialect({
        pool: async () => MySQLCreatePool(connectionUrl.toString()),
      });
    case BackendTypes.POSTGRES:
      return new PostgresDialect({
        pool   : async () => new pg.Pool({ connectionString: connectionUrl.toString() }),
        cursor : Cursor,
      });
  }
}

function invalidStorageSchemeMessage(protocol: string): string {
  const schemes = [];
  for (const [_, value] of Object.entries(BackendTypes)) {
    schemes.push(value);
  }
  return (
    'Unknown storage protocol ' +
    protocol.slice(0, -1) +
    '! Please use one of: ' +
    schemes.join(', ') +
    '. For details, see README'
  );
}
