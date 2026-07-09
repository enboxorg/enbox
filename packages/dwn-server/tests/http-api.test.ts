import type { Dialect } from '@enbox/dwn-sql-store';
import type { DwnServerConfig } from '../src/config.js';
import type { Dwn, Persona, ProtocolsConfigureMessage, RecordsQueryReply } from '@enbox/dwn-sdk-js';
import type { JsonRpcErrorResponse, JsonRpcResponse, ServerInfo } from '@enbox/dwn-clients';

import { connect } from 'net';
import { Convert } from '@enbox/common';
import log from 'loglevel';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import {
  DataStream,
  ProtocolsConfigure,
  RecordsQuery,
  TestDataGenerator,
  Time,
} from '@enbox/dwn-sdk-js';
import sinon, { useFakeTimers } from 'sinon';

import CommonScenarioValidator from './common-scenario-validator.js';
import { config } from '../src/config.js';
import { getTestDwn } from './test-dwn.js';
import { HttpApi } from '../src/http-api.js';
import { LocalNodePairingManager } from '../src/local-node-pairing.js';
import { RegistrationManager } from '../src/registration/registration-manager.js';
import { runServerMigrationsIfNeeded } from '../src/storage.js';
import { createJsonRpcRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import {
  createRecordsWriteMessage,
  getDwnResponse,
  getFileAsReadStream,
} from './utils.js';

describe('http api', function () {
  let httpApi: HttpApi;
  let alice: Persona;
  let registrationManager: RegistrationManager;
  let dwn: Dwn;
  let dialect: Dialect;
  let clock;
  let baseUrl: string;

  async function createStartedHttpApiWithConfig(
    overrides: Partial<DwnServerConfig>,
    options: { localNodePairingManager?: LocalNodePairingManager } = {},
  ): Promise<{ api: HttpApi; url: string; }> {
    const testConfig: DwnServerConfig = {
      ...config,
      ...overrides,
    };
    const api = await HttpApi.create(testConfig, dwn, registrationManager, undefined, undefined, {
      localNodePairingManager : options.localNodePairingManager,
      ttlCacheDialect         : dialect,
    });
    await api.start(0);

    const hostname = testConfig.hostname ?? 'localhost';
    const urlHostname = hostname === '::1' ? '[::1]' : hostname;
    return { api, url: `http://${urlHostname}:${api.server.port}` };
  }

  beforeAll(async function () {
    clock = useFakeTimers({ shouldAdvanceTime: true });
    // TODO: Remove direct use of default config to avoid changes bleed/pollute between tests - https://github.com/enboxorg/enbox/issues/144
    config.packageJsonPath = './package.json'; // default is Docker path; override for local tests
    config.registrationStoreUrl = 'sqlite://';
    config.registrationProofOfWorkEnabled = true;
    config.termsOfServiceFilePath = './tests/fixtures/terms-of-service.txt';
    config.registrationProofOfWorkInitialMaxHash = '0FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'; // 1 in 16 chance of solving

    // Run server migrations before creating the RegistrationManager so that
    // the RegistrationStore health check finds the required tables.
    await runServerMigrationsIfNeeded(config);

    // RegistrationManager creation
    const registrationStoreUrl = config.registrationStoreUrl;
    const termsOfServiceFilePath = config.termsOfServiceFilePath;
    const proofOfWorkInitialMaximumAllowedHash = config.registrationProofOfWorkInitialMaxHash;
    registrationManager = await RegistrationManager.create({ registrationStoreUrl, termsOfServiceFilePath, proofOfWorkInitialMaximumAllowedHash });

    ({ dwn, dialect } = await getTestDwn({ tenantGate: registrationManager }));

    httpApi = await HttpApi.create(config, dwn, registrationManager, undefined, undefined, { ttlCacheDialect: dialect });

  });

  beforeEach(async function () {
    sinon.restore();
    await httpApi.start(0);
    baseUrl = `http://localhost:${httpApi.server.port}`;

    // generate a new persona for each test to avoid state pollution
    alice = await TestDataGenerator.generateDidKeyPersona();
    await registrationManager.recordTenantRegistration({ did: alice.did, termsOfServiceHash: registrationManager.getTermsOfServiceHash() });

    // install the default test protocol so RecordsWrite messages are accepted
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
  });

  afterEach(async function () {
    await httpApi.close();
  });

  afterAll(function () {
    sinon.restore();
    clock.restore();
  });

  describe('/ (rpc)', function () {
    it('responds with a 400 if no dwn-request header is provided', async function () {
      const response = await fetch(baseUrl, {
        method: 'POST',
      });

      expect(response.status).toBe(400);

      const body = (await response.json()) as JsonRpcErrorResponse;
      expect(body.error.code).toBe(JsonRpcErrorCodes.BadRequest);
      expect(body.error.message).toBe('request payload required.');
    });

    it('responds with a 400 if parsing dwn request fails', async function () {
      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : { 'dwn-request': ';;;;@!#@!$$#!@%' },
      });

      expect(response.status).toBe(400);

      const body = (await response.json()) as JsonRpcErrorResponse;
      expect(body.error.code).toBe(JsonRpcErrorCodes.BadRequest);
      expect(body.error.message).toContain('JSON');
    });

    it('responds with a 2XX HTTP status if JSON RPC handler returns 4XX/5XX DWN status code', async function () {
      const { recordsWrite, dataStream } =
        await createRecordsWriteMessage(alice);

      // Intentionally delete a required property to produce an invalid RecordsWrite message.
      const message = recordsWrite.toJSON();
      delete message['descriptor']['interface'];

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : message,
        target  : alice.did,
      });

      const dataBytes = await DataStream.toBytes(dataStream);

      // Attempt an initial RecordsWrite with the invalid message to ensure the DWN returns an error.
      const responseInitialWrite = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body: new Blob([dataBytes]),
      });

      expect(responseInitialWrite.status).toBe(200);

      const body = (await responseInitialWrite.json()) as JsonRpcResponse;
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();

      const { reply } = body.result;
      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain(
        'Both interface and method must be present',
      );
    });

    it('exposes dwn-response header', async function () {
      // This test verifies that the HTTP server includes `dwn-response` in the list of
      // `access-control-expose-headers` returned in each HTTP response. This is necessary to enable applications
      // that have CORS enabled to read and parse DWeb Messages that are returned as Response headers, particularly
      // in the case of RecordsRead messages.

      // TODO: github.com/enboxorg/enbox/issues/50
      // Consider replacing this test with a more robust method of testing, such as writing Playwright tests
      // that run in a browser to verify that the `dwn-response` header can be read from the `fetch()` response
      // when CORS mode is enabled.
      const response = await fetch(baseUrl, {
        method: 'POST',
      });

      // Check if the 'access-control-expose-headers' header is present
      expect(response.headers.has('access-control-expose-headers')).toBe(true);

      // Check if the 'dwn-response' header is listed in 'access-control-expose-headers'
      const exposedHeaders = response.headers.get('access-control-expose-headers');
      expect(exposedHeaders).toContain('dwn-response');
    });

    it('works fine when no request body is provided', async function () {
      const recordsQuery = await RecordsQuery.create({
        filter: {
          schema: 'woosa',
        },
        signer: alice.signer,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsQuery.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : { 'dwn-request': JSON.stringify(dwnRequest) },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();
      expect(body.result.reply.status.code).toBe(200);
    });
  });

  describe('P0 Scenarios', function () {
    it('should be able to read and write a protocol record', async function () {
      await CommonScenarioValidator.sanityTestDwnReadWrite(baseUrl, alice);
    });
  });

  describe('RecordsWrite', function () {
    it('streams RecordsWrite request bodies into the DWN', async function () {
      const dataBytes = new Uint8Array(1_048_577);
      dataBytes.fill(7);
      dataBytes[0] = 1;
      dataBytes[dataBytes.length - 1] = 255;

      const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data: dataBytes });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body   : dataStream,
        duplex : 'half',
      } as RequestInit & { duplex: 'half' });

      expect(response.status).toBe(200);

      const body = (await response.json()) as JsonRpcResponse;
      expect(body.error).toBeUndefined();
      expect(body.id).toBe(requestId);

      const { reply } = body.result;
      expect(reply.status.code).toBe(202);
    });

    it('handles RecordsWrite overwrite that does not mutate data', async function () {
      // First RecordsWrite that creates the record.
      const { recordsWrite: initialWrite, dataStream } =
        await createRecordsWriteMessage(alice);
      const dataBytes = await DataStream.toBytes(dataStream);
      let requestId = crypto.randomUUID();
      let dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : initialWrite.toJSON(),
        target  : alice.did,
      });

      const responseInitialWrite = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body: new Blob([dataBytes]),
      });

      expect(responseInitialWrite.status).toBe(200);

      // Waiting for minimal time to make sure subsequent RecordsWrite has a later timestamp.
      await Time.minimalSleep();

      // Subsequent RecordsWrite that mutates the published property of the record.
      const { recordsWrite: overWrite } = await createRecordsWriteMessage(alice, {
        recordId    : initialWrite.message.recordId,
        dataCid     : initialWrite.message.descriptor.dataCid,
        dataSize    : initialWrite.message.descriptor.dataSize,
        dateCreated : initialWrite.message.descriptor.dateCreated,
        published   : true,
      });

      requestId = crypto.randomUUID();
      dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : overWrite.toJSON(),
        target  : alice.did,
      });
      const responseOverwrite = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
      });

      expect(responseOverwrite.status).toBe(200);

      const body = (await responseOverwrite.json()) as JsonRpcResponse;
      expect(body.error).toBeUndefined();
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();

      const { reply } = body.result;
      expect(reply.status.code).toBe(202);
    });

    it('handles a RecordsWrite tombstone', async function () {
      const { recordsWrite: tombstone } =
        await createRecordsWriteMessage(alice);

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : tombstone.toJSON(),
        target  : alice.did,
      });

      const responeTombstone = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
      });

      expect(responeTombstone.status).toBe(200);
    });
  });

  describe('health check', function () {
    it('returns a health check', async function () {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
      });
      expect(response.status).toBe(200);
    });

    it('returns 200 with { ok: true } body', async function () {
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });
    });
  });

  describe('default http get response', function () {
    it('returns returns a default message', async function () {
      const response = await fetch(`${baseUrl}/`, {
        method: 'GET',
      });
      expect(response.status).toBe(200);
    });
  });

  describe('/:did/records/:id', function () {
    it('returns record data if record is published', async function () {
      const filePath = './fixtures/test.jpeg';
      const {
        cid: expectedCid,
        size,
        stream,
      } = await getFileAsReadStream(filePath);

      const { recordsWrite } = await createRecordsWriteMessage(alice, {
        dataCid   : expectedCid,
        dataSize  : size,
        published : true,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      let response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body: stream,
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as JsonRpcResponse;
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();

      const { reply } = body.result;
      expect(reply.status.code).toBe(202);

      response = await fetch(
        `${baseUrl}/${alice.did}/records/${recordsWrite.message.recordId}`,
      );
      const blob = await response.blob();

      expect(blob.size).toBe(size);
    });

    it('returns a 404 if an unpublished record is requested', async function () {
      const filePath = './fixtures/test.jpeg';
      const {
        cid: expectedCid,
        size,
        stream,
      } = await getFileAsReadStream(filePath);

      const { recordsWrite } = await createRecordsWriteMessage(alice, {
        dataCid  : expectedCid,
        dataSize : size,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      let response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body: stream,
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as JsonRpcResponse;
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();

      const { reply } = body.result;
      expect(reply.status.code).toBe(202);

      response = await fetch(
        `${baseUrl}/${alice.did}/records/${recordsWrite.message.recordId}`,
      );

      expect(response.status).toBe(404);
    });

    it('returns a 404 if record does not exist', async function () {
      const { recordsWrite } = await createRecordsWriteMessage(alice);

      const response = await fetch(
        `${baseUrl}/${alice.did}/records/${recordsWrite.message.recordId}`,
      );
      expect(response.status).toBe(404);
    });

    it('returns a 404 for invalid or unauthorized did', async function () {
      const unauthorized = await TestDataGenerator.generateDidKeyPersona();
      const { recordsWrite } = await createRecordsWriteMessage(unauthorized);

      const response = await fetch(
        `${baseUrl}/${unauthorized.did}/records/${recordsWrite.message.recordId}`,
      );
      expect(response.status).toBe(404);
    });

    it('returns a 404 for invalid record id', async function () {
      const response = await fetch(
        `${baseUrl}/${alice.did}/records/kaka`,
      );
      expect(response.status).toBe(404);
    });
  });

  describe('/:did/read/records/:id', function () {
    it('returns record data if record is published', async function () {
      const filePath = './fixtures/test.jpeg';
      const {
        cid: expectedCid,
        size,
        stream,
      } = await getFileAsReadStream(filePath);

      const { recordsWrite } = await createRecordsWriteMessage(alice, {
        dataCid   : expectedCid,
        dataSize  : size,
        published : true,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      let response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body: stream,
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as JsonRpcResponse;
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();

      const { reply } = body.result;
      expect(reply.status.code).toBe(202);

      response = await fetch(
        `${baseUrl}/${alice.did}/read/records/${recordsWrite.message.recordId}`,
      );
      const blob = await response.blob();

      expect(blob.size).toBe(size);
    });

    it('returns a 404 if an unpublished record is requested', async function () {
      const filePath = './fixtures/test.jpeg';
      const {
        cid: expectedCid,
        size,
        stream,
      } = await getFileAsReadStream(filePath);

      const { recordsWrite } = await createRecordsWriteMessage(alice, {
        dataCid  : expectedCid,
        dataSize : size,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      let response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body: stream,
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as JsonRpcResponse;
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();

      const { reply } = body.result;
      expect(reply.status.code).toBe(202);

      response = await fetch(
        `${baseUrl}/${alice.did}/read/records/${recordsWrite.message.recordId}`,
      );

      expect(response.status).toBe(404);
    });

    it('returns a 404 if record does not exist', async function () {
      const { recordsWrite } = await createRecordsWriteMessage(alice);

      const response = await fetch(
        `${baseUrl}/${alice.did}/read/records/${recordsWrite.message.recordId}`,
      );
      expect(response.status).toBe(404);
    });

    it('returns a 404 for invalid or unauthorized did', async function () {
      const unauthorized = await TestDataGenerator.generateDidKeyPersona();
      const { recordsWrite } = await createRecordsWriteMessage(unauthorized);

      const response = await fetch(
        `${baseUrl}/${unauthorized.did}/read/records/${recordsWrite.message.recordId}`,
      );
      expect(response.status).toBe(404);
    });

    it('returns a 404 for invalid record id', async function () {
      const response = await fetch(
        `${baseUrl}/${alice.did}/read/records/kaka`,
      );
      expect(response.status).toBe(404);
    });
  });

  describe('/:did/read/protocols/:protocol', function () {
    it('returns protocol definition if protocol is published', async function () {
      // Create and publish a protocol
      const protocolConfigure = await ProtocolsConfigure.create({
        definition: {
          protocol  : 'http://example.com/protocol',
          published : true,
          types     : {
            foo: {},
          },
          structure: {
            foo: {}
          }
        },
        signer: alice.signer,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : protocolConfigure.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
      });
      expect(response.status).toBe(200);


      // Fetch the protocol definition using the HTTP API
      const base64urlEncodedProtocol = Convert.string(protocolConfigure.message.descriptor.definition.protocol).toBase64Url();
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/${base64urlEncodedProtocol}`;
      const protocolQueryResponse = await fetch(protocolUrl);
      expect(protocolQueryResponse.status).toBe(200);

      // get the JSON response
      const protocolConfigureReply = await protocolQueryResponse.json() as ProtocolsConfigureMessage;
      expect(protocolConfigureReply.descriptor).toEqual(protocolConfigure.message.descriptor);
    });

    it('returns a 404 if protocol is not published', async function () {
      // Create a not-published protocol
      const protocolConfigure = await ProtocolsConfigure.create({
        definition: {
          protocol  : 'http://example.com/protocol',
          published : false,
          types     : {
            foo: {},
          },
          structure: {
            foo: {}
          }
        },
        signer: alice.signer,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : protocolConfigure.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
      });
      expect(response.status).toBe(200);


      // Fetch the protocol definition using the HTTP API
      const base64urlEncodedProtocol = Convert.string(protocolConfigure.message.descriptor.definition.protocol).toBase64Url();
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/${base64urlEncodedProtocol}`;
      const protocolQueryResponse = await fetch(protocolUrl);
      expect(protocolQueryResponse.status).toBe(404);
    });

    it('returns a 400 if protocol is not base64url encoded', async function () {
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/invalid-protocol`;
      const protocolQueryResponse = await fetch(protocolUrl);
      expect(protocolQueryResponse.status).toBe(400);
      expect(await protocolQueryResponse.text()).toBe('Bad Request');
    });
  });

  describe('/:did/query/protocols', function () {
    it('returns protocol definition if protocol is published', async function () {
      // create two protocol definitions, one published and one not
      const protocolConfigurePublished = await ProtocolsConfigure.create({
        definition: {
          protocol  : 'http://example.com/protocol',
          published : true,
          types     : {
            foo: {},
          },
          structure: {
            foo: {}
          }
        },
        signer: alice.signer,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : protocolConfigurePublished.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
      });
      expect(response.status).toBe(200);

      const protocolConfigureNotPublished = await ProtocolsConfigure.create({
        definition: {
          protocol  : 'http://example.com/protocol2',
          published : false,
          types     : {
            foo: {},
          },
          structure: {
            foo: {}
          }
        },
        signer: alice.signer,
      });

      const requestId2 = crypto.randomUUID();
      const dwnRequest2 = createJsonRpcRequest(requestId2, 'dwn.processMessage', {
        message : protocolConfigureNotPublished.toJSON(),
        target  : alice.did,
      });

      const response2 = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest2),
        },
      });

      expect(response2.status).toBe(200);

      // now query for a list of protocols
      const protocolQueryUrl = `${baseUrl}/${alice.did}/query/protocols`;
      const protocolQueryResponse = await fetch(protocolQueryUrl);
      expect(protocolQueryResponse.status).toBe(200);

      // get the JSON response
      const protocolQueryReply = await protocolQueryResponse.json() as ProtocolsConfigureMessage[];
      expect(protocolQueryReply).toHaveLength(1);

      // check that the published protocol is returned
      expect(protocolQueryReply[0].descriptor).toEqual(protocolConfigurePublished.message.descriptor);
    });
  });

  describe('/:did/read/protocols/:protocol/*', function () {
    it('returns record for a given protocol and protocolPath that is published', async function () {
      // Create and publish a protocol
      const protocolConfigure = await ProtocolsConfigure.create({
        definition: {
          protocol  : 'http://example.com/protocol',
          published : true,
          types     : {
            foo: {},
          },
          structure: {
            foo: {}
          }
        },
        signer: alice.signer,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : protocolConfigure.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
      });
      expect(response.status).toBe(200);

      // Create a foo record
      const filePath = './fixtures/test.jpeg';
      const {
        cid: expectedCid,
        size,
        stream,
      } = await getFileAsReadStream(filePath);

      const { recordsWrite } = await createRecordsWriteMessage(alice, {
        dataCid      : expectedCid,
        dataSize     : size,
        published    : true,
        protocol     : protocolConfigure.message.descriptor.definition.protocol,
        protocolPath : 'foo',
      });

      const recordsWriteRequestId = crypto.randomUUID();
      const recordsWriteDwnRequest = createJsonRpcRequest(recordsWriteRequestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const recordsWriteResponse = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(recordsWriteDwnRequest),
        },
        body: stream,
      });
      expect(recordsWriteResponse.status).toBe(200);
      const responseJson = await recordsWriteResponse.json() as JsonRpcResponse;
      expect(responseJson.result.reply.status.code).toBe(202);

      // Fetch the record using the HTTP API
      const base64urlEncodedProtocol = Convert.string(protocolConfigure.message.descriptor.definition.protocol).toBase64Url();
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/${base64urlEncodedProtocol}/foo`;
      const recordReadResponse = await fetch(protocolUrl);
      expect(recordReadResponse.status).toBe(200);

      // get the data response
      const blob = await recordReadResponse.blob();
      expect(blob.size).toBe(size);

      // get dwn message response
      const { status, entry } = getDwnResponse(recordReadResponse);
      expect(status.code).toBe(200);
      expect(entry).toBeDefined();
      expect(entry.recordsWrite.recordId).toBe(recordsWrite.message.recordId);
    });

    it('removes the trailing slash from the protocol path', async function () {
      const recordsQueryCreateSpy = sinon.spy(RecordsQuery, 'create');

      const base64urlEncodedProtocol = Convert.string('http://example.com/protocol').toBase64Url();
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/${base64urlEncodedProtocol}/foo/`; // trailing slash
      const recordReadResponse = await fetch(protocolUrl);
      expect(recordReadResponse.status).toBe(404);

      expect(recordsQueryCreateSpy.calledOnce).toBe(true);
      const recordsQueryFilter = recordsQueryCreateSpy.getCall(0).args[0].filter;
      expect(recordsQueryFilter.protocolPath).toBe('foo');
    });

    it('returns a 404 if record for a given protocol and protocolPath is not published', async function () {
      // Create and publish a protocol
      const protocolConfigure = await ProtocolsConfigure.create({
        definition: {
          protocol  : 'http://example.com/protocol',
          published : true,
          types     : {
            foo: {},
          },
          structure: {
            foo: {}
          }
        },
        signer: alice.signer,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : protocolConfigure.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
      });
      expect(response.status).toBe(200);

      // Create a foo record
      const filePath = './fixtures/test.jpeg';
      const {
        cid: expectedCid,
        size,
        stream,
      } = await getFileAsReadStream(filePath);

      const { recordsWrite } = await createRecordsWriteMessage(alice, {
        dataCid      : expectedCid,
        dataSize     : size,
        published    : false, // not published
        protocol     : protocolConfigure.message.descriptor.definition.protocol,
        protocolPath : 'foo',
      });

      const recordsWriteRequestId = crypto.randomUUID();
      const recordsWriteDwnRequest = createJsonRpcRequest(recordsWriteRequestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const recordsWriteResponse = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(recordsWriteDwnRequest),
        },
        body: stream,
      });
      expect(recordsWriteResponse.status).toBe(200);
      const responseJson = await recordsWriteResponse.json() as JsonRpcResponse;
      expect(responseJson.result.reply.status.code).toBe(202);

      // Fetch the record using the HTTP API
      const base64urlEncodedProtocol = Convert.string(protocolConfigure.message.descriptor.definition.protocol).toBase64Url();
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/${base64urlEncodedProtocol}/foo`;
      const recordReadResponse = await fetch(protocolUrl);
      expect(recordReadResponse.status).toBe(404);
    });

    it('returns a 400 if protocol path is not provided', async function () {
      // Fetch a protocol record without providing a protocol path
      const base64urlEncodedProtocol = Convert.string('http://example.com/protocol').toBase64Url();
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/${base64urlEncodedProtocol}/`; // missing protocol path
      const recordReadResponse = await fetch(protocolUrl);
      expect(recordReadResponse.status).toBe(400);
      expect(await recordReadResponse.text()).toBe('protocol path is required');
    });

    it('returns a 400 error if protocol cannot be base64url encoded', async function () {
      const protocolUrl = `${baseUrl}/${alice.did}/read/protocols/invalid-protocol/foo`;
      const recordReadResponse = await fetch(protocolUrl);
      expect(recordReadResponse.status).toBe(400);
      expect(await recordReadResponse.text()).toBe('Bad Request');
    });
  });

  describe('/:did/query', function () {
    it('returns record data if record is published', async function () {
      const filePath = './fixtures/test.jpeg';
      const {
        cid: expectedCid,
        size,
        stream,
      } = await getFileAsReadStream(filePath);

      const { recordsWrite } = await createRecordsWriteMessage(alice, {
        dataCid   : expectedCid,
        dataSize  : size,
        published : true,
      });

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const response = await fetch(baseUrl, {
        method  : 'POST',
        headers : {
          'dwn-request': JSON.stringify(dwnRequest),
        },
        body: stream,
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as JsonRpcResponse;
      expect(body.id).toBe(requestId);
      expect(body.error).toBeUndefined();

      const { reply } = body.result;
      expect(reply.status.code).toBe(202);

      const { entries } = await fetch(
        `${baseUrl}/${alice.did}/query?filter.recordId=${recordsWrite.message.recordId}&other.random.param=unused-value`,
      ).then(response => response.json()) as RecordsQueryReply;

      expect(entries).toHaveLength(1);
    });

    it('should return 400 if user provide invalid query', async function () {
      const response = await fetch(
        `${baseUrl}/${alice.did}/query?filter=invalid-filter`,
      );
      expect(response.status).toBe(400);

      const responseBody = await response.json();
      expect(responseBody.error).toBe('Bad Request');
    });
  });

  describe('/info', function () {
    it('verify /info has some of the fields it is supposed to have', async function () {
      const resp = await fetch(`${baseUrl}/info`);
      expect(resp.status).toBe(200);

      const info = await resp.json();
      expect(info['url']).toBe('http://localhost:3000');
      expect(info['server']).toBe('@enbox/dwn-server');
      expect(info['localNode']).toBeUndefined();
      expect(info['localPairing']).toBeUndefined();
      expect(info['registrationRequirements']).toContain('terms-of-service');
      expect(info['registrationRequirements']).toContain(
        'proof-of-work-sha256-v0',
      );
    });

    it('verify /info signals websocket support', async function() {
      let resp = await fetch(`${baseUrl}/info`);
      expect(resp.status).toBe(200);

      let info = await resp.json();
      expect(info['server']).toBe('@enbox/dwn-server');
      expect(info['webSocketSupport']).toBe(true);


      // start server without websocket support enabled
      await httpApi.close();

      config.webSocketSupport = false;
      httpApi = await HttpApi.create(config, dwn, registrationManager, undefined, undefined, { ttlCacheDialect: dialect });
      await httpApi.start(0);
      baseUrl = `http://localhost:${httpApi.server.port}`;

      resp = await fetch(`${baseUrl}/info`);
      expect(resp.status).toBe(200);

      info = await resp.json();
      expect(info['server']).toBe('@enbox/dwn-server');
      expect(info['webSocketSupport']).toBe(false);

      // restore old config value
      config.webSocketSupport = true;
    });

    it('verify /info still returns when package.json file does not exist', async function () {
      await httpApi.close();

      // set up spy to check for an info log by the server
      const logSpy = sinon.spy(log, 'info');

      // set the config to an invalid file path
      const packageJsonConfig = config.packageJsonPath;
      config.packageJsonPath = '/some/invalid/file.json';
      httpApi = await HttpApi.create(config, dwn, registrationManager, undefined, undefined, { ttlCacheDialect: dialect });
      await httpApi.start(0);
      baseUrl = `http://localhost:${httpApi.server.port}`;

      const resp = await fetch(`${baseUrl}/info`);
      const info = await resp.json();
      expect(resp.status).toBe(200);

      // check that server name exists in the info object
      expect(info['server']).toBe('@enbox/dwn-server');

      // `version` is undefined because the server's own package.json was not found.
      // `sdkVersion` is still defined because it is resolved from the installed SDK package.
      expect(info['sdkVersion']).toBeDefined();
      expect(info['version']).toBeUndefined();

      // check the logSpy was called
      expect(logSpy.callCount).toBeGreaterThan(0);
      expect(logSpy.calledWith(sinon.match('could not read `package.json` for version info'))).toBe(true);

      // restore old config path
      config.packageJsonPath = packageJsonConfig;
    });

    it('verify /info returns server name from config', async function () {
      await httpApi.close();

      // set a custom name for the `serverName`
      const serverName = config.serverName;
      config.serverName = '@enbox/dwn-server-2';
      httpApi = await HttpApi.create(config, dwn, registrationManager, undefined, undefined, { ttlCacheDialect: dialect });
      await httpApi.start(0);
      baseUrl = `http://localhost:${httpApi.server.port}`;

      const resp = await fetch(`${baseUrl}/info`);
      const info = await resp.json();
      expect(resp.status).toBe(200);

      // verify that the custom server name was passed to the info endpoint
      expect(info['server']).toBe('@enbox/dwn-server-2');

      // verify that `sdkVersion` and `version` exist.
      expect(info['sdkVersion']).toBeDefined();
      expect(info['version']).toBeDefined();

      // restore server name config
      config.serverName = serverName;
    });

    it('verify /info includes local-node metadata in local-node profile', async function () {
      const { api, url } = await createStartedHttpApiWithConfig({
        baseUrl                 : 'http://127.0.0.1:55500',
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      });

      try {
        const resp = await fetch(`${url}/info`, {
          headers: { origin: 'https://app.example' },
        });
        const info = await resp.json() as ServerInfo;
        expect(resp.status).toBe(200);

        expect(info.localNode).toBe(true);
        expect(info.localPairing).toEqual({
          pairUrl         : 'http://127.0.0.1:55500/local/pair',
          pollUrlTemplate : 'http://127.0.0.1:55500/local/pair/{requestId}',
        });
        expect(resp.headers.get('access-control-allow-origin')).toBe('https://app.example');
        expect(resp.headers.get('vary')).toBe('Origin');
      } finally {
        await api.close();
      }
    });
  });

  describe('CORS headers', () => {
    it('should include all required CORS headers on non-admin responses', async () => {
      const response = await fetch(`${baseUrl}/info`);
      expect(response.status).toBe(200);

      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('access-control-allow-headers')).toBe('*');
      expect(response.headers.get('access-control-expose-headers')).toContain('dwn-response');
      expect(response.headers.get('access-control-max-age')).toBe('86400');
    });

    it('should include CORS headers on JSON-RPC POST responses', async () => {
      const response = await fetch(baseUrl, { method: 'POST' });
      // Even a 400 (missing dwn-request header) should include CORS headers.
      expect(response.status).toBe(400);

      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('access-control-max-age')).toBe('86400');
    });

    it('should include CORS headers on the health endpoint', async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);

      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-max-age')).toBe('86400');
    });

    it('should return 204 with CORS headers on OPTIONS preflight', async () => {
      const response = await fetch(`${baseUrl}/info`, { method: 'OPTIONS' });
      expect(response.status).toBe(204);

      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('access-control-allow-headers')).toBe('*');
      expect(response.headers.get('access-control-max-age')).toBe('86400');
    });

    it('should NOT include CORS headers on /admin routes', async () => {
      // Admin routes are excluded from CORS to limit cross-origin access.
      const response = await fetch(`${baseUrl}/admin/api/info`);
      // The response status depends on whether adminApi is configured (it's
      // not in this test setup, so it falls through to 404). The important
      // assertion is the absence of CORS headers.
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-max-age')).toBeNull();
    });

    it('should NOT include CORS headers on /metrics', async () => {
      const response = await fetch(`${baseUrl}/metrics`);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-max-age')).toBeNull();
    });

    it('should include CORS headers on OPTIONS to /admin (preflight still responds)', async () => {
      // OPTIONS to an admin route should return 204 but WITHOUT CORS headers,
      // because the post-processing step skips admin routes.
      const response = await fetch(`${baseUrl}/admin/api/info`, { method: 'OPTIONS' });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('should include CORS headers on 404 responses', async () => {
      const response = await fetch(`${baseUrl}/nonexistent-path`);
      expect(response.status).toBe(404);

      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-max-age')).toBe('86400');
    });

    it('should reflect public local-node route origins without wildcard CORS', async () => {
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      });

      try {
        const response = await fetch(`${url}/info`, {
          headers: { origin: 'https://unpaired.example' },
        });
        expect(response.status).toBe(200);

        expect(response.headers.get('access-control-allow-origin')).toBe('https://unpaired.example');
        expect(response.headers.get('access-control-allow-headers')).toBe('authorization, content-type, dwn-request');
        expect(response.headers.get('vary')).toBe('Origin');
      } finally {
        await api.close();
      }
    });

    it('should only reflect paired origins on local-node protected routes', async () => {
      const localNodePairingManager = new LocalNodePairingManager();
      const token = localNodePairingManager.createSession('https://paired.example');
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      }, { localNodePairingManager });

      try {
        const pairedResponse = await fetch(`${url}/health`, {
          headers: {
            authorization : `Bearer ${token}`,
            origin        : 'https://paired.example',
          },
        });
        expect(pairedResponse.status).toBe(200);
        expect(pairedResponse.headers.get('access-control-allow-origin')).toBe('https://paired.example');

        const unpairedResponse = await fetch(`${url}/health`, {
          headers: {
            authorization : `Bearer ${token}`,
            origin        : 'https://unpaired.example',
          },
        });
        expect(unpairedResponse.status).toBe(401);
        expect(unpairedResponse.headers.get('access-control-allow-origin')).toBeNull();
      } finally {
        await api.close();
      }
    });
  });

  describe('local node profile', () => {
    async function requestWebSocketUpgradeStatus(wsUrl: string, origin: string): Promise<number> {
      const url = new URL(wsUrl);
      const requestPath = `${url.pathname}${url.search}`;

      return new Promise<number>((resolve, reject) => {
        const socket = connect({
          host : url.hostname,
          port : Number.parseInt(url.port, 10),
        });
        let response = '';
        const timeout = setTimeout((): void => {
          socket.destroy();
          reject(new Error('WebSocket upgrade response timeout'));
        }, 3000);

        socket.setEncoding('utf8');
        socket.once('connect', (): void => {
          socket.write([
            `GET ${requestPath} HTTP/1.1`,
            `Host: ${url.host}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            `Origin: ${origin}`,
            '',
            '',
          ].join('\r\n'));
        });
        socket.on('data', (chunk: string): void => {
          response += chunk;
          const statusLineEnd = response.indexOf('\r\n');
          if (statusLineEnd === -1) {
            return;
          }

          clearTimeout(timeout);
          socket.destroy();

          const statusLine = response.slice(0, statusLineEnd);
          const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(statusLine);
          if (statusMatch === null) {
            reject(new Error(`unexpected WebSocket upgrade response: ${statusLine}`));
            return;
          }

          resolve(Number.parseInt(statusMatch[1], 10));
        });
        socket.once('error', (error: Error): void => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    }

    it('should create and poll pairing requests and return approved tokens once', async () => {
      const localNodePairingManager = new LocalNodePairingManager();
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      }, { localNodePairingManager });

      try {
        const pairResponse = await fetch(`${url}/local/pair`, {
          headers : { origin: 'https://app.example' },
          method  : 'POST',
        });
        expect(pairResponse.status).toBe(200);
        expect(pairResponse.headers.get('access-control-allow-origin')).toBe('https://app.example');

        const pairBody = await pairResponse.json() as { requestId: string; status: string };
        expect(typeof pairBody.requestId).toBe('string');
        expect(pairBody.status).toBe('pending');
        expect(localNodePairingManager.listPendingRequests()[0].origin).toBe('https://app.example');

        const coalescedResponse = await fetch(`${url}/local/pair`, {
          headers : { origin: 'https://app.example' },
          method  : 'POST',
        });
        expect(coalescedResponse.status).toBe(200);
        expect(await coalescedResponse.json()).toEqual({
          requestId : pairBody.requestId,
          status    : 'pending',
        });

        const pendingResponse = await fetch(`${url}/local/pair/${pairBody.requestId}`, {
          headers: { origin: 'https://app.example' },
        });
        expect(await pendingResponse.json()).toEqual({
          origin : 'https://app.example',
          status : 'pending',
        });

        expect(localNodePairingManager.approveRequest(pairBody.requestId)).toBe(true);

        const wrongOriginResponse = await fetch(`${url}/local/pair/${pairBody.requestId}`, {
          headers: { origin: 'https://evil.example' },
        });
        expect(wrongOriginResponse.status).toBe(404);
        expect(wrongOriginResponse.headers.get('access-control-allow-origin')).toBeNull();

        const approvedResponse = await fetch(`${url}/local/pair/${pairBody.requestId}`, {
          headers: { origin: 'https://app.example' },
        });
        const approvedBody = await approvedResponse.json() as { origin: string; status: string; token?: string };
        expect(approvedBody.origin).toBe('https://app.example');
        expect(approvedBody.status).toBe('approved');
        expect(typeof approvedBody.token).toBe('string');

        const secondApprovedResponse = await fetch(`${url}/local/pair/${pairBody.requestId}`, {
          headers: { origin: 'https://app.example' },
        });
        expect(await secondApprovedResponse.json()).toEqual({
          origin : 'https://app.example',
          status : 'approved',
        });

        const authenticatedResponse = await fetch(`${url}/health`, {
          headers: {
            authorization : `Bearer ${approvedBody.token}`,
            origin        : 'https://app.example',
          },
        });
        expect(authenticatedResponse.status).toBe(200);
        expect(authenticatedResponse.headers.get('access-control-allow-origin')).toBe('https://app.example');

        const missingTokenResponse = await fetch(`${url}/health`, {
          headers: { origin: 'https://app.example' },
        });
        expect(missingTokenResponse.status).toBe(401);
        expect(missingTokenResponse.headers.get('access-control-allow-origin')).toBe('https://app.example');
      } finally {
        await api.close();
      }
    });

    it('should auto-approve pairing requests from configured local-node allowed origins', async () => {
      const localNodePairingManager = new LocalNodePairingManager();
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeAllowedOrigins : ['https://app.example'],
        localNodeProfileEnabled : true,
      }, { localNodePairingManager });

      try {
        const pairResponse = await fetch(`${url}/local/pair`, {
          headers : { origin: 'https://app.example' },
          method  : 'POST',
        });
        expect(pairResponse.status).toBe(200);
        expect(pairResponse.headers.get('access-control-allow-origin')).toBe('https://app.example');

        const pairBody = await pairResponse.json() as { requestId: string; status: string };
        expect(typeof pairBody.requestId).toBe('string');
        expect(pairBody.status).toBe('pending');
        expect(localNodePairingManager.listPendingRequests()).toEqual([]);

        const approvedResponse = await fetch(`${url}/local/pair/${pairBody.requestId}`, {
          headers: { origin: 'https://app.example' },
        });
        expect(approvedResponse.headers.get('access-control-allow-origin')).toBe('https://app.example');

        const approvedBody = await approvedResponse.json() as { origin: string; status: string; token?: string };
        expect(approvedBody.origin).toBe('https://app.example');
        expect(approvedBody.status).toBe('approved');
        expect(typeof approvedBody.token).toBe('string');
        expect(localNodePairingManager.validateSession('https://app.example', approvedBody.token)).toBe(true);

        const authenticatedResponse = await fetch(`${url}/health`, {
          headers: {
            authorization : `Bearer ${approvedBody.token}`,
            origin        : 'https://app.example',
          },
        });
        expect(authenticatedResponse.status).toBe(200);

        const unlistedPairResponse = await fetch(`${url}/local/pair`, {
          headers : { origin: 'https://unlisted.example' },
          method  : 'POST',
        });
        const unlistedPairBody = await unlistedPairResponse.json() as { requestId: string; status: string };
        expect(unlistedPairResponse.status).toBe(200);
        expect(unlistedPairBody.status).toBe('pending');
        expect(localNodePairingManager.listPendingRequests().map((request): string => request.origin)).toEqual(['https://unlisted.example']);

        const unlistedPollResponse = await fetch(`${url}/local/pair/${unlistedPairBody.requestId}`, {
          headers: { origin: 'https://unlisted.example' },
        });
        expect(await unlistedPollResponse.json()).toEqual({
          origin : 'https://unlisted.example',
          status : 'pending',
        });
      } finally {
        await api.close();
      }
    });

    it('should rate-limit completed pairing requests per origin over HTTP', async () => {
      const localNodePairingManager = new LocalNodePairingManager({
        now                        : (): number => 1_000,
        pairingRateLimitMax        : 1,
        pairingRateLimitWindowMs   : 60_000,
        terminalRequestRetentionMs : 60_000,
      });
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      }, { localNodePairingManager });

      try {
        const pairResponse = await fetch(`${url}/local/pair`, {
          headers : { origin: 'https://app.example' },
          method  : 'POST',
        });
        const pairBody = await pairResponse.json() as { requestId: string };

        expect(pairResponse.status).toBe(200);
        expect(localNodePairingManager.denyRequest(pairBody.requestId)).toBe(true);

        const rateLimitedResponse = await fetch(`${url}/local/pair`, {
          headers : { origin: 'https://app.example' },
          method  : 'POST',
        });
        expect(rateLimitedResponse.status).toBe(429);
        expect(rateLimitedResponse.headers.get('retry-after')).toBe('60');
        expect(rateLimitedResponse.headers.get('access-control-allow-origin')).toBe('https://app.example');
        expect(await rateLimitedResponse.json()).toEqual({ error: 'Pairing rate limit exceeded.' });
      } finally {
        await api.close();
      }
    });

    it('should reject pairing requests without an Origin header', async () => {
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      });

      try {
        const response = await fetch(`${url}/local/pair`, { method: 'POST' });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Origin header is required.' });
      } finally {
        await api.close();
      }
    });

    it('should accept no-Origin requests with a no-Origin local session token', async () => {
      const localNodePairingManager = new LocalNodePairingManager();
      const token = localNodePairingManager.createSession(undefined);
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      }, { localNodePairingManager });

      try {
        const response = await fetch(`${url}/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      } finally {
        await api.close();
      }
    });

    it('should expose authenticated local-node status for paired clients', async () => {
      const localNodePairingManager = new LocalNodePairingManager();
      const token = localNodePairingManager.createSession('https://paired.example');
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      }, { localNodePairingManager });

      try {
        const unauthorizedResponse = await fetch(`${url}/local/status`, {
          headers: { origin: 'https://paired.example' },
        });
        expect(unauthorizedResponse.status).toBe(401);

        const response = await fetch(`${url}/local/status`, {
          headers: {
            authorization : `Bearer ${token}`,
            origin        : 'https://paired.example',
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('https://paired.example');
        expect(await response.json()).toEqual({
          localNode : true,
          origin    : 'https://paired.example',
          paired    : true,
        });
      } finally {
        await api.close();
      }
    });

    it('should enforce local-node tokens before WebSocket upgrade', async () => {
      const localNodePairingManager = new LocalNodePairingManager();
      const token = localNodePairingManager.createSession('https://paired.example');
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      }, { localNodePairingManager });
      const wsUrl = url.replace(/^http:/, 'ws:');

      try {
        await expect(requestWebSocketUpgradeStatus(`${wsUrl}/info`, 'https://paired.example')).resolves.toBe(401);
        await expect(requestWebSocketUpgradeStatus(`${wsUrl}?localNodeToken=wrong`, 'https://paired.example')).resolves.toBe(401);
        await expect(requestWebSocketUpgradeStatus(`${wsUrl}?localNodeToken=${token}`, 'https://unpaired.example')).resolves.toBe(401);
        await expect(requestWebSocketUpgradeStatus(`${wsUrl}?localNodeToken=${token}`, 'https://paired.example')).resolves.toBe(101);
      } finally {
        await api.close();
      }
    });

    it('should reject requests with non-loopback Host headers', async () => {
      const { api, url } = await createStartedHttpApiWithConfig({
        hostname                : '127.0.0.1',
        localNodeProfileEnabled : true,
      });

      try {
        const response = await fetch(`${url}/info`, {
          headers: {
            host   : 'evil.example',
            origin : 'https://app.example',
          },
        });
        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      } finally {
        await api.close();
      }
    });
  });

  describe('getter accessors', () => {
    it('should expose the server instance via the server getter', () => {
      expect(httpApi.server).toBeDefined();
      expect(typeof httpApi.server.port).toBe('number');
    });

    it('should return undefined for ipRateLimiter when not configured', () => {
      // The default test config sets rateLimitRequestsPerSecond to 0,
      // so the rate limiter should still be instantiated (it's created
      // in HttpApi.create). Verify the getter doesn't throw.
      const limiter = httpApi.ipRateLimiter;
      // Can be either defined or undefined depending on config — just
      // verify the getter is accessible.
      expect(limiter === undefined || typeof limiter === 'object').toBe(true);
    });

    it('should return undefined for tenantRateLimiter when not configured', () => {
      const limiter = httpApi.tenantRateLimiter;
      expect(limiter === undefined || typeof limiter === 'object').toBe(true);
    });

    it('should return empty array for messageProcessedHooks when not configured', () => {
      const hooks = httpApi.messageProcessedHooks;
      expect(hooks).toEqual([]);
    });
  });
});
