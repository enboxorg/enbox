import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';

import { Message } from '@enbox/dwn-sdk-js';
import { createHttpDwnRpcRequestBody, HTTP_DWN_RPC_MEDIA_TYPE } from './http-dwn-rpc-framing.js';

/**
 * HTTP request headers that project routing and observability fields of an
 * HTTP DWN RPC request, so load balancers, CDNs, and edge workers can route,
 * rate limit, and log requests without parsing the framed body.
 *
 * Each header is derived from the JSON-RPC envelope in the body. The envelope
 * stays authoritative: a server recomputes every header from the envelope and
 * rejects a request whose headers differ.
 */
export enum HttpDwnRpcRequestHeader {
  /** The DWN author of the message: its signer, or the grantor when an app delegate signed it. */
  Author = 'dwn-author',
  /** The byte length of the record data that follows the envelope. */
  DataSize = 'dwn-data-size',
  /** The app delegate DID that signed the message under a delegated grant. */
  Delegate = 'dwn-delegate',
  /** The DWN interface and method of the message, e.g. `RecordsWrite`. */
  Message = 'dwn-message',
  /** The CID of the DWN message. */
  MessageCid = 'dwn-message-cid',
  /** The module URI the message is scoped to. */
  Module = 'dwn-module',
  /** The JSON-RPC method, e.g. `dwn.processMessage`. */
  RpcMethod = 'dwn-rpc-method',
  /** The tenant DID the request targets. */
  Tenant = 'dwn-tenant',
}

/** HTTP response headers that project fields of an HTTP DWN RPC response. */
export enum HttpDwnRpcResponseHeader {
  /** The status code of the DWN reply. */
  Status = 'dwn-status',
}

/** The body and headers of an HTTP DWN RPC request. */
export type HttpDwnRpcRequest = {
  body: BodyInit;
  headers: Record<string, string>;
};

/**
 * A projected header value must be visible ASCII without spaces, and short
 * enough that the full header set stays far below proxy header limits.
 * A value outside these bounds is omitted rather than sent.
 */
const MAX_HEADER_VALUE_BYTES = 1_024;
const HEADER_VALUE_PATTERN = /^[\x21-\x7e]+$/;

type JsonObject = Record<string, unknown>;

/**
 * Creates the framed body and the headers of an HTTP DWN RPC request:
 * `content-type` plus the {@link HttpDwnRpcRequestHeader} projections of the envelope.
 */
export async function createHttpDwnRpcRequest(
  jsonRpcRequest: JsonRpcRequest,
  data?: BodyInit,
): Promise<HttpDwnRpcRequest> {
  const projectedHeaders = await createHttpDwnRpcRequestHeaders(jsonRpcRequest, data !== undefined);

  return {
    body    : createHttpDwnRpcRequestBody(jsonRpcRequest, data),
    headers : { 'content-type': HTTP_DWN_RPC_MEDIA_TYPE, ...projectedHeaders },
  };
}

/**
 * Computes the {@link HttpDwnRpcRequestHeader} projections of a JSON-RPC request.
 * The projection reads the request's JSON form, which is exactly what a server
 * parses from the framed body.
 *
 * @param dataFollows Whether record data follows the envelope in the body.
 */
export async function createHttpDwnRpcRequestHeaders(
  jsonRpcRequest: JsonRpcRequest,
  dataFollows: boolean,
): Promise<Record<string, string>> {
  return projectRequestHeaders(JSON.parse(JSON.stringify(jsonRpcRequest)), dataFollows);
}

/**
 * Verifies that the {@link HttpDwnRpcRequestHeader} headers of an HTTP DWN RPC
 * request are exactly the projections of its parsed JSON-RPC envelope: every
 * projected header is present with the projected value, and no other is present.
 *
 * @param jsonRpcRequest The JSON-RPC envelope as parsed from the framed body.
 * @param dataFollows Whether the framed body carries record data after the envelope.
 * @throws Error naming the first header that is missing, unexpected, or different.
 */
