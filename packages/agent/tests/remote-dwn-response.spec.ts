import type { BearerDid, DidResolver } from '@enbox/dids';
import type {
  GenericMessage,
  GenericMessageReply,
  MessageSigner,
  ProtocolDefinition,
  ProtocolsConfigureMessage,
  ProtocolsQueryReply,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsSubscribeReply,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import { beforeAll, describe, expect, it } from 'bun:test';

import {
  DataStream,
  DateSort,
  Encoder,
  ProtocolsConfigure,
  ProtocolsQuery,
  RecordsDelete,
  RecordsQuery,
  RecordsRead,
  RecordsSubscribe,
  RecordsWrite,
  Time,
} from '@enbox/dwn-sdk-js';
import { DidJwk, UniversalResolver } from '@enbox/dids';

import { verifyRemoteDwnResponse } from '../src/remote-dwn-response.js';

const protocolUri = 'https://example.com/remote-response';
const otherProtocolUri = 'https://example.com/other-protocol';
const recordSchema = 'https://example.com/schemas/note';
const textEncoder = new TextEncoder();

describe('verifyRemoteDwnResponse', () => {
  let attacker: BearerDid;
  let didResolver: DidResolver;
  let target: BearerDid;
  let attackerSigner: MessageSigner;
  let targetSigner: MessageSigner;

  beforeAll(async () => {
    [target, attacker] = await Promise.all([DidJwk.create(), DidJwk.create()]);
    [targetSigner, attackerSigner] = await Promise.all([signerForDid(target), signerForDid(attacker)]);
    didResolver = new UniversalResolver({ didResolvers: [DidJwk] });
  });

  function verifyResponse(message: GenericMessage, reply: GenericMessageReply): Promise<void> {
    return verifyRemoteDwnResponse({ didResolver, message, reply, targetDid: target.uri });
  }

  it('preserves unsuccessful query responses that contain no artifacts', async () => {
    const [protocolsQuery, recordsQuery] = await Promise.all([
      ProtocolsQuery.create({ filter: { protocol: protocolUri } }),
      RecordsQuery.create({ filter: { protocol: protocolUri }, signer: targetSigner }),
    ]);
    const reply = { status: { code: 500, detail: 'Internal Server Error' } };

    await expect(verifyResponse(protocolsQuery.message, reply)).resolves.toBeUndefined();
    await expect(verifyResponse(recordsQuery.message, reply)).resolves.toBeUndefined();
  });

  describe('ProtocolsQuery', () => {
    it('accepts a configuration signed directly by the target DID', async () => {
      const query = await ProtocolsQuery.create({ filter: { protocol: protocolUri } });
      const configure = await ProtocolsConfigure.create({
        definition : protocolDefinition(protocolUri),
        signer     : targetSigner,
      });
      const reply: ProtocolsQueryReply = {
        entries : [configure.message],
        status  : { code: 200, detail: 'OK' },
      };

      await expect(verifyResponse(query.message, reply)).resolves.toBeUndefined();
    });

    it('rejects a configuration signed by an attacker', async () => {
      const query = await ProtocolsQuery.create({ filter: { protocol: protocolUri } });
      const configure = await ProtocolsConfigure.create({
        definition : protocolDefinition(protocolUri),
        signer     : attackerSigner,
      });

      await expect(verifyResponse(query.message, protocolReply(configure.message)))
        .rejects.toThrow(`instead of '${target.uri}'`);
    });

    it('rejects a signed configuration whose definition was changed in transit', async () => {
      const query = await ProtocolsQuery.create({ filter: { protocol: protocolUri } });
      const configure = await ProtocolsConfigure.create({
        definition : protocolDefinition(protocolUri),
        signer     : targetSigner,
      });
      const tampered = structuredClone(configure.message);
      tampered.descriptor.definition.published = false;

      await expect(verifyResponse(query.message, protocolReply(tampered))).rejects.toThrow();
    });

    it('rejects a valid configuration for a different requested protocol', async () => {
      const query = await ProtocolsQuery.create({ filter: { protocol: protocolUri } });
      const configure = await ProtocolsConfigure.create({
        definition : protocolDefinition(otherProtocolUri),
        signer     : targetSigner,
      });

      await expect(verifyResponse(query.message, protocolReply(configure.message)))
        .rejects.toThrow(`while '${protocolUri}' was requested`);
    });

    it('rejects multiple configurations for one exact protocol query', async () => {
      const query = await ProtocolsQuery.create({ filter: { protocol: protocolUri } });
      const configure = await ProtocolsConfigure.create({
        definition : protocolDefinition(protocolUri),
        signer     : targetSigner,
      });
      const reply = protocolReply(configure.message);
      reply.entries!.push(configure.message);

      await expect(verifyResponse(query.message, reply)).rejects.toThrow('multiple configurations');
    });

    it('rejects entries attached to an unsuccessful response', async () => {
      const query = await ProtocolsQuery.create({ filter: { protocol: protocolUri } });
      const configure = await ProtocolsConfigure.create({
        definition : protocolDefinition(protocolUri),
        signer     : targetSigner,
      });
      const reply = protocolReply(configure.message);
      reply.status = { code: 500, detail: 'Internal Server Error' };

      await expect(verifyResponse(query.message, reply)).rejects.toThrow('status 500 with entries');
    });

    it('rejects an unpublished configuration returned to an anonymous query', async () => {
      const query = await ProtocolsQuery.create({ filter: { protocol: protocolUri } });
      const configure = await ProtocolsConfigure.create({
        definition : { ...protocolDefinition(protocolUri), published: false },
        signer     : targetSigner,
      });

      await expect(verifyResponse(query.message, protocolReply(configure.message)))
        .rejects.toThrow('anonymous query returned unpublished protocol');
    });
  });

  describe('RecordsQuery', () => {
    it('accepts an authenticated matching record whose inline bytes match its descriptor', async () => {
      const data = textEncoder.encode('authentic record');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const query = await RecordsQuery.create({
        filter : { recordId: recordsWrite.message.recordId },
        signer : targetSigner,
      });
      const reply = recordsQueryReply(recordsWrite.message, data);

      await expect(verifyResponse(query.message, reply)).resolves.toBeUndefined();
    });

    it('rejects signed records whose descriptor or signature was changed in transit', async () => {
      const data = textEncoder.encode('signed record');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const query = await RecordsQuery.create({ filter: { recordId: recordsWrite.message.recordId }, signer: targetSigner });
      const changedDescriptor = structuredClone(recordsWrite.message);
      changedDescriptor.descriptor.dataFormat = 'application/json';
      const changedSignature = structuredClone(recordsWrite.message);
      const signature = changedSignature.authorization!.signature.signatures[0].signature;
      changedSignature.authorization!.signature.signatures[0].signature = replaceLastCharacter(signature);

      for (const message of [changedDescriptor, changedSignature]) {
        await expect(verifyResponse(query.message, recordsQueryReply(message, data))).rejects.toThrow();
      }
    });

    it('rejects an authenticated record outside the requested filter', async () => {
      const data = textEncoder.encode('wrong record');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const query = await RecordsQuery.create({ filter: { recordId: 'not-the-returned-record' }, signer: targetSigner });

      await expect(verifyResponse(query.message, recordsQueryReply(recordsWrite.message, data)))
        .rejects.toThrow('does not match the request filter');
    });

    it('rejects inline bytes that do not match the signed data CID', async () => {
      const data = textEncoder.encode('expected bytes');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const query = await RecordsQuery.create({ filter: { recordId: recordsWrite.message.recordId }, signer: targetSigner });

      await expect(verifyResponse(
        query.message,
        recordsQueryReply(recordsWrite.message, textEncoder.encode('tampered bytes')),
      )).rejects.toThrow();
    });

    it('rejects entries attached to an unsuccessful response', async () => {
      const data = textEncoder.encode('injected error entry');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const query = await RecordsQuery.create({ filter: { recordId: recordsWrite.message.recordId }, signer: targetSigner });
      const reply = recordsQueryReply(recordsWrite.message, data);
      reply.status = { code: 500, detail: 'Internal Server Error' };

      await expect(verifyResponse(query.message, reply)).rejects.toThrow('status 500 with entries');
    });

    it('requires anonymous results to be both published and matched by the original filter', async () => {
      const data = textEncoder.encode('visibility checks');
      const unpublishedWrite = await createRecordsWrite(data, targetSigner);
      const publishedWrite = await createRecordsWrite(data, targetSigner, true);
      const anonymousQuery = await RecordsQuery.create({ filter: { protocol: protocolUri } });
      const unpublishedQuery = await RecordsQuery.create({ filter: { protocol: protocolUri, published: false } });

      await expect(verifyResponse(anonymousQuery.message, recordsQueryReply(unpublishedWrite.message, data)))
        .rejects.toThrow('anonymous query returned unpublished');

      await expect(verifyResponse(unpublishedQuery.message, recordsQueryReply(publishedWrite.message, data)))
        .rejects.toThrow('does not match the request filter');
    });

    it('accepts an update only when it carries its matching authenticated initial write', async () => {
      const initialData = textEncoder.encode('initial data');
      const updatedData = textEncoder.encode('updated data');
      const initialWrite = await createRecordsWrite(initialData, targetSigner);
      await Time.minimalSleep();
      const update = await RecordsWrite.createFrom({
        data                : updatedData,
        recordsWriteMessage : initialWrite.message,
        signer              : targetSigner,
      });
      const query = await RecordsQuery.create({ filter: { recordId: update.message.recordId }, signer: targetSigner });
      const reply: RecordsQueryReply = {
        entries : [{ ...update.message, encodedData: Encoder.bytesToBase64Url(updatedData), initialWrite: initialWrite.message }],
        status  : { code: 200, detail: 'OK' },
      };

      await expect(verifyResponse(query.message, reply)).resolves.toBeUndefined();
    });

    it('rejects an update with a missing or mismatched initial write', async () => {
      const initialData = textEncoder.encode('initial data');
      const updatedData = textEncoder.encode('updated data');
      const initialWrite = await createRecordsWrite(initialData, targetSigner);
      const unrelatedInitialWrite = await createRecordsWrite(textEncoder.encode('unrelated data'), targetSigner);
      await Time.minimalSleep();
      const update = await RecordsWrite.createFrom({
        data                : updatedData,
        recordsWriteMessage : initialWrite.message,
        signer              : targetSigner,
      });
      const query = await RecordsQuery.create({ filter: { recordId: update.message.recordId }, signer: targetSigner });
      const entries = [
        { ...update.message, encodedData: Encoder.bytesToBase64Url(updatedData) },
        { ...update.message, encodedData: Encoder.bytesToBase64Url(updatedData), initialWrite: unrelatedInitialWrite.message },
      ];

      for (const entry of entries) {
        const reply: RecordsQueryReply = { entries: [entry], status: { code: 200, detail: 'OK' } };
        await expect(verifyResponse(query.message, reply)).rejects.toThrow();
      }
    });
  });

  describe('RecordsSubscribe snapshot', () => {
    it('accepts an authenticated matching initial snapshot', async () => {
      const data = textEncoder.encode('snapshot record');
      const recordsWrite = await createRecordsWrite(data, targetSigner, true);
      const subscribe = await RecordsSubscribe.create({ filter: { protocol: protocolUri } });
      const reply: RecordsSubscribeReply = {
        entries      : [{ ...recordsWrite.message, encodedData: Encoder.bytesToBase64Url(data) }],
        status       : { code: 200, detail: 'OK' },
        subscription : { id: 'valid-snapshot', close: async (): Promise<void> => {} },
      };

      await expect(verifyResponse(subscribe.message, reply)).resolves.toBeUndefined();
    });

    it('closes a subscription whose initial snapshot fails verification', async () => {
      const data = textEncoder.encode('tampered snapshot record');
      const recordsWrite = await createRecordsWrite(data, targetSigner, true);
      const tamperedWrite = structuredClone(recordsWrite.message);
      const signature = tamperedWrite.authorization!.signature.signatures[0].signature;
      tamperedWrite.authorization!.signature.signatures[0].signature = replaceLastCharacter(signature);
      const subscribe = await RecordsSubscribe.create({ filter: { protocol: protocolUri } });
      let closed = false;
      const reply: RecordsSubscribeReply = {
        entries      : [{ ...tamperedWrite, encodedData: Encoder.bytesToBase64Url(data) }],
        status       : { code: 200, detail: 'OK' },
        subscription : { id: 'invalid-snapshot', close: async (): Promise<void> => { closed = true; } },
      };

      await expect(verifyResponse(subscribe.message, reply)).rejects.toThrow();
      expect(closed).toBe(true);
    });
  });

  describe('RecordsRead', () => {
    it('streams authentic bytes and verifies them before successful end-of-stream', async () => {
      const data = textEncoder.encode('streamed record');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const read = await RecordsRead.create({ filter: { recordId: recordsWrite.message.recordId }, signer: targetSigner });
      const reply = recordsReadReply(recordsWrite.message, data);

      await expect(verifyResponse(read.message, reply)).resolves.toBeUndefined();

      expect(await DataStream.toBytes(reply.entry!.data!)).toEqual(data);
    });

    it('fails the returned stream when bytes are tampered with or differ from the signed size', async () => {
      const data = textEncoder.encode('expected stream');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const read = await RecordsRead.create({ filter: { recordId: recordsWrite.message.recordId }, signer: targetSigner });
      const invalidPayloads = [
        textEncoder.encode('tampered stream'),
        textEncoder.encode('short'),
        textEncoder.encode('expected stream plus extra bytes'),
      ];

      for (const invalidData of invalidPayloads) {
        const reply = recordsReadReply(recordsWrite.message, invalidData);
        await expect(verifyResponse(read.message, reply)).resolves.toBeUndefined();

        await expect(DataStream.toBytes(reply.entry!.data!)).rejects.toThrow();
      }
    });

    it('accepts an authenticated unpublished record returned by an anonymous read', async () => {
      const data = textEncoder.encode('anyone-readable record');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const read = await RecordsRead.create({ filter: { recordId: recordsWrite.message.recordId } });
      const reply = recordsReadReply(recordsWrite.message, data);

      await expect(verifyResponse(read.message, reply)).resolves.toBeUndefined();

      expect(await DataStream.toBytes(reply.entry!.data!)).toEqual(data);
    });

    it('rejects an unpublished record from a published-sorted read', async () => {
      const data = textEncoder.encode('unpublished record');
      const recordsWrite = await createRecordsWrite(data, targetSigner);
      const read = await RecordsRead.create({
        dateSort : DateSort.PublishedDescending,
        filter   : { recordId: recordsWrite.message.recordId },
        signer   : targetSigner,
      });

      await expect(verifyResponse(read.message, recordsReadReply(recordsWrite.message, data)))
        .rejects.toThrow('does not match the request filter');
    });

    it('authenticates and preserves 410 responses whose record data is unavailable', async () => {
      const data = textEncoder.encode('unavailable record');
      const initialWrite = await createRecordsWrite(data, targetSigner);
      await Time.minimalSleep();
      const update = await RecordsWrite.createFrom({
        data,
        recordsWriteMessage : initialWrite.message,
        signer              : targetSigner,
      });
      const read = await RecordsRead.create({ filter: { recordId: initialWrite.message.recordId }, signer: targetSigner });

      for (const recordsWrite of [initialWrite, update]) {
        const reply: RecordsReadReply = {
          entry  : { recordsWrite: recordsWrite.message },
          status : { code: 410, detail: 'Record data not available' },
        };

        await expect(verifyResponse(read.message, reply)).resolves.toBeUndefined();
      }
    });

    it('authenticates a deleted record and its initial write in a 404 response', async () => {
      const data = textEncoder.encode('deleted record');
      const initialWrite = await createRecordsWrite(data, targetSigner);
      const recordsDelete = await RecordsDelete.create({
        recordId : initialWrite.message.recordId,
        signer   : targetSigner,
      });
      const read = await RecordsRead.create({ filter: { recordId: initialWrite.message.recordId }, signer: targetSigner });
      const reply: RecordsReadReply = {
        entry: {
          initialWrite  : initialWrite.message,
          recordsDelete : recordsDelete.message,
        },
        status: { code: 404, detail: 'Not Found' },
      };

      await expect(verifyResponse(read.message, reply)).resolves.toBeUndefined();
    });

    it('rejects a tombstone when the read filter depends on the missing last write', async () => {
      const data = textEncoder.encode('deleted record');
      const initialWrite = await createRecordsWrite(data, targetSigner);
      const recordsDelete = await RecordsDelete.create({ recordId: initialWrite.message.recordId, signer: targetSigner });
      const read = await RecordsRead.create({
        filter : { recordId: initialWrite.message.recordId, dataCid: initialWrite.message.descriptor.dataCid },
        signer : targetSigner,
      });
      const reply: RecordsReadReply = {
        entry: {
          initialWrite  : initialWrite.message,
          recordsDelete : recordsDelete.message,
        },
        status: { code: 404, detail: 'Not Found' },
      };

      await expect(verifyResponse(read.message, reply))
        .rejects.toThrow('cannot be authenticated against a filter');
    });

    it('rejects a tombstone from a published-sorted read', async () => {
      const initialWrite = await createRecordsWrite(textEncoder.encode('deleted record'), targetSigner, true);
      const recordsDelete = await RecordsDelete.create({ recordId: initialWrite.message.recordId, signer: targetSigner });
      const read = await RecordsRead.create({
        dateSort : DateSort.PublishedAscending,
        filter   : { recordId: initialWrite.message.recordId },
        signer   : targetSigner,
      });
      const reply: RecordsReadReply = {
        entry  : { initialWrite: initialWrite.message, recordsDelete: recordsDelete.message },
        status : { code: 404, detail: 'Not Found' },
      };

      await expect(verifyResponse(read.message, reply)).rejects.toThrow('published date sort');
    });

    it('rejects inconsistent RecordsRead entry and status combinations', async () => {
      const data = textEncoder.encode('record state');
      const initialWrite = await createRecordsWrite(data, targetSigner);
      const recordsDelete = await RecordsDelete.create({
        recordId : initialWrite.message.recordId,
        signer   : targetSigner,
      });
      const read = await RecordsRead.create({ filter: { recordId: initialWrite.message.recordId }, signer: targetSigner });
      const invalidReplies: RecordsReadReply[] = [
        { status: { code: 200, detail: 'OK' } },
        {
          entry  : { recordsWrite: initialWrite.message },
          status : { code: 200, detail: 'OK' },
        },
        {
          entry  : { data: DataStream.fromBytes(data), recordsWrite: initialWrite.message },
          status : { code: 410, detail: 'Record data not available' },
        },
        {
          entry  : { recordsDelete: recordsDelete.message, recordsWrite: initialWrite.message },
          status : { code: 404, detail: 'Not Found' },
        },
        {
          entry  : {},
          status : { code: 200, detail: 'OK' },
        },
        {
          entry  : { initialWrite: initialWrite.message, recordsDelete: recordsDelete.message },
          status : { code: 200, detail: 'OK' },
        },
      ];

      for (const reply of invalidReplies) {
        await expect(verifyResponse(read.message, reply)).rejects.toThrow();
      }
    });

    it('rejects a tombstone with an unauthenticated or unrelated initial write', async () => {
      const initialWrite = await createRecordsWrite(textEncoder.encode('deleted record'), targetSigner);
      const unrelatedWrite = await createRecordsWrite(textEncoder.encode('unrelated record'), targetSigner);
      const recordsDelete = await RecordsDelete.create({
        recordId : initialWrite.message.recordId,
        signer   : targetSigner,
      });
      const tamperedDelete = structuredClone(recordsDelete.message);
      const deleteSignature = tamperedDelete.authorization.signature.signatures[0].signature;
      tamperedDelete.authorization.signature.signatures[0].signature = replaceLastCharacter(deleteSignature);
      const read = await RecordsRead.create({ filter: { recordId: initialWrite.message.recordId }, signer: targetSigner });
      const invalidReplies: RecordsReadReply[] = [
        {
          entry  : { initialWrite: unrelatedWrite.message, recordsDelete: recordsDelete.message },
          status : { code: 404, detail: 'Not Found' },
        },
        {
          entry  : { initialWrite: initialWrite.message, recordsDelete: tamperedDelete },
          status : { code: 404, detail: 'Not Found' },
        },
      ];

      for (const reply of invalidReplies) {
        await expect(verifyResponse(read.message, reply)).rejects.toThrow();
      }
    });
  });
});

async function signerForDid(did: BearerDid): Promise<MessageSigner> {
  const signer = await did.getSigner();
  return {
    algorithm : signer.algorithm,
    keyId     : signer.keyId,
    sign      : async (content: Uint8Array): Promise<Uint8Array> => signer.sign({ data: content }),
  };
}

function protocolDefinition(protocol: string): ProtocolDefinition {
  return {
    protocol,
    published : true,
    structure : {},
    types     : {},
  };
}

function protocolReply(message: ProtocolsConfigureMessage): ProtocolsQueryReply {
  return {
    entries : [message],
    status  : { code: 200, detail: 'OK' },
  };
}

async function createRecordsWrite(data: Uint8Array, signer: MessageSigner, published?: boolean): Promise<RecordsWrite> {
  return RecordsWrite.create({
    data,
    dataFormat   : 'text/plain',
    protocol     : protocolUri,
    protocolPath : 'note',
    schema       : recordSchema,
    signer,
    published,
  });
}

function recordsQueryReply(message: RecordsWriteMessage, data: Uint8Array): RecordsQueryReply {
  return {
    entries : [{ ...message, encodedData: Encoder.bytesToBase64Url(data) }],
    status  : { code: 200, detail: 'OK' },
  };
}

function recordsReadReply(message: RecordsWriteMessage, data: Uint8Array): RecordsReadReply {
  return {
    entry: {
      data         : DataStream.fromBytes(data),
      recordsWrite : message,
    },
    status: { code: 200, detail: 'OK' },
  };
}

function replaceLastCharacter(value: string): string {
  const replacement = value.endsWith('A') ? 'B' : 'A';
  return `${value.slice(0, -1)}${replacement}`;
}
