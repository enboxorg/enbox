import type { DwnServerConfig } from '@enbox/dwn-server';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultDwnServerConfig } from '@enbox/dwn-server';

export type LocalNodeServerConfigOptions = {
  allowedOrigins? : string[];
  baseUrl? : string;
  dataStore? : string;
  deliveryEnabled? : boolean;
  eventBusPluginPath? : string;
  forwardingEnabled? : boolean;
  hostname? : string;
  logLevel? : string;
  maxRecordDataSize? : number;
  messageStore? : string;
  packageJsonPath? : string;
  port : number;
  registrationStoreUrl? : string;
  resumableTaskStore? : string;
  serverName? : string;
  storageUrl? : string;
  termsOfServiceFilePath? : string;
  ttlCacheUrl? : string;
  webSocketSupport? : boolean;
};

export const defaultLocalNodeHostname = '127.0.0.1';
export const defaultLocalNodeStorageUrl = pathToFileURL(join(homedir(), '.enbox', 'dwn')).href.replace('file:', 'level:');

export function createLocalNodeDwnServerConfig(options: LocalNodeServerConfigOptions): DwnServerConfig {
  const hostname = options.hostname ?? defaultLocalNodeHostname;
  const storageUrl = options.storageUrl ?? process.env.DWN_STORAGE ?? defaultLocalNodeStorageUrl;

  return {
    ...defaultDwnServerConfig,
    baseUrl                 : options.baseUrl ?? `http://${hostname}:${options.port}`,
    dataStore               : options.dataStore ?? process.env.DWN_STORAGE_DATA ?? storageUrl,
    deliveryEnabled         : options.deliveryEnabled ?? true,
    eventBusPluginPath      : options.eventBusPluginPath ?? defaultDwnServerConfig.eventBusPluginPath,
    forwardingEnabled       : options.forwardingEnabled ?? true,
    hostname,
    localNodeAllowedOrigins : options.allowedOrigins ?? [],
    localNodeProfileEnabled : true,
    logLevel                : options.logLevel ?? defaultDwnServerConfig.logLevel,
    maxRecordDataSize       : options.maxRecordDataSize ?? 1_073_741_824,
    messageStore            : options.messageStore ?? process.env.DWN_STORAGE_MESSAGES ?? storageUrl,
    packageJsonPath         : options.packageJsonPath ?? defaultDwnServerConfig.packageJsonPath,
    port                    : options.port,
    registrationStoreUrl    : options.registrationStoreUrl ?? defaultDwnServerConfig.registrationStoreUrl,
    resumableTaskStore      : options.resumableTaskStore ?? process.env.DWN_STORAGE_RESUMABLE_TASKS ?? storageUrl,
    serverName              : options.serverName ?? defaultDwnServerConfig.serverName,
    termsOfServiceFilePath  : options.termsOfServiceFilePath ?? defaultDwnServerConfig.termsOfServiceFilePath,
    ttlCacheUrl             : options.ttlCacheUrl ?? defaultDwnServerConfig.ttlCacheUrl,
    webSocketSupport        : options.webSocketSupport ?? defaultDwnServerConfig.webSocketSupport,
  };
}