export async function validateHttpDwnRpcRequestHeaders(
  headers: Headers,
  jsonRpcRequest: unknown,
  dataFollows: boolean,
): Promise<void> {
  const expectedHeaders = await projectRequestHeaders(jsonRpcRequest, dataFollows);

  for (const name of Object.values(HttpDwnRpcRequestHeader)) {
    const actual = headers.get(name) ?? undefined;
    const expected = expectedHeaders[name];
    if (actual === expected) {
      continue;
    }

    if (expected === undefined) {
      throw new Error(`HTTP DWN RPC request has an unexpected '${name}' header`);
    }
    if (actual === undefined) {
      throw new Error(`HTTP DWN RPC request is missing the '${name}' header`);
    }
    throw new Error(`HTTP DWN RPC request '${name}' header does not match the JSON-RPC envelope`);
  }
}

/**
 * Computes the {@link HttpDwnRpcResponseHeader} projections of a JSON-RPC response.
 * Only a successful response that carries a DWN reply has a status to project.
 */
export function createHttpDwnRpcResponseHeaders(jsonRpcResponse: JsonRpcResponse): Record<string, string> {
  const statusCode = jsonRpcResponse.result?.reply?.status?.code;
  return Number.isSafeInteger(statusCode)
    ? { [HttpDwnRpcResponseHeader.Status]: String(statusCode) }
    : {};
}

async function projectRequestHeaders(jsonRpcRequest: unknown, dataFollows: boolean): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (!isJsonObject(jsonRpcRequest)) {
    return headers;
  }

  setHeader(headers, HttpDwnRpcRequestHeader.RpcMethod, jsonRpcRequest.method);

  const params = jsonRpcRequest.params;
  if (!isJsonObject(params)) {
    return headers;
  }

  setHeader(headers, HttpDwnRpcRequestHeader.Tenant, params.target);

  const message = params.message;
  if (!isJsonObject(message)) {
    return headers;
  }

  const descriptor = isJsonObject(message.descriptor) ? message.descriptor : {};
  if (typeof descriptor.interface === 'string' && typeof descriptor.method === 'string') {
    setHeader(headers, HttpDwnRpcRequestHeader.Message, `${descriptor.interface}${descriptor.method}`);
  }
  setHeader(headers, HttpDwnRpcRequestHeader.Module, getMessageModule(descriptor));

  const dataSize = descriptor.dataSize;
  if (dataFollows && typeof dataSize === 'number' && Number.isSafeInteger(dataSize) && dataSize >= 0) {
    setHeader(headers, HttpDwnRpcRequestHeader.DataSize, String(dataSize));
  }

  const genericMessage = message as GenericMessage;
  setHeader(headers, HttpDwnRpcRequestHeader.MessageCid, await getMessageCid(genericMessage));
  setHeader(headers, HttpDwnRpcRequestHeader.Author, getMessageDid((): string | undefined => Message.getAuthor(genericMessage)));
  if (isJsonObject(message.authorization) && message.authorization.authorDelegatedGrant !== undefined) {
    setHeader(headers, HttpDwnRpcRequestHeader.Delegate, getMessageDid((): string | undefined => Message.getSigner(genericMessage)));
  }

  return headers;
}

/**
 * Returns the one module URI a message is scoped to: a write's module, a
 * configured definition's module, or the module of a query-style filter.
 * A `filters` list projects a module only when every filter names the same one.
 */
function getMessageModule(descriptor: JsonObject): unknown {
  if (descriptor.module !== undefined) {
    return descriptor.module;
  }
  if (isJsonObject(descriptor.definition)) {
    return descriptor.definition.module;
  }
  if (isJsonObject(descriptor.filter)) {
    return descriptor.filter.module;
  }
  if (Array.isArray(descriptor.filters) && descriptor.filters.length > 0) {
    const modules = new Set(descriptor.filters.map((filter: unknown): unknown => isJsonObject(filter) ? filter.module : undefined));
    return modules.size === 1 ? modules.values().next().value : undefined;
  }

  return undefined;
}

async function getMessageCid(message: GenericMessage): Promise<string | undefined> {
  try {
    return await Message.getCid(message);
  } catch {
    // A message that cannot be encoded has no CID to project; the DWN rejects it later.
    return undefined;
  }
}

function getMessageDid(getDid: () => string | undefined): string | undefined {
  try {
    return getDid();
  } catch {
    // A malformed signature has no signer to project; the DWN rejects it later.
    return undefined;
  }
}

function setHeader(headers: Record<string, string>, name: HttpDwnRpcRequestHeader, value: unknown): void {
  if (typeof value === 'string' && value.length <= MAX_HEADER_VALUE_BYTES && HEADER_VALUE_PATTERN.test(value)) {
    headers[name] = value;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
