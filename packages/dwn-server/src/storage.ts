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

export async function getDwnConfig(
  config : DwnServerConfig,
  options : {
    didResolver? : DidResolver,
    tenantGate? : TenantGate,
    eventLog? : EventLog,
  }
): Promise<DwnConfig> {
  const { tenantGate, eventLog, didResolver } = options;
  const dataStore: DataStore = await getStore(config.dataStore, StoreType.DataStore);
  const stateIndex: StateIndex = await getStore(config.stateIndex, StoreType.StateIndex);
  const messageStore: MessageStore = await getStore(config.messageStore, StoreType.MessageStore);
  const resumableTaskStore: ResumableTaskStore = await getStore(config.resumableTaskStore, StoreType.ResumableTaskStore);

  return { didResolver, eventLog, stateIndex, dataStore, messageStore, resumableTaskStore, tenantGate };
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
  connectionUrl: URL,
  storeType: StoreType,
): DwnStore {
  const dialect = getDialectFromUrl(connectionUrl);

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

async function getStore(storeString: string, storeType: StoreType.DataStore): Promise<DataStore>;
async function getStore(storeString: string, storeType: StoreType.StateIndex): Promise<StateIndex>;
async function getStore(storeString: string, storeType: StoreType.MessageStore): Promise<MessageStore>;
async function getStore(storeString: string, storeType: StoreType.ResumableTaskStore): Promise<ResumableTaskStore>;
async function getStore(storeConfigString: string, storeType: StoreType): Promise<DwnStore> {
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
      return getSqlStore(storeURI, storeType);

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
