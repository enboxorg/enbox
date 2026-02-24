#!/usr/bin/env node

/**
 * CLI entry point for @enbox/dwn-relay.
 *
 * Starts a RelayServer with configuration from environment variables.
 * Inherits all dwn-server env vars plus relay-specific DWN_RELAY_* vars.
 */

import log from 'loglevel';
import prefix from 'loglevel-plugin-prefix';

import { RelayServer } from './relay-server.js';

prefix.reg(log);
prefix.apply(log);

const logLevel = (process.env.DWN_SERVER_LOG_LEVEL ?? 'INFO') as log.LogLevelDesc;
log.setLevel(logLevel);

async function main(): Promise<void> {
  log.info('Starting DWN Relay Server...');

  const relay = new RelayServer();

  // Handle graceful shutdown
  const shutdown = async (): Promise<void> => {
    log.info('Shutting down DWN Relay Server...');
    await relay.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await relay.start();

  log.info('DWN Relay Server is running');
}

main().catch((err) => {
  log.error('Failed to start DWN Relay Server:', err);
  process.exit(1);
});
