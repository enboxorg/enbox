import type { JsonRpcSuccessResponse } from '@enbox/dwn-clients';
import type { Persona } from '@enbox/dwn-sdk-js';

import { expect } from 'bun:test';
import { getFileAsReadStream } from './utils.js';
import { Cid, DwnConstant, Jws, ModulesConfigure, RecordsRead, RecordsWrite, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { createHttpDwnRpcRequestBody, createJsonRpcRequest, HTTP_DWN_RPC_MEDIA_TYPE } from '@enbox/dwn-clients';

/**
 * Validator of common scenarios.
 */
export default class CommonScenarioValidator {
  /**
   * Sanity test RecordsWrite and RecordsRead on the DWN instance.
   */
  public static async sanityTestDwnReadWrite(dwnUrl: string, persona?: Persona): Promise<void> {
    const alice = persona || await TestDataGenerator.generateDidKeyPersona();
    const aliceSigner = Jws.createSigner(alice);

    // install minimal module on Alice's DWN
    const moduleDefinition = {
      module    : 'http://minimal.xyz',
      published : false,
      types     : {
        foo: {}
      },
      structure: {
        foo: {}
      }
    };

    const modulesConfig = await ModulesConfigure.create({
      signer     : aliceSigner,
      definition : moduleDefinition
    });

    const moduleConfigureRequestId = crypto.randomUUID();
    const moduleConfigureRequest = createJsonRpcRequest(moduleConfigureRequestId, 'dwn.processMessage', {
      target  : alice.did,
      message : modulesConfig.message,
    });
    const moduleConfigureResponse = await fetch(dwnUrl, {
      method  : 'POST',
      headers : {
        'content-type': HTTP_DWN_RPC_MEDIA_TYPE,
      },
      body: createHttpDwnRpcRequestBody(moduleConfigureRequest),
    });
    const moduleConfigureResponseBody = await moduleConfigureResponse.json() as JsonRpcSuccessResponse;

    expect(moduleConfigureResponse.status).toBe(200);
    expect(moduleConfigureResponseBody.result.reply.status.code).toBe(202);

    // Alice writing a file larger than max data size allowed to be encoded directly in the DWN Message Store.
    const filePath = './fixtures/test.jpeg';
    const {
      cid: dataCid,
      size: dataSize,
      stream
    } = await getFileAsReadStream(filePath);
    expect(dataSize).toBeGreaterThan(DwnConstant.maxDataSizeAllowedToBeEncoded);

    const recordsWrite = await RecordsWrite.create({
      signer     : aliceSigner,
      dataFormat : 'image/jpeg',
      module     : moduleDefinition.module,
      modulePath : 'foo',
      dataCid,
      dataSize
    });

    const recordsWriteRequestId = crypto.randomUUID();
    const recordsWriteRequest = createJsonRpcRequest(recordsWriteRequestId, 'dwn.processMessage', {
      target  : alice.did,
      message : recordsWrite.message,
    });
    const recordsWriteResponse = await fetch(dwnUrl, {
      method  : 'POST',
      headers : {
        'content-type': HTTP_DWN_RPC_MEDIA_TYPE,
      },
      body: createHttpDwnRpcRequestBody(recordsWriteRequest, stream),
    });
    const recordsWriteResponseBody = await recordsWriteResponse.json() as JsonRpcSuccessResponse;

    expect(recordsWriteResponse.status).toBe(200);
    expect(recordsWriteResponseBody.result.reply.status.code).toBe(202);

    // Alice reading the file back out.
    const recordsRead = await RecordsRead.create({
      signer : aliceSigner,
      filter : {
        recordId: recordsWrite.message.recordId,
      },
    });

    const recordsReadRequestId = crypto.randomUUID();
    const recordsReadRequest = createJsonRpcRequest(recordsReadRequestId, 'dwn.processMessage', {
      target  : alice.did,
      message : recordsRead.message
    });

    const recordsReadResponse = await fetch(dwnUrl, {
      method  : 'POST',
      headers : {
        'content-type': HTTP_DWN_RPC_MEDIA_TYPE,
      },
      body: createHttpDwnRpcRequestBody(recordsReadRequest),
    });

    expect(recordsReadResponse.status).toBe(200);

    const { headers } = recordsReadResponse;
    const contentType = headers.get('content-type');
    expect(contentType).toBeDefined();
    expect(contentType).toBe('application/octet-stream');

    const recordsReadDwnResponse = headers.get('dwn-response');
    expect(recordsReadDwnResponse).toBeDefined();

    const recordsReadJsonRpcResponse = JSON.parse(recordsReadDwnResponse) as JsonRpcSuccessResponse;
    expect(recordsReadJsonRpcResponse.id).toBe(recordsReadRequestId);
    expect(recordsReadJsonRpcResponse.error).toBeUndefined();
    expect(recordsReadJsonRpcResponse.result.reply.status.code).toBe(200);
    expect(recordsReadJsonRpcResponse.result.reply.entry.recordsWrite).toBeDefined();

    // can't get response as stream from supertest :(
    const cid = await Cid.computeDagPbCidFromStream(recordsReadResponse.body as unknown as ReadableStream<Uint8Array>);
    expect(cid).toBe(dataCid);
  }
}
