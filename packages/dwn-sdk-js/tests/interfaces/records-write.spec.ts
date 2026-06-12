import type { EncryptionInput, RecordsWriteOptions } from '../../src/interfaces/records-write.js';
import type { MessageSigner, PermissionScope } from '../../src/index.js';

import sinon from 'sinon';
import { beforeEach, describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { RecordsWriteHandler } from '../../src/handlers/records-write.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';

import { DwnInterfaceName, DwnMethodName, Encoder, Jws, KeyDerivationScheme, Message, MessageStoreLevel, PermissionsProtocol } from '../../src/index.js';

import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';


describe('RecordsWrite', () => {
  beforeEach(() => {
    sinon.restore();
  });

  describe('create()', () => {
    it('should be able to create and authorize a valid RecordsWrite message', async () => {
      // testing `create()` first
      const alice = await TestDataGenerator.generatePersona();

      const options: RecordsWriteOptions = {
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        dateCreated  : '2022-10-14T10:20:30.405060Z',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        signer       : Jws.createSigner(alice)
      };
      const recordsWrite = await RecordsWrite.create(options);

      const message = recordsWrite.message;

      expect(message.authorization).toBeDefined();
      expect(message.descriptor.dataFormat).toBe(options.dataFormat);
      expect(message.descriptor.dateCreated).toBe(options.dateCreated);
      expect(message.recordId).toBe(options.recordId);

      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);

      // authorizeRecordsWrite is a private instance method; invoke via bracket notation on an instance
      const handler = new RecordsWriteHandler({
        didResolver           : {} as any,
        messageStore          : messageStoreStub,
        validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub }),
        dataStore             : {} as any,
        stateIndex            : {} as any,
      });
      await (handler as any).authorizeRecordsWrite(alice.did, recordsWrite, 'live');
    });

    it('should include permissionGrantId in the descriptor when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const grantId = await TestDataGenerator.randomCborSha256Cid();

      const recordsWrite = await RecordsWrite.create({
        data              : TestDataGenerator.randomBytes(10),
        dataFormat        : 'application/json',
        recordId          : await TestDataGenerator.randomCborSha256Cid(),
        protocol          : 'http://test-protocol.xyz',
        protocolPath      : 'testRecord',
        signer            : Jws.createSigner(alice),
        permissionGrantId : grantId,
      });

      expect(recordsWrite.message.descriptor.permissionGrantId).toBe(grantId);
    });

    it('should include permissionGrantId in indexes when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const grantId = await TestDataGenerator.randomCborSha256Cid();

      const recordsWrite = await RecordsWrite.create({
        data              : TestDataGenerator.randomBytes(10),
        dataFormat        : 'application/json',
        recordId          : await TestDataGenerator.randomCborSha256Cid(),
        protocol          : 'http://test-protocol.xyz',
        protocolPath      : 'testRecord',
        signer            : Jws.createSigner(alice),
        permissionGrantId : grantId,
      });

      const indexes = await recordsWrite.constructIndexes(true);
      expect(indexes.permissionGrantId).toBe(grantId);
    });

    it('should not include permissionGrantId in the descriptor when not provided', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const recordsWrite = await RecordsWrite.create({
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        signer       : Jws.createSigner(alice),
      });

      expect(recordsWrite.message.descriptor.permissionGrantId).toBeUndefined();
    });

    it('should parse owner-signed writes that invoke a direct permission grant', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const grantId = await TestDataGenerator.randomCborSha256Cid();

      const recordsWrite = await RecordsWrite.create({
        data              : TestDataGenerator.randomBytes(10),
        dataFormat        : 'application/json',
        recordId          : await TestDataGenerator.randomCborSha256Cid(),
        protocol          : 'http://test-protocol.xyz',
        protocolPath      : 'testRecord',
        signer            : Jws.createSigner(alice),
        permissionGrantId : grantId,
      });

      await recordsWrite.signAsOwner(Jws.createSigner(bob));

      const parsed = await RecordsWrite.parse(recordsWrite.message);
      expect(parsed.message.descriptor.permissionGrantId).toBe(grantId);
      expect(parsed.message.authorization.ownerSignature).toBeDefined();
    });

    it('should be able to auto-fill `datePublished` when `published` set to `true` but `datePublished` not given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const options: RecordsWriteOptions = {
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        published    : true,
        signer       : Jws.createSigner(alice)
      };
      const recordsWrite = await RecordsWrite.create(options);

      const message = recordsWrite.message;

      expect(message.descriptor.datePublished).toBeDefined();
    });

    it('should not allow `data` and `dataCid` to be both defined or undefined', async () => {
      const alice = await TestDataGenerator.generatePersona();

      // testing `data` and `dataCid` both defined
      const options1 = {
        recipient    : alice.did,
        data         : TestDataGenerator.randomBytes(10),
        dataCid      : await TestDataGenerator.randomCborSha256Cid(),
        dataFormat   : 'application/json',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        published    : true,
        signer       : Jws.createSigner(alice)
      };
      const createPromise1 = RecordsWrite.create(options1);

      await expect(createPromise1).rejects.toThrow(DwnErrorCode.RecordsWriteCreateDataAndDataCidMutuallyExclusive);

      // testing `data` and `dataCid` both undefined
      const options2 = {
        recipient    : alice.did,
        // intentionally showing both `data` and `dataCid` are undefined
        // data                        : TestDataGenerator.randomBytes(10),
        // dataCid                     : await TestDataGenerator.randomCborSha256Cid(),
        dataFormat   : 'application/json',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        published    : true,
        signer       : Jws.createSigner(alice)
      };
      const createPromise2 = RecordsWrite.create(options2);

      await expect(createPromise2).rejects.toThrow(DwnErrorCode.RecordsWriteCreateDataAndDataCidMutuallyExclusive);
    });

    it('should required `dataCid` and `dataSize` to be both defined or undefined at the same time', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const options1 = {
        recipient    : alice.did,
        dataCid      : await TestDataGenerator.randomCborSha256Cid(),
        // dataSize                  : 123, // intentionally missing
        dataFormat   : 'application/json',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        published    : true,
        signer       : Jws.createSigner(alice)
      };
      const createPromise1 = RecordsWrite.create(options1);

      await expect(createPromise1).rejects.toThrow('`dataCid` and `dataSize` must both be defined or undefined at the same time');

      const options2 = {
        recipient    : alice.did,
        data         : TestDataGenerator.randomBytes(10),
        // dataCid                   : await TestDataGenerator.randomCborSha256Cid(), // intentionally missing
        dataSize     : 123,
        dataFormat   : 'application/json',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        published    : true,
        signer       : Jws.createSigner(alice)
      };
      const createPromise2 = RecordsWrite.create(options2);

      await expect(createPromise2).rejects.toThrow('`dataCid` and `dataSize` must both be defined or undefined at the same time');
    });

    it('should auto-normalize protocol URL', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const options: RecordsWriteOptions = {
        recipient    : alice.did,
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        signer       : Jws.createSigner(alice),
        protocol     : 'example.com/',
        protocolPath : 'example',
        schema       : 'http://foo.bar/schema'
      };
      const recordsWrite = await RecordsWrite.create(options);

      const message = recordsWrite.message;

      expect(message.descriptor.protocol).toBe('http://example.com');
    });

    it('should require `protocol` and `protocolPath`', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const baseOptions = {
        recipient  : alice.did,
        dataCid    : await TestDataGenerator.randomCborSha256Cid(),
        dataSize   : 123,
        dataFormat : 'application/json',
        recordId   : await TestDataGenerator.randomCborSha256Cid(),
        signer     : Jws.createSigner(alice)
      };

      // missing protocol
      const missingProtocol = RecordsWrite.create({
        ...baseOptions,
        protocolPath: 'foo/bar',
      } as RecordsWriteOptions);
      await expect(missingProtocol).rejects.toThrow('`protocol` and `protocolPath` are required');

      // missing protocolPath
      const missingProtocolPath = RecordsWrite.create({
        ...baseOptions,
        protocol: 'http://example.com',
      } as RecordsWriteOptions);
      await expect(missingProtocolPath).rejects.toThrow('`protocol` and `protocolPath` are required');
    });

    it('should be able to create a RecordsWrite successfully using a custom signer', async () => {
      // create a custom signer
      const hardCodedSignature = Encoder.stringToBytes('some_hard_coded_signature');
      class CustomSigner implements MessageSigner {
        public keyId = 'did:example:alice#key1';
        public algorithm = 'unused';
        public async sign (_content: Uint8Array): Promise<Uint8Array> {
          return hardCodedSignature;
        }
      }

      const signer = new CustomSigner();

      const options: RecordsWriteOptions = {
        schema       : 'http://any-schema.com',
        protocol     : 'http://example.com',
        protocolPath : 'foo/bar',
        dataCid      : await TestDataGenerator.randomCborSha256Cid(),
        dataSize     : 123,
        dataFormat   : 'application/json',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        signer
      };

      const recordsWrite = await RecordsWrite.create(options);

      expect(recordsWrite.message.authorization!.signature.signatures[0].signature).toBe(Encoder.bytesToBase64Url(hardCodedSignature));
    });

    it('should throw if delegated grant is given but signer is not given', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();

      const scope: PermissionScope = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        protocol  : 'chat'
      };
      const grantToBob = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        delegated   : true, // this is a delegated grant
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write as me in chat protocol',
        grantedTo   : bob.did,
        scope
      });

      const createPromise = RecordsWrite.create({
        delegatedGrant : grantToBob.dataEncodedMessage,
        protocol       : 'http://test-protocol.xyz',
        protocolPath   : 'testRecord',
        dataFormat     : 'application/octet-stream',
        data           : TestDataGenerator.randomBytes(10),
      });

      await expect(createPromise).rejects.toThrow(DwnErrorCode.RecordsWriteCreateMissingSigner);
    });
  });

  describe('createFrom()', () => {
    it('should create a RecordsWrite with `published` set to `true` with just `publishedDate` given', async () => {
      const { author, recordsWrite } = await TestDataGenerator.generateRecordsWrite({
        published: false
      });

      const write = await RecordsWrite.createFrom({
        recordsWriteMessage : recordsWrite.message,
        datePublished       : Time.getCurrentTimestamp(),
        signer              : Jws.createSigner(author)
      });

      expect(write.message.descriptor.published).toBe(true);
    });

    it('replace tags with updated tags, if tags do not exist in createFrom remove them', async () => {

      // create a record with tags
      const { author, message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({
        tags: {
          tag1: [ 'value1', 'value2' ]
        }
      });
      expect(message.descriptor.tags).toBeDefined();
      expect(message.descriptor.tags!.tag1).toBeDefined();
      expect(message.descriptor.tags!.tag1).toEqual(expect.arrayContaining([ 'value1', 'value2' ]));

      // update the record's tags
      const write = await RecordsWrite.createFrom({
        recordsWriteMessage : recordsWrite.message,
        signer              : Jws.createSigner(author),
        tags                : {
          tag2: [ 'value1', 'value2', 'value3' ]
        }
      });
      expect(write.message.descriptor.tags).toBeDefined();
      expect(write.message.descriptor.tags!.tag1).toBeUndefined();
      expect(write.message.descriptor.tags!.tag2).toBeDefined();
      expect(write.message.descriptor.tags!.tag2).toEqual(expect.arrayContaining([ 'value1', 'value2', 'value3' ]));

      // update without tags
      const write2 = await RecordsWrite.createFrom({
        recordsWriteMessage : write.message,
        signer              : Jws.createSigner(author),
      });
      expect(write2.message.descriptor.tags).toBeUndefined();
    });
  });

  describe('parse()', () => {
    it('should invoke JSON schema validation when parsing a RecordsWrite', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const recordsWrite = await RecordsWrite.create({
        signer       : Jws.createSigner(alice),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
        dataFormat   : 'application/octet-stream',
        data         : TestDataGenerator.randomBytes(10),
      });

      const validateJsonSchemaSpy = sinon.spy(Message, 'validateJsonSchema');

      await RecordsWrite.parse(recordsWrite.message);

      expect(validateJsonSchemaSpy.called).toBe(true);
    });
  });

  describe('isSignedByAuthorDelegate()', () => {
    it('should return false if the given RecordsWrite is not signed at all', async () => {
      const data = new TextEncoder().encode('any data');
      const recordsWrite = await RecordsWrite.create({
        protocol     : 'unused',
        protocolPath : 'unused',
        schema       : 'unused',
        dataFormat   : 'unused',
        data
      });

      const isSignedByAuthorDelegate = recordsWrite.isSignedByAuthorDelegate;
      expect(isSignedByAuthorDelegate).toBe(false);
    });
  });

  describe('isSignedByOwnerDelegate()', () => {
    it('should return false if the given RecordsWrite is not signed at all', async () => {
      const data = new TextEncoder().encode('any data');
      const recordsWrite = await RecordsWrite.create({
        protocol     : 'unused',
        protocolPath : 'unused',
        schema       : 'unused',
        dataFormat   : 'unused',
        data
      });

      const isSignedByOwnerDelegate = recordsWrite.isSignedByOwnerDelegate;
      expect(isSignedByOwnerDelegate).toBe(false);
    });
  });

  describe('isInitialWrite()', () => {
    it('should return false if given message is not a RecordsWrite', async () => {
      const { message }= await TestDataGenerator.generateRecordsQuery();
      const isInitialWrite = await RecordsWrite.isInitialWrite(message);
      expect(isInitialWrite).toBe(false);
    });
  });

  describe('getEntryId()', () => {
    it('should throw if the given author is undefined', async () => {
      const { message }= await TestDataGenerator.generateRecordsWrite();
      const author = undefined;
      await expect(RecordsWrite.getEntryId(author, message.descriptor)).rejects.toThrow(DwnErrorCode.RecordsWriteGetEntryIdUndefinedAuthor);
    });
  });

  describe('signAsOwner()', () => {
    it('should throw if the RecordsWrite is not signed by an author yet', async () => {
      const options = {
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        dateCreated  : '2023-07-27T10:20:30.405060Z',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
      };
      const recordsWrite = await RecordsWrite.create(options);

      expect(recordsWrite.author).toBeUndefined();
      expect(recordsWrite.signaturePayload).toBeUndefined();

      const alice = await TestDataGenerator.generateDidKeyPersona();
      await expect(recordsWrite.signAsOwner(Jws.createSigner(alice))).rejects.toThrow(DwnErrorCode.RecordsWriteSignAsOwnerUnknownAuthor);

      expect(recordsWrite.owner).toBeUndefined();
      expect(recordsWrite.ownerSignaturePayload).toBeUndefined();
    });
  });

  describe('signAsOwnerDelegate()', () => {
    it('should throw if the RecordsWrite is not signed by an author yet', async () => {
      const options = {
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        dateCreated  : '2023-07-27T10:20:30.405060Z',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
      };
      const recordsWrite = await RecordsWrite.create(options);

      expect(recordsWrite.author).toBeUndefined();
      expect(recordsWrite.signaturePayload).toBeUndefined();

      // create a delegated grant
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const scope: PermissionScope = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        protocol  : 'chat'
      };
      const ownerDelegatedGrant = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        delegated   : true, // this is a delegated grant
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        grantedTo   : bob.did,
        scope
      });

      await expect(recordsWrite.signAsOwnerDelegate(Jws.createSigner(bob), ownerDelegatedGrant.dataEncodedMessage))
        .rejects.toThrow(DwnErrorCode.RecordsWriteSignAsOwnerDelegateUnknownAuthor);

      expect(recordsWrite.owner).toBeUndefined();
      expect(recordsWrite.ownerSignaturePayload).toBeUndefined();
    });
  });

  describe('ownerSignatureSigner()', () => {
    it('should return `undefined` if owner signature is not present in the message', async () => {
      const options = {
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        dateCreated  : '2023-07-27T10:20:30.405060Z',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
      };
      const recordsWrite = await RecordsWrite.create(options);

      expect(recordsWrite.ownerSignatureSigner).toBeUndefined();
    });
  });

  describe('message', () => {
    it('should throw if attempting to access the message of a RecordsWrite that is not given authorization signature input', async () => {
      const options = {
        data         : TestDataGenerator.randomBytes(10),
        dataFormat   : 'application/json',
        dateCreated  : '2023-07-27T10:20:30.405060Z',
        recordId     : await TestDataGenerator.randomCborSha256Cid(),
        protocol     : 'http://test-protocol.xyz',
        protocolPath : 'testRecord',
      };
      const recordsWrite = await RecordsWrite.create(options);

      expect(recordsWrite.author).toBeUndefined();
      expect(recordsWrite.signaturePayload).toBeUndefined();

      expect(() => recordsWrite.message).toThrow(DwnErrorCode.RecordsWriteMissingSigner);
    });
  });

  describe('encryptSymmetricEncryptionKey()', () => {
    it('should replace encryption property by default', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const dataEncryptionKey = TestDataGenerator.randomBytes(32);
      const dataEncryptionIV = TestDataGenerator.randomBytes(12);

      const recordsWrite = await RecordsWrite.create({
        signer       : Jws.createSigner(alice),
        protocol     : 'https://example.com/protocol',
        protocolPath : 'test',
        schema       : 'https://example.com/schema',
        dataFormat   : 'application/octet-stream',
        data         : TestDataGenerator.randomBytes(100),
      });

      // First encryption — ProtocolPath
      const encryptionInput1: EncryptionInput = {
        initializationVector : dataEncryptionIV,
        key                  : dataEncryptionKey,
        authenticationTag    : TestDataGenerator.randomBytes(16),
        keyEncryptionInputs  : [{
          publicKeyId      : alice.keyId,
          publicKey        : alice.encryptionKeyPair.publicJwk,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
        }],
      };
      await recordsWrite.encryptSymmetricEncryptionKey(encryptionInput1);

      expect(recordsWrite['_message'].encryption).toBeDefined();
      expect(recordsWrite['_message'].encryption!.recipients).toHaveLength(1);
      expect(recordsWrite['_message'].encryption!.recipients[0].header.derivationScheme).toBe('protocolPath');

      // Second encryption (replace mode) — should overwrite
      const encryptionInput2: EncryptionInput = {
        initializationVector : dataEncryptionIV,
        key                  : dataEncryptionKey,
        authenticationTag    : TestDataGenerator.randomBytes(16),
        keyEncryptionInputs  : [{
          publicKeyId      : alice.keyId,
          publicKey        : alice.encryptionKeyPair.publicJwk,
          derivationScheme : KeyDerivationScheme.ProtocolContext,
        }],
      };
      await recordsWrite.encryptSymmetricEncryptionKey(encryptionInput2);

      // Should have replaced — only 1 entry with ProtocolContext scheme
      expect(recordsWrite['_message'].encryption!.recipients).toHaveLength(1);
      expect(recordsWrite['_message'].encryption!.recipients[0].header.derivationScheme).toBe('protocolContext');
    });

    it('should append recipients when append option is true', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const dataEncryptionKey = TestDataGenerator.randomBytes(32);
      const dataEncryptionIV = TestDataGenerator.randomBytes(12);

      const recordsWrite = await RecordsWrite.create({
        signer       : Jws.createSigner(alice),
        protocol     : 'https://example.com/protocol',
        protocolPath : 'test',
        schema       : 'https://example.com/schema',
        dataFormat   : 'application/octet-stream',
        data         : TestDataGenerator.randomBytes(100),
      });

      // First encryption — ProtocolPath
      const encryptionInput1: EncryptionInput = {
        initializationVector : dataEncryptionIV,
        key                  : dataEncryptionKey,
        authenticationTag    : TestDataGenerator.randomBytes(16),
        keyEncryptionInputs  : [{
          publicKeyId      : alice.keyId,
          publicKey        : alice.encryptionKeyPair.publicJwk,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
        }],
      };
      await recordsWrite.encryptSymmetricEncryptionKey(encryptionInput1);

      const originalIV = recordsWrite['_message'].encryption!.iv;
      const originalProtected = recordsWrite['_message'].encryption!.protected;

      // Second encryption with append — ProtocolContext
      const encryptionInput2: EncryptionInput = {
        initializationVector : dataEncryptionIV,
        key                  : dataEncryptionKey,
        authenticationTag    : TestDataGenerator.randomBytes(16),
        keyEncryptionInputs  : [{
          publicKeyId      : alice.keyId,
          publicKey        : alice.encryptionKeyPair.publicJwk,
          derivationScheme : KeyDerivationScheme.ProtocolContext,
        }],
      };
      await recordsWrite.encryptSymmetricEncryptionKey(encryptionInput2, { append: true });

      // Should have both entries
      const encryption = recordsWrite['_message'].encryption!;
      expect(encryption.recipients).toHaveLength(2);
      expect(encryption.recipients[0].header.derivationScheme).toBe('protocolPath');
      expect(encryption.recipients[1].header.derivationScheme).toBe('protocolContext');

      // Original IV and protected header should be preserved
      expect(encryption.iv).toBe(originalIV);
      expect(encryption.protected).toBe(originalProtected);

      // ProtocolContext entry should have derivedPublicKey
      expect(encryption.recipients[1].header.derivedPublicKey).toBeDefined();

      // Authorization was already wiped by the first (non-append) call, so
      // append mode preserves whatever state exists — which is undefined here.
      // When starting from a parsed/signed message (the signAsOwner test
      // below), authorization IS preserved by append mode.
      expect(recordsWrite['_message'].authorization).toBeUndefined();
    });

    it('should allow signAsOwner after append (reactive root-record upgrade)', async () => {
      // Simulates the cross-DWN scenario: Bob authors a record, Alice (owner)
      // appends a ProtocolContext recipient entry, then signs as owner.
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const dataEncryptionKey = TestDataGenerator.randomBytes(32);
      const dataEncryptionIV = TestDataGenerator.randomBytes(12);

      // Bob creates and signs the record
      const recordsWrite = await RecordsWrite.create({
        signer       : Jws.createSigner(bob),
        protocol     : 'https://example.com/protocol',
        protocolPath : 'thread',
        schema       : 'https://example.com/schema',
        dataFormat   : 'application/octet-stream',
        data         : TestDataGenerator.randomBytes(100),
      });

      // Bob encrypts with ProtocolPath, then re-signs
      const encryptionInput1: EncryptionInput = {
        initializationVector : dataEncryptionIV,
        key                  : dataEncryptionKey,
        authenticationTag    : TestDataGenerator.randomBytes(16),
        keyEncryptionInputs  : [{
          publicKeyId      : alice.keyId,
          publicKey        : alice.encryptionKeyPair.publicJwk,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
        }],
      };
      await recordsWrite.encryptSymmetricEncryptionKey(encryptionInput1);
      await recordsWrite.sign({ signer: Jws.createSigner(bob) });

      expect(recordsWrite.author).toBe(bob.did);
      expect(recordsWrite['_message'].authorization).toBeDefined();

      // Simulate: Alice parses Bob's message and appends ProtocolContext
      const parsed = await RecordsWrite.parse(recordsWrite.message);
      expect(parsed.author).toBe(bob.did);

      const encryptionInput2: EncryptionInput = {
        initializationVector : dataEncryptionIV,
        key                  : dataEncryptionKey,
        authenticationTag    : TestDataGenerator.randomBytes(16),
        keyEncryptionInputs  : [{
          publicKeyId      : alice.keyId,
          publicKey        : alice.encryptionKeyPair.publicJwk,
          derivationScheme : KeyDerivationScheme.ProtocolContext,
        }],
      };
      await parsed.encryptSymmetricEncryptionKey(encryptionInput2, { append: true });

      // Author and authorization should be preserved after append
      expect(parsed.author).toBe(bob.did);
      expect(parsed['_message'].authorization).toBeDefined();

      // Alice signs as owner — should NOT throw
      await parsed.signAsOwner(Jws.createSigner(alice));

      expect(parsed.owner).toBe(alice.did);
      expect(parsed['_message'].authorization!.ownerSignature).toBeDefined();

      // Both recipient entries should be present
      const encryption = parsed['_message'].encryption!;
      expect(encryption.recipients).toHaveLength(2);
      expect(encryption.recipients[0].header.derivationScheme).toBe('protocolPath');
      expect(encryption.recipients[1].header.derivationScheme).toBe('protocolContext');

      // validateIntegrity should pass — the stale encryptionCid in the
      // author's signature is allowed when ownerSignature is present
      await parsed['validateIntegrity']();
    });

    it('should throw when append is true but encryption does not exist', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const dataEncryptionKey = TestDataGenerator.randomBytes(32);
      const dataEncryptionIV = TestDataGenerator.randomBytes(12);

      const recordsWrite = await RecordsWrite.create({
        signer       : Jws.createSigner(alice),
        protocol     : 'https://example.com/protocol',
        protocolPath : 'test',
        dataFormat   : 'application/octet-stream',
        data         : TestDataGenerator.randomBytes(100),
      });

      const encryptionInput: EncryptionInput = {
        initializationVector : dataEncryptionIV,
        key                  : dataEncryptionKey,
        authenticationTag    : TestDataGenerator.randomBytes(16),
        keyEncryptionInputs  : [{
          publicKeyId      : alice.keyId,
          publicKey        : alice.encryptionKeyPair.publicJwk,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
        }],
      };

      await expect(
        recordsWrite.encryptSymmetricEncryptionKey(encryptionInput, { append: true })
      ).rejects.toThrow(DwnErrorCode.RecordsWriteMissingEncryption);
    });
  });
});
