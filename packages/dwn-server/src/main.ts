#!/usr/bin/env node
import { DwnServer } from './dwn-server.js';

const dwnServer = new DwnServer();

await dwnServer.start();
