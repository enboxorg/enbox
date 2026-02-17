import { Cid, DataStream, RecordsWrite } from '@enbox/dwn-sdk-js';
import type { GenericMessage, Persona, UnionMessageReply } from '@enbox/dwn-sdk-js';

import { fileURLToPath } from 'url';
import fs from 'node:fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';

import type { JsonRpcResponse } from '../src/lib/json-rpc.js';

import { createJsonRpcRequest } from '../src/lib/json-rpc.js';

// __filename and __dirname are not defined in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type CreateRecordsWriteOverrides =
  | ({
      dataCid?: string;
      dataSize?: number;
      dateCreated?: string;
      published?: boolean;
      recordId?: string;
      protocol?: string;
      protocolPath?: string;
    } & { data?: never })
  | ({
      dataCid?: never;
      dataSize?: never;
      dateCreated?: string;
      published?: boolean;
      recordId?: string;
      protocol?: string;
      protocolPath?: string;
    } & { data?: Uint8Array });

export type GenerateRecordsWriteOutput = {
  recordsWrite: RecordsWrite;
  dataStream: ReadableStream<Uint8Array> | undefined;
};

export async function createRecordsWriteMessage(
  signer: Persona,
  overrides: CreateRecordsWriteOverrides = {},
): Promise<GenerateRecordsWriteOutput> {
  if (!overrides.dataCid && !overrides.data) {
    overrides.data = randomBytes(32);
  }

  const recordsWrite = await RecordsWrite.create({
    ...overrides,
    dataFormat : 'application/json',
    signer     : signer.signer,
  });

  let dataStream: ReadableStream<Uint8Array> | undefined;
  if (overrides.data) {
    dataStream = DataStream.fromBytes(overrides.data);
  }

  return {
    recordsWrite,
    dataStream,
  };
}

export function randomBytes(length: number): Uint8Array {
  const randomBytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    randomBytes[i] = Math.floor(Math.random() * 256);
  }

  return randomBytes;
}

export async function getFileAsReadStream(
  filePath: string,
): Promise<{ stream: Blob; cid: string; size: number }> {
  const absoluteFilePath = `${__dirname}/${filePath}`;

  const fileBytes = fs.readFileSync(absoluteFilePath);
  const cid = await Cid.computeDagPbCidFromBytes(fileBytes);
  const size = fileBytes.byteLength;

  return {
    stream: new Blob([fileBytes]),
    cid,
    size,
  };
}

export function getDwnResponse(response: Response): UnionMessageReply {
  return JSON.parse(response.headers.get('dwn-response') as string) as UnionMessageReply;
}

export async function sendHttpMessage(options: {
  url: string,
  target: string,
  message: GenericMessage,
  data?: any,
}): Promise<UnionMessageReply> {
  const { url, target, message, data } = options;
  // First RecordsWrite that creates the record.
  const requestId = uuidv4();
  const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
    target,
    message,
  });

  const fetchOpts = {
    method  : 'POST',
    headers : {
      'dwn-request': JSON.stringify(jsonRpcRequest)
    }
  };

  if (data !== undefined) {
    fetchOpts.headers['content-type'] = 'application/octet-stream';
    fetchOpts['body'] = data;
  }

  const resp = await fetch(url, fetchOpts);
  let dwnRpcResponse: JsonRpcResponse;

  // check to see if response is in header first. if it is, that means the response is a ReadableStream
  let dataStream;
  const { headers } = resp;
  if (headers.has('dwn-response')) {
    const jsonRpcResponse = JSON.parse(headers.get('dwn-response')) as JsonRpcResponse;

    if (jsonRpcResponse == null) {
      throw new Error(`failed to parse json rpc response. dwn url: ${url}`);
    }

    dataStream = resp.body;
    dwnRpcResponse = jsonRpcResponse;
  } else {
    const responseBody = await resp.text();
    dwnRpcResponse = JSON.parse(responseBody);
  }

  if (dwnRpcResponse.error) {
    const { code, message } = dwnRpcResponse.error;
    throw new Error(`(${code}) - ${message}`);
  }

  const { reply } = dwnRpcResponse.result;
  if (dataStream) {
    reply['record']['data'] = dataStream;
  }

  return reply as UnionMessageReply;
}

/**
 * Polls until the predicate returns true, or rejects after `timeoutMs`.
 * Use this instead of fixed `setTimeout` delays when waiting for async events
 * (e.g. WebSocket subscription messages) to avoid timing-dependent flakiness.
 */
export async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export async function sendWsMessage(
  address: string,
  message: any,
): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket = new WebSocket(address);

    socket.onopen = (_event): void => {
      socket.onmessage = (event): void => {
        socket.terminate();
        return resolve(event.data as Buffer);
      };

      socket.send(message);
    };
  });
}
