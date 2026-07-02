#!/usr/bin/env node
import { DwnServer } from './dwn-server.js';

const dwnServer = new DwnServer();

await dwnServer.start();

// Keep the CLI process alive after the server has started.
await new Promise<never>(() => {});
