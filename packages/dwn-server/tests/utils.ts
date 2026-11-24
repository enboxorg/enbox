import type { Dialect } from '@enbox/dwn-sql-store';
import type { GenericMessage, Persona, ReplicationApplyResult, UnionMessageReply } from '@enbox/dwn-sdk-js';
import type { JsonRpcRequest, JsonRpcResponse, ParsedHttpDwnRpcResponseBody } from '@enbox/dwn-clients';

import { expect } from 'bun:test';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import { Kysely } from 'kysely';
import path from 'path';
import { WebSocket } from 'ws';
import { Cid, DataStream, Message, RecordsWrite, Replication } from '@enbox/dwn-sdk-js';
import { createBunSqliteDatabase, SqliteDialect } from '@enbox/dwn-sql-store';
import { createHttpDwnRpcRequest, createJsonRpcRequest, isHttpDwnRpcContentType, parseHttpDwnRpcResponseBody } from '@enbox/dwn-clients';

import { getDialectFromUrl } from '../src/storage.js';
import { runServerMigrations } from '../src/server-migration-runner.js';

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
      module?: string;
      modulePath?: string;
    } & { data?: never })
  | ({
      dataCid?: never;
      dataSize?: never;
      dateCreated?: string;
      published?: boolean;
      recordId?: string;
      module?: string;
      modulePath?: string;
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
    module     : 'http://test-module.xyz',
    modulePath : 'testRecord',
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

export async function expectAppliedResultWithPosition(
  result: ReplicationApplyResult,
  tenant: string,
  message: GenericMessage,
): Promise<void> {
  expect(result.kind).toBe('Applied');
  if (result.kind !== 'Applied') {
    throw new Error(`expected Applied replication result, received ${result.kind}`);
  }

  expect(result.position).toBeDefined();
  expect(result.position!.streamId).toBe(await Replication.deriveStreamId(tenant));
  expect(result.position!.position).toBe('2');
  expect(result.position!.messageCid).toBe(await Message.getCid(message));
  expect(typeof result.position!.epoch).toBe('string');
  expect(result.position!.epoch.length).toBeGreaterThan(0);
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

/**
 * Builds the `fetch` init for a framed DWN RPC POST with its projected `dwn-*` headers,
 * adding `duplex` for streaming bodies.
 */
export async function dwnRpcRequestInit(jsonRpcRequest: JsonRpcRequest, data?: BodyInit): Promise<RequestInit & { duplex?: 'half' }> {
  const { body, headers } = await createHttpDwnRpcRequest(jsonRpcRequest, data);
  return {
    method: 'POST',
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  };
}

/** Reads a JSON-RPC POST response: a framed body when the reply carries record data, JSON otherwise. */
export async function readDwnRpcResponse(response: Response): Promise<ParsedHttpDwnRpcResponseBody> {
  if (isHttpDwnRpcContentType(response.headers.get('content-type'))) {
    return parseHttpDwnRpcResponseBody(response.body!);
  }

  return { jsonRpcResponse: await response.json() as JsonRpcResponse };
}

export async function generateRecordsWriteJsonRpcRequest(persona: Persona): Promise<{
  jsonRpcRequest: JsonRpcRequest;
  dataBytes: Uint8Array;
}> {
  const { recordsWrite, dataStream } = await createRecordsWriteMessage(persona);
  const requestId = crypto.randomUUID();
  const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
    message : recordsWrite.toJSON(),
    target  : persona.did,
  });
  const dataBytes = await DataStream.toBytes(dataStream);
  return { jsonRpcRequest, dataBytes };
}

export async function sendHttpMessage(options: {
  url: string,
  target: string,
  message: GenericMessage,
  data?: any,
}): Promise<UnionMessageReply> {
  const { url, target, message, data } = options;
  // First RecordsWrite that creates the record.
  const requestId = crypto.randomUUID();
  const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
    target,
    message,
  });

  const resp = await fetch(url, await dwnRpcRequestInit(jsonRpcRequest, data));
  const { jsonRpcResponse: dwnRpcResponse, dataStream } = await readDwnRpcResponse(resp);

  if (dwnRpcResponse.error) {
    const { code, message } = dwnRpcResponse.error;
    throw new Error(`(${code}) - ${message}`);
  }

  const { reply } = dwnRpcResponse.result;
  if (dataStream) {
    (reply.entry ?? reply.record).data = dataStream;
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

/**
 * Creates an in-memory SQLite dialect with server migrations already applied.
 *
 * For in-memory SQLite, every call to `createBunSqliteDatabase(':memory:')`
 * creates a NEW, independent database. To ensure migrations and store instances
 * share the same database, this helper shares a single underlying database
 * instance via `async () => sharedDb`.
 *
 * @returns A Dialect that can be passed directly to store `.create()` methods.
 */
export async function createMigratedInMemoryDialect(): Promise<Dialect> {
  const sharedDb = createBunSqliteDatabase(':memory:');
  const dialect = new SqliteDialect({ database: async (): Promise<typeof sharedDb> => sharedDb });

  const db = new Kysely<Record<string, unknown>>({ dialect });
  await runServerMigrations(db, dialect);

  return dialect;
}

/**
 * Creates a file-based SQLite dialect with server migrations already applied.
 *
 * Unlike in-memory SQLite, file-based SQLite naturally shares state across
 * connections to the same file, so a plain `getDialectFromUrl` works fine.
 *
 * @param sqliteUrl - A `sqlite://<dir>/<file>.db` URL string.
 * @returns A Dialect that can be passed directly to store `.create()` methods.
 */
export async function createMigratedFileDialect(sqliteUrl: string): Promise<Dialect> {
  const dialect = getDialectFromUrl(new URL(sqliteUrl));
  const db = new Kysely<Record<string, unknown>>({ dialect });
  await runServerMigrations(db, dialect);

  return dialect;
}
