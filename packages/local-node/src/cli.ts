#!/usr/bin/env bun

import { AllowOriginPairingBroker, LocalNode, TtyPairingBroker } from './index.js';

type CliOptions = {
  allowedOrigins : string[];
  help : boolean;
  hostname? : string;
  port? : number;
  storageUrl? : string;
  webSocketSupport : boolean;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    allowedOrigins   : [],
    help             : false,
    webSocketSupport : true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--allow-origin') {
      options.allowedOrigins.push(readValue(args, i, arg));
      i += 1;
    } else if (arg === '--host') {
      options.hostname = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--no-ws') {
      options.webSocketSupport = false;
    } else if (arg === '--port') {
      options.port = parsePort(readValue(args, i, arg));
      i += 1;
    } else if (arg === '--storage-url') {
      options.storageUrl = readValue(args, i, arg);
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function printHelp(): void {
  console.log(`Usage: enbox-local-node [options]

Options:
  --allow-origin <origin>  Auto-approve a browser origin for dev/CI. Repeatable.
  --host <hostname>        Loopback bind hostname. Defaults to 127.0.0.1.
  --port <port>            Bind a single port instead of the shared candidate list.
  --storage-url <url>      DWN Level/SQL storage URL. Defaults to dwn-server config.
  --no-ws                  Disable WebSocket support.
  -h, --help               Show this help text.
`);
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const node = new LocalNode({
    allowedOrigins   : options.allowedOrigins,
    hostname         : options.hostname,
    pairingBroker    : new AllowOriginPairingBroker(options.allowedOrigins, new TtyPairingBroker()),
    portCandidates   : options.port === undefined ? undefined : [options.port],
    storageUrl       : options.storageUrl,
    webSocketSupport : options.webSocketSupport,
  });

  const result = await node.start();
  console.log(`Enbox local node listening on ${result.endpoint}`);
  console.log(`Discovery file: ${result.discoveryFilePath}`);

  const shutdown = async (): Promise<void> => {
    await node.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await new Promise((): void => {});
}

try {
  await run();
} catch (error: unknown) {
  console.error(error);
  process.exit(1);
}
