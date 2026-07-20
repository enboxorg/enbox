import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type {
  DataStore,
  MessageStore,
  ProtocolDefinition,
  ProtocolRuleSet,
  ProtocolsConfigureDescriptor,
  ResumableTaskStore,
} from '../../src/index.js';
import type { GenerateProtocolsConfigureOutput, GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';

import dexProtocolDefinition from '../vectors/protocol-definitions/dex.json' with { type: 'json' };
import minimalProtocolDefinition from '../vectors/protocol-definitions/minimal.json' with { type: 'json' };
import sinon from 'sinon';

import { EncryptionControlDeliveryRecipientAuthority } from '../../src/types/encryption-types.js';
import { GeneralJwsBuilder } from '../../src/jose/jws/general/builder.js';
import { lexicographicalCompare } from '../../src/utils/string.js';
import { Message } from '../../src/core/message.js';
import { ProtocolAction } from '../../src/types/protocols-types.js';
import { ProtocolsConfigureHandler } from '../../src/handlers/protocols-configure.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { Time } from '../../src/utils/time.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, DataStream, Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Encryption, getRuleSetAtPath, Jws, KeyAgreementAlgorithm, KeyDerivationScheme, PermissionGrant, PermissionsProtocol, Protocols, RecordsDelete, RecordsRead, RecordsWrite } from '../../src/index.js';
import { createAudienceControlWrite, createDeliveryControlWrite, installEncryptedProtocol, processControlWrite } from '../utils/encryption-control-test-utils.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

async function generateEncryptedRecordsWrite(params: {
  author: Persona;
  definition: ProtocolDefinition;
  protocolPath: string;
  timestamp: string;
}): Promise<GenerateRecordsWriteOutput> {
  const dataEncryptionKey = TestDataGenerator.randomBytes(32);
  const initializationVector = TestDataGenerator.randomBytes(16);
  const ciphertext = await Encryption.encrypt(
    ContentEncryptionAlgorithm.A256CTR,
    dataEncryptionKey,
    initializationVector,
    Encoder.stringToBytes('secret'),
  );
  const publicKey = getRuleSetAtPath(params.protocolPath, params.definition.structure)!.$keyAgreement!.publicKeyJwk;
  const typeName = params.protocolPath.split('/').at(-1)!;
  const protocolType = params.definition.types[typeName];

  return TestDataGenerator.generateRecordsWrite({
    author          : params.author,
    data            : ciphertext,
    dataFormat      : protocolType.dataFormats?.[0],
    dateCreated     : params.timestamp,
    encryptionInput : {
      initializationVector,
      key                 : dataEncryptionKey,
      keyEncryptionInputs : [{
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        keyId            : await Encryption.getKeyId(publicKey),
        publicKey,
      }],
    },
    messageTimestamp : params.timestamp,
    protocol         : params.definition.protocol,
    protocolPath     : params.protocolPath,
    schema           : protocolType.schema,
  });
}

export function testProtocolsConfigureHandler(): void {
  describe('ProtocolsConfigureHandler.handle()', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    describe('functional tests', () => {

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      beforeAll(async () => {
        didResolver = new UniversalResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        resumableTaskStore = stores.resumableTaskStore;
        eventLog = TestEventLog.get();

        dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, resumableTaskStore });
      });

      beforeEach(async () => {
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('should allow a protocol definition with schema or dataFormat omitted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition = minimalProtocolDefinition;
        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(reply.status.code).toBe(202);
      });

      it('should return 400 if more than 1 signature is provided in `authorization`', async () => {
        const { author, message, protocolsConfigure } = await TestDataGenerator.generateProtocolsConfigure();
        const tenant = author.did;

        // intentionally create more than one signature, which is not allowed
        const extraRandomPersona = await TestDataGenerator.generatePersona();
        const signer1 = Jws.createSigner(author);
        const signer2 = Jws.createSigner(extraRandomPersona);

        const signaturePayloadBytes = Encoder.objectToBytes(protocolsConfigure.signaturePayload!);

        const jwsBuilder = await GeneralJwsBuilder.create(signaturePayloadBytes, [signer1, signer2]);
        message.authorization = { signature: jwsBuilder.getJws() };

        TestStubGenerator.stubDidResolver(didResolver, [author]);

        const reply = await dwn.processMessage(tenant, message);

        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain('expected no more than 1 signature');
      });

      it('should return 401 if auth fails', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateProtocolsConfigure({ author: alice });

        // use a bad signature to fail authentication
        const badSignature = await TestDataGenerator.randomSignatureString();
        message.authorization.signature.signatures[0].signature = badSignature;

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(401);
        expect(reply.status.detail).toContain(DwnErrorCode.GeneralJwsVerifierInvalidSignature);
      });

      it('should store all protocol versions and query should only return the latest', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition = minimalProtocolDefinition;

        const oldProtocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        await Time.minimalSleep();
        const middleProtocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        // first ProtocolsConfigure
        const reply1 = await dwn.processMessage(alice.did, middleProtocolsConfigure.message);
        expect(reply1.status.code).toBe(202);

        // older messages are also accepted (stored as historical versions)
        const reply2 = await dwn.processMessage(alice.did, oldProtocolsConfigure.message);
        expect(reply2.status.code).toBe(202);

        // newer message is also accepted and becomes the latest
        const newProtocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const reply3 = await dwn.processMessage(alice.did, newProtocolsConfigure.message);
        expect(reply3.status.code).toBe(202);

        // only the newest protocol should be returned by query (ProtocolsQuery returns only latest)
        const queryMessageData = await TestDataGenerator.generateProtocolsQuery({
          author : alice,
          filter : { protocol: protocolDefinition.protocol }
        });
        const queryReply = await dwn.processMessage(alice.did, queryMessageData.message);

        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries).toHaveLength(1);
      });

      it('should reject an encryption-policy change for a used path but allow it for an unused path', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/encryption-policy';
        const initialDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            public : { dataFormats: ['text/plain'] },
            unused : { dataFormats: ['text/plain'] },
          },
          structure: {
            public : {},
            unused : {},
          },
        };
        const initialConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-01-01T00:00:00.000000Z',
          protocolDefinition : initialDefinition,
        });
        expect((await dwn.processMessage(alice.did, initialConfigure.message)).status.code).toBe(202);

        const publicWrite = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          data             : Encoder.stringToBytes('public'),
          dataFormat       : 'text/plain',
          dateCreated      : '2025-01-02T00:00:00.000000Z',
          messageTimestamp : '2025-01-02T00:00:00.000000Z',
          protocol,
          protocolPath     : 'public',
        });
        expect((await dwn.processMessage(
          alice.did,
          publicWrite.message,
          { dataStream: publicWrite.dataStream },
        )).status.code).toBe(202);

        const changedUsedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys({
          ...initialDefinition,
          types: {
            public : { dataFormats: ['text/plain'], encryptionRequired: true },
            unused : { dataFormats: ['text/plain'], encryptionRequired: true },
          },
        }, TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk));
        const changedUsedConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-01-03T00:00:00.000000Z',
          protocolDefinition : changedUsedDefinition,
        });
        const changedUsedReply = await dwn.processMessage(alice.did, changedUsedConfigure.message);
        expect(changedUsedReply.status.code).toBe(400);
        expect(changedUsedReply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureEncryptionPolicyImmutable);

        const changedUnusedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys({
          ...initialDefinition,
          types: {
            public : { dataFormats: ['text/plain'] },
            unused : { dataFormats: ['text/plain'], encryptionRequired: true },
          },
        }, TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk));
        const changedUnusedConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-01-04T00:00:00.000000Z',
          protocolDefinition : changedUnusedDefinition,
        });
        const querySpy = sinon.spy(messageStore, 'query');
        expect((await dwn.processMessage(alice.did, changedUnusedConfigure.message)).status.code).toBe(202);

        const recordsWriteScans = querySpy.getCalls().filter((call): boolean => {
          const filters = call.args[1] as Array<Record<string, unknown>>;
          return filters.length === 1 &&
            filters[0].interface === DwnInterfaceName.Records &&
            filters[0].method === DwnMethodName.Write &&
            filters[0].protocol === protocol;
        });
        expect(recordsWriteScans).toHaveLength(1);
      });

      it('should reject removing encryption from a path with existing encrypted records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/encryption-removal';
        const authoredDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            secret: { dataFormats: ['text/plain'], encryptionRequired: true },
          },
          structure: {
            secret: {},
          },
        };
        const encryptedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
          authoredDefinition,
          TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk),
        );
        const initialConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-02-01T00:00:00.000000Z',
          protocolDefinition : encryptedDefinition,
        });
        expect((await dwn.processMessage(alice.did, initialConfigure.message)).status.code).toBe(202);

        const encryptedWrite = await generateEncryptedRecordsWrite({
          author       : alice,
          definition   : encryptedDefinition,
          protocolPath : 'secret',
          timestamp    : '2025-02-02T00:00:00.000000Z',
        });
        expect((await dwn.processMessage(
          alice.did,
          encryptedWrite.message,
          { dataStream: encryptedWrite.dataStream },
        )).status.code).toBe(202);

        const plaintextConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-02-03T00:00:00.000000Z',
          protocolDefinition : {
            ...authoredDefinition,
            types: { secret: { dataFormats: ['text/plain'] } },
          },
        });
        const plaintextReply = await dwn.processMessage(alice.did, plaintextConfigure.message);
        expect(plaintextReply.status.code).toBe(400);
        expect(plaintextReply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureEncryptionPolicyImmutable);
      });

      it('should allow removing an encrypted type and preserve its historical records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/encrypted-type-removal';
        const authoredDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            public : { dataFormats: ['text/plain'] },
            secret : { dataFormats: ['text/plain'], encryptionRequired: true },
          },
          structure: {
            public : {},
            secret : {},
          },
        };
        const encryptedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
          authoredDefinition,
          TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk),
        );
        const initialConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-03-01T00:00:00.000000Z',
          protocolDefinition : encryptedDefinition,
        });
        expect((await dwn.processMessage(alice.did, initialConfigure.message)).status.code).toBe(202);

        const encryptedWrite = await generateEncryptedRecordsWrite({
          author       : alice,
          definition   : encryptedDefinition,
          protocolPath : 'secret',
          timestamp    : '2025-03-02T00:00:00.000000Z',
        });
        expect((await dwn.processMessage(
          alice.did,
          encryptedWrite.message,
          { dataStream: encryptedWrite.dataStream },
        )).status.code).toBe(202);

        const typeRemovedConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-03-03T00:00:00.000000Z',
          protocolDefinition : {
            protocol,
            published : true,
            types     : { public: { dataFormats: ['text/plain'] } },
            structure : { public: {} },
          },
        });
        expect((await dwn.processMessage(alice.did, typeRemovedConfigure.message)).status.code).toBe(202);

        const removedRecord = await messageStore.query(alice.did, [{ recordId: encryptedWrite.message.recordId }]);
        expect(removedRecord.messages).toHaveLength(1);
      });

      it('should reject changing a policy imported by a composing protocol with existing records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const referencedProtocol = 'http://config-validity.example/referenced-encryption-policy';
        const composingProtocol = 'http://config-validity.example/composing-encryption-policy';
        const referencedDefinition: ProtocolDefinition = {
          protocol  : referencedProtocol,
          published : true,
          types     : { thread: { dataFormats: ['text/plain'] } },
          structure : {
            thread: {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Create] }],
            },
          },
        };
        const referencedConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-04-01T00:00:00.000000Z',
          protocolDefinition : referencedDefinition,
        });
        expect((await dwn.processMessage(alice.did, referencedConfigure.message)).status.code).toBe(202);

        const composingDefinition: ProtocolDefinition = {
          protocol  : composingProtocol,
          published : true,
          types     : { comment: { dataFormats: ['text/plain'] } },
          uses      : { referenced: referencedProtocol },
          structure : {
            thread: {
              $ref    : 'referenced:thread',
              comment : {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              },
            },
          },
        };
        const composingConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-04-02T00:00:00.000000Z',
          protocolDefinition : composingDefinition,
        });
        expect((await dwn.processMessage(alice.did, composingConfigure.message)).status.code).toBe(202);

        const composedWrite = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          data             : Encoder.stringToBytes('composed thread'),
          dataFormat       : 'text/plain',
          dateCreated      : '2025-04-03T00:00:00.000000Z',
          messageTimestamp : '2025-04-03T00:00:00.000000Z',
          protocol         : composingProtocol,
          protocolPath     : 'thread',
        });
        expect((await dwn.processMessage(
          alice.did,
          composedWrite.message,
          { dataStream: composedWrite.dataStream },
        )).status.code).toBe(202);

        const encryptedReferencedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys({
          ...referencedDefinition,
          types: { thread: { dataFormats: ['text/plain'], encryptionRequired: true } },
        }, TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk));
        const changedReferencedConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          messageTimestamp   : '2025-04-04T00:00:00.000000Z',
          protocolDefinition : encryptedReferencedDefinition,
        });
        const changedReferencedReply = await dwn.processMessage(alice.did, changedReferencedConfigure.message);
        expect(changedReferencedReply.status.code).toBe(400);
        expect(changedReferencedReply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureEncryptionPolicyImmutable);
        expect(changedReferencedReply.status.detail).toContain(`imported by protocol '${composingProtocol}'`);
      });

      it('should store all protocol versions with identical timestamps and query should only return the newest (by CID tiebreak)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Alter each protocol slightly to create lexicographic difference between them
        const protocolDefinition1 = {
          ...minimalProtocolDefinition,
          types: { ...minimalProtocolDefinition.types, foo1: { dataFormats: ['bar1'] } }
        };
        const protocolDefinition2 = {
          ...minimalProtocolDefinition,
          types: { ...minimalProtocolDefinition.types, foo2: { dataFormats: ['bar2'] } }
        };
        const protocolDefinition3 = {
          ...minimalProtocolDefinition,
          types: { ...minimalProtocolDefinition.types, foo3: { dataFormats: ['bar3'] } }
        };

        // Create three `ProtocolsConfigure` with identical timestamp
        const messageData1 = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : protocolDefinition1
        });
        const messageData2 = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : protocolDefinition2,
          messageTimestamp   : messageData1.message.descriptor.messageTimestamp
        });
        const messageData3 = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : protocolDefinition3,
          messageTimestamp   : messageData1.message.descriptor.messageTimestamp
        });

        const messageDataWithCid: (GenerateProtocolsConfigureOutput & { cid: string })[] = [];
        for (const messageData of [messageData1, messageData2, messageData3]) {
          const cid = await Message.getCid(messageData.message);
          messageDataWithCid.push({ cid, ...messageData });
        }

        // sort the message in lexicographic order
        const [
          lowestProtocolsConfigure,
          middleProtocolsConfigure,
          highestProtocolsConfigure
        ]: GenerateProtocolsConfigureOutput[]
        = messageDataWithCid.sort((messageDataA, messageDataB) => { return lexicographicalCompare(messageDataA.cid, messageDataB.cid); });

        // write the protocol with the middle lexicographic value
        const reply1 = await dwn.processMessage(alice.did, middleProtocolsConfigure.message);
        expect(reply1.status.code).toBe(202);

        // all versions are accepted (stored as historical versions)
        const reply2 = await dwn.processMessage(alice.did, lowestProtocolsConfigure.message);
        expect(reply2.status.code).toBe(202);

        // highest lexicographic value is also accepted and becomes the latest
        const reply3 = await dwn.processMessage(alice.did, highestProtocolsConfigure.message);
        expect(reply3.status.code).toBe(202);

        // query should only return the latest protocol definition (highest by CID tiebreak)
        const queryMessageData = await TestDataGenerator.generateProtocolsQuery({
          author : alice,
          filter : { protocol: protocolDefinition1.protocol }
        });
        const queryReply = await dwn.processMessage(alice.did, queryMessageData.message);

        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries).toHaveLength(1);
      });

      it('should demote stored protocol versions without re-validating historical definitions', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/historical-reindex';

        const validHistoricalDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            thread      : { dataFormats: ['application/json'] },
            message     : { dataFormats: ['application/json'] },
            participant : { dataFormats: ['application/json'] }
          },
          structure: {
            thread: {
              message: {
                participant: { $role: true }
              }
            }
          }
        };

        const invalidHistoricalDefinition: ProtocolDefinition = {
          ...validHistoricalDefinition,
          structure: {
            thread: {
              $actions: [
                { role: 'thread/message/participant', can: [ProtocolAction.Create] }
              ],
              message: {
                participant: { $role: true }
              }
            }
          }
        };

        const historicalConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : validHistoricalDefinition,
          messageTimestamp   : '2025-05-01T00:00:00.000000Z'
        });
        const historicalIndexes = ProtocolsConfigureHandler.constructIndexes(historicalConfig.protocolsConfigure, true);
        historicalConfig.message.descriptor.definition = invalidHistoricalDefinition;
        await messageStore.put(alice.did, historicalConfig.message, historicalIndexes);

        const newConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : validHistoricalDefinition,
          messageTimestamp   : '2025-05-02T00:00:00.000000Z'
        });
        const reply = await dwn.processMessage(alice.did, newConfig.message);
        expect(reply.status.code).toBe(202);

        const newConfigCid = await Message.getCid(newConfig.message);
        const latestConfigs = await messageStore.query(alice.did, [{
          interface         : DwnInterfaceName.Protocols,
          method            : DwnMethodName.Configure,
          protocol,
          isLatestBaseState : true
        }]);
        expect(latestConfigs.messages).toHaveLength(1);
        expect(await Message.getCid(latestConfigs.messages[0])).toBe(newConfigCid);

        const historicalConfigs = await messageStore.query(alice.did, [{
          interface         : DwnInterfaceName.Protocols,
          method            : DwnMethodName.Configure,
          protocol,
          isLatestBaseState : false
        }]);
        expect(historicalConfigs.messages).toHaveLength(1);
        expect(await Message.getCid(historicalConfigs.messages[0])).toBe(await Message.getCid(historicalConfig.message));
      });

      it('should purge records invalidated by a newly learned protocol config', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/protocol';
        const openDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            post: {
              schema      : 'post',
              dataFormats : ['application/json']
            }
          },
          structure: {
            post: {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
            }
          }
        };
        const stricterDefinition: ProtocolDefinition = {
          ...openDefinition,
          structure: {
            post: {}
          }
        };

        const openConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : openDefinition,
          messageTimestamp   : '2025-01-01T00:00:00.000000Z'
        });
        const openConfigReply = await dwn.processMessage(alice.did, openConfig.message);
        expect(openConfigReply.status.code).toBe(202);

        const oldBobRecord = await TestDataGenerator.generateRecordsWrite({
          author           : bob,
          protocol,
          protocolPath     : 'post',
          schema           : 'post',
          dataFormat       : 'application/json',
          dateCreated      : '2025-01-01T12:00:00.000000Z',
          messageTimestamp : '2025-01-01T12:00:00.000000Z'
        });
        const invalidBobRecord = await TestDataGenerator.generateRecordsWrite({
          author           : bob,
          protocol,
          protocolPath     : 'post',
          schema           : 'post',
          dataFormat       : 'application/json',
          dateCreated      : '2025-01-03T00:00:00.000000Z',
          messageTimestamp : '2025-01-03T00:00:00.000000Z'
        });
        const tenantRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'post',
          schema           : 'post',
          dataFormat       : 'application/json',
          dateCreated      : '2025-01-03T12:00:00.000000Z',
          messageTimestamp : '2025-01-03T12:00:00.000000Z'
        });

        const oldBobReply = await dwn.processMessage(alice.did, oldBobRecord.message, { dataStream: oldBobRecord.dataStream });
        expect(oldBobReply.status.code).toBe(202);
        const invalidBobReply = await dwn.processMessage(alice.did, invalidBobRecord.message, { dataStream: invalidBobRecord.dataStream });
        expect(invalidBobReply.status.code).toBe(202);
        const tenantRecordReply = await dwn.processMessage(alice.did, tenantRecord.message, { dataStream: tenantRecord.dataStream });
        expect(tenantRecordReply.status.code).toBe(202);

        const stricterConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : stricterDefinition,
          messageTimestamp   : '2025-01-02T00:00:00.000000Z'
        });
        const stricterConfigReply = await dwn.processMessage(alice.did, stricterConfig.message);
        expect(stricterConfigReply.status.code).toBe(202);

        const oldBobMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : oldBobRecord.message.recordId
        }]);
        expect(oldBobMessages.messages.length).toBeGreaterThan(0);

        const invalidBobMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : invalidBobRecord.message.recordId
        }]);
        expect(invalidBobMessages.messages).toHaveLength(0);

        const tenantMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : tenantRecord.message.recordId
        }]);
        expect(tenantMessages.messages.length).toBeGreaterThan(0);
      });

      it('should preserve grant-authorized records if the grant is later deleted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/grant-delete';
        const openDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : { post: { schema: 'post', dataFormats: ['application/json'] } },
          structure : {
            post: {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
            }
          }
        };
        const grantOnlyDefinition: ProtocolDefinition = {
          ...openDefinition,
          structure: { post: {} }
        };

        const openConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : openDefinition,
          messageTimestamp   : '2025-02-01T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, openConfig.message)).status.code).toBe(202);

        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateGranted : '2025-02-01T12:00:00.000000Z',
          dateExpires : '2025-02-10T00:00:00.000000Z',
          scope       : {
            interface    : DwnInterfaceName.Records,
            method       : DwnMethodName.Write,
            protocol,
            protocolPath : 'post'
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        const bobRecord = await TestDataGenerator.generateRecordsWrite({
          author            : bob,
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          protocol,
          protocolPath      : 'post',
          schema            : 'post',
          dataFormat        : 'application/json',
          dateCreated       : '2025-02-03T00:00:00.000000Z',
          messageTimestamp  : '2025-02-03T00:00:00.000000Z'
        });
        const bobReply = await dwn.processMessage(alice.did, bobRecord.message, { dataStream: bobRecord.dataStream });
        expect(bobReply.status.code).toBe(202);

        const grantDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : permissionGrant.recordsWrite.message.recordId
        });
        expect((await dwn.processMessage(alice.did, grantDelete.message)).status.code).toBe(202);

        const grantOnlyConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : grantOnlyDefinition,
          messageTimestamp   : '2025-02-02T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, grantOnlyConfig.message)).status.code).toBe(202);

        const { messages } = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : bobRecord.message.recordId
        }]);
        expect(messages.length).toBeGreaterThan(0);
      });

      it('should preserve child records if the parent is later deleted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/parent-delete';
        const definition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            post    : { schema: 'post', dataFormats: ['application/json'] },
            comment : { schema: 'comment', dataFormats: ['application/json'] }
          },
          structure: {
            post: {
              $actions : [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read, ProtocolAction.Delete] }],
              comment  : {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
              }
            }
          }
        };

        const openConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : definition,
          messageTimestamp   : '2025-03-01T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, openConfig.message)).status.code).toBe(202);

        const post = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'post',
          schema           : 'post',
          dataFormat       : 'application/json',
          dateCreated      : '2025-03-03T00:00:00.000000Z',
          messageTimestamp : '2025-03-03T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, post.message, { dataStream: post.dataStream })).status.code).toBe(202);

        const comment = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'post/comment',
          schema           : 'comment',
          dataFormat       : 'application/json',
          parentContextId  : post.message.contextId,
          dateCreated      : '2025-03-03T12:00:00.000000Z',
          messageTimestamp : '2025-03-03T12:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, comment.message, { dataStream: comment.dataStream })).status.code).toBe(202);

        const deletePost = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : post.message.recordId
        });
        expect((await dwn.processMessage(alice.did, deletePost.message)).status.code).toBe(202);

        const laterConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : definition,
          messageTimestamp   : '2025-03-02T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, laterConfig.message)).status.code).toBe(202);

        const { messages } = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : comment.message.recordId
        }]);
        expect(messages.length).toBeGreaterThan(0);
      });

      it('should preserve role-authorized records if the role is later deleted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/role-delete';
        const definition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            friend : { schema: 'friend', dataFormats: ['application/json'] },
            chat   : { schema: 'chat', dataFormats: ['application/json'] }
          },
          structure: {
            friend: {
              $role: true
            },
            chat: {
              $actions: [
                { role: 'friend', can: [ProtocolAction.Create, ProtocolAction.Read] }
              ]
            }
          }
        };

        const openConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : definition,
          messageTimestamp   : '2025-04-01T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, openConfig.message)).status.code).toBe(202);

        const role = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          recipient        : bob.did,
          protocol,
          protocolPath     : 'friend',
          schema           : 'friend',
          dataFormat       : 'application/json',
          dateCreated      : '2025-04-01T12:00:00.000000Z',
          messageTimestamp : '2025-04-01T12:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, role.message, { dataStream: role.dataStream })).status.code).toBe(202);

        const chat = await TestDataGenerator.generateRecordsWrite({
          author           : bob,
          protocol,
          protocolPath     : 'chat',
          protocolRole     : 'friend',
          schema           : 'chat',
          dataFormat       : 'application/json',
          dateCreated      : '2025-04-03T00:00:00.000000Z',
          messageTimestamp : '2025-04-03T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, chat.message, { dataStream: chat.dataStream })).status.code).toBe(202);

        const deleteRole = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : role.message.recordId
        });
        expect((await dwn.processMessage(alice.did, deleteRole.message)).status.code).toBe(202);

        const laterConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : definition,
          messageTimestamp   : '2025-04-02T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, laterConfig.message)).status.code).toBe(202);

        const { messages } = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : chat.message.recordId
        }]);
        expect(messages.length).toBeGreaterThan(0);
      });

      it('should not cascade-purge valid descendants of an invalid parent', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/no-cascade';
        const openDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            post    : { schema: 'post', dataFormats: ['application/json'] },
            comment : { schema: 'comment', dataFormats: ['application/json'] }
          },
          structure: {
            post: {
              $actions : [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              comment  : {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
              }
            }
          }
        };
        const stricterDefinition: ProtocolDefinition = {
          ...openDefinition,
          structure: {
            post: {
              comment: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
              }
            }
          }
        };

        const openConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : openDefinition,
          messageTimestamp   : '2025-05-01T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, openConfig.message)).status.code).toBe(202);

        const post = await TestDataGenerator.generateRecordsWrite({
          author           : bob,
          protocol,
          protocolPath     : 'post',
          schema           : 'post',
          dataFormat       : 'application/json',
          dateCreated      : '2025-05-03T00:00:00.000000Z',
          messageTimestamp : '2025-05-03T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, post.message, { dataStream: post.dataStream })).status.code).toBe(202);

        const comment = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'post/comment',
          schema           : 'comment',
          dataFormat       : 'application/json',
          parentContextId  : post.message.contextId,
          dateCreated      : '2025-05-03T12:00:00.000000Z',
          messageTimestamp : '2025-05-03T12:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, comment.message, { dataStream: comment.dataStream })).status.code).toBe(202);

        const stricterConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : stricterDefinition,
          messageTimestamp   : '2025-05-02T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, stricterConfig.message)).status.code).toBe(202);

        const postMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : post.message.recordId
        }]);
        expect(postMessages.messages).toHaveLength(0);

        const commentMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : comment.message.recordId
        }]);
        expect(commentMessages.messages.length).toBeGreaterThan(0);
      });

      it('should preserve encryption control records on a same-protocol config upgrade', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/control-record-upgrade';
        const initialDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            member : { schema: 'http://member-schema', dataFormats: ['application/json'] },
            post   : { schema: 'post', dataFormats: ['application/json'] }
          },
          structure: {
            member : { $role: true },
            post   : {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
            }
          }
        };

        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, initialDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;

        // provision the role-audience key and its delivery to bob, the reserved-path records
        // the config-history sweep must never judge against the app definition's structure
        const audience = await createAudienceControlWrite({
          author   : alice,
          protocol,
          rolePath : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const roleRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          data         : Encoder.stringToBytes('bob is a member'),
          dataFormat   : 'application/json',
          protocol,
          protocolPath : 'member',
          recipient    : bob.did,
          schema       : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, roleRecord.message, { dataStream: roleRecord.dataStream })).status.code).toBe(202);

        const delivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          protocol,
          recipient          : bob.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, delivery);

        // a routine policy tightening on the same protocol URI
        const upgradedDefinition: ProtocolDefinition = {
          ...initialDefinition,
          structure: {
            member : { $role: true },
            post   : {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Read] }]
            }
          }
        };
        await installEncryptedProtocol(dwn, alice, upgradedDefinition);

        const audienceMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : audience.recordsWrite.message.recordId
        }]);
        expect(audienceMessages.messages.length).toBeGreaterThan(0);

        const deliveryMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : delivery.recordsWrite.message.recordId
        }]);
        expect(deliveryMessages.messages.length).toBeGreaterThan(0);
      });

      it('should preserve encryption control records while purging records invalidated by a newly learned config', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/control-record-reconcile';
        const openDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            member : { schema: 'http://member-schema', dataFormats: ['application/json'] },
            post   : { schema: 'post', dataFormats: ['application/json'] }
          },
          structure: {
            member : { $role: true },
            post   : {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
            }
          }
        };
        const stricterDefinition: ProtocolDefinition = {
          ...openDefinition,
          structure: {
            member : { $role: true },
            post   : {}
          }
        };

        const keyDeriver = TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk);
        const encryptedOpenDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(openDefinition, keyDeriver);
        const openConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedOpenDefinition,
          messageTimestamp   : '2025-01-01T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, openConfig.message)).status.code).toBe(202);

        const roleRuleSet = encryptedOpenDefinition.structure.member as ProtocolRuleSet;
        const audience = await createAudienceControlWrite({
          author   : alice,
          protocol,
          rolePath : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const roleRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          data         : Encoder.stringToBytes('bob is a member'),
          dataFormat   : 'application/json',
          protocol,
          protocolPath : 'member',
          recipient    : bob.did,
          schema       : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, roleRecord.message, { dataStream: roleRecord.dataStream })).status.code).toBe(202);

        const delivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          protocol,
          recipient          : bob.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, delivery);

        // valid under the open config known at admission time; invalidated once the
        // back-dated stricter config is learned
        const invalidBobRecord = await TestDataGenerator.generateRecordsWrite({
          author           : bob,
          protocol,
          protocolPath     : 'post',
          schema           : 'post',
          dataFormat       : 'application/json',
          dateCreated      : '2025-01-03T00:00:00.000000Z',
          messageTimestamp : '2025-01-03T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, invalidBobRecord.message, { dataStream: invalidBobRecord.dataStream })).status.code).toBe(202);

        const encryptedStricterDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(stricterDefinition, keyDeriver);
        const stricterConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedStricterDefinition,
          messageTimestamp   : '2025-01-02T00:00:00.000000Z'
        });
        expect((await dwn.processMessage(alice.did, stricterConfig.message)).status.code).toBe(202);

        const invalidBobMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : invalidBobRecord.message.recordId
        }]);
        expect(invalidBobMessages.messages).toHaveLength(0);

        const audienceMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : audience.recordsWrite.message.recordId
        }]);
        expect(audienceMessages.messages.length).toBeGreaterThan(0);

        const deliveryMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : delivery.recordsWrite.message.recordId
        }]);
        expect(deliveryMessages.messages.length).toBeGreaterThan(0);
      });

      it('should purge encryption control records whose role path is removed by a config upgrade', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol = 'http://config-validity.example/control-record-role-removed';
        const initialDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            member : { schema: 'http://member-schema', dataFormats: ['application/json'] },
            post   : { schema: 'post', dataFormats: ['application/json'] }
          },
          structure: {
            member : { $role: true },
            post   : {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
            }
          }
        };

        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, initialDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;

        const audience = await createAudienceControlWrite({
          author   : alice,
          protocol,
          rolePath : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const roleRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          data         : Encoder.stringToBytes('bob is a member'),
          dataFormat   : 'application/json',
          protocol,
          protocolPath : 'member',
          recipient    : bob.did,
          schema       : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, roleRecord.message, { dataStream: roleRecord.dataStream })).status.code).toBe(202);

        const delivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          protocol,
          recipient          : bob.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, delivery);

        // the upgrade removes the `member` role entirely — the control records it anchored
        // are stale key material with nothing left to provision
        const roleRemovedDefinition: ProtocolDefinition = {
          ...initialDefinition,
          structure: {
            member : {},
            post   : {
              $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }]
            }
          }
        };
        await installEncryptedProtocol(dwn, alice, roleRemovedDefinition);

        const audienceMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : audience.recordsWrite.message.recordId
        }]);
        expect(audienceMessages.messages).toHaveLength(0);

        const deliveryMessages = await messageStore.query(alice.did, [{
          interface : DwnInterfaceName.Records,
          recordId  : delivery.recordsWrite.message.recordId
        }]);
        expect(deliveryMessages.messages).toHaveLength(0);
      });

      it('should reject a control record invalid under newly learned governing history regardless of config arrival order', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/control-record-history-order';
        const roleDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role    : true,
              $actions : [{ who: 'anyone', can: [ProtocolAction.Create] }],
            },
          },
        };
        const keyDeriver = TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk);
        const encryptedRoleDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(roleDefinition, keyDeriver);
        const encryptedMissingDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys({
          ...roleDefinition,
          structure: { member: {} },
        }, keyDeriver);
        const config1 = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedRoleDefinition,
          messageTimestamp   : '2025-01-01T00:00:00.000000Z',
        });
        const config2 = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedMissingDefinition,
          messageTimestamp   : '2025-01-02T00:00:00.000000Z',
        });
        const config4 = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedRoleDefinition,
          messageTimestamp   : '2025-01-04T00:00:00.000000Z',
        });
        const audience = await createAudienceControlWrite({
          author           : bob,
          dateCreated      : '2025-01-03T00:00:00.000000Z',
          messageTimestamp : '2025-01-03T00:00:00.000000Z',
          protocol,
          rolePath         : 'member',
          roleRuleSet      : encryptedRoleDefinition.structure.member as ProtocolRuleSet,
        });

        for (const config of [config1, config4]) {
          expect((await dwn.processMessage(alice.did, config.message)).status.code).toBe(202);
        }
        await processControlWrite(dwn, alice.did, audience);
        expect((await dwn.processMessage(alice.did, config2.message)).status.code).toBe(202);

        const repaired = await messageStore.query(alice.did, [{ recordId: audience.recordsWrite.message.recordId }]);
        expect(repaired.messages).toHaveLength(0);

        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
        for (const config of [config1, config2, config4]) {
          expect((await dwn.processMessage(alice.did, config.message)).status.code).toBe(202);
        }
        const rejected = await dwn.processMessage(alice.did, audience.recordsWrite.message, {
          dataStream: DataStream.fromBytes(audience.dataBytes),
        });
        expect(rejected.status.code).toBe(400);
        expect(rejected.status.detail).toContain(DwnErrorCode.EncryptionControlValidateAudienceRolePathInvalid);
      });

      it('should purge a control record disallowed by a newly learned governing create policy', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/control-record-history-action';
        const openDefinition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role    : true,
              $actions : [{ who: 'anyone', can: [ProtocolAction.Create] }],
            },
          },
        };
        const closedDefinition: ProtocolDefinition = {
          ...openDefinition,
          structure: { member: { $role: true } },
        };
        const keyDeriver = TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk);
        const encryptedOpenDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(openDefinition, keyDeriver);
        const encryptedClosedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(closedDefinition, keyDeriver);

        for (const [definition, messageTimestamp] of [
          [encryptedOpenDefinition, '2025-02-01T00:00:00.000000Z'],
          [encryptedOpenDefinition, '2025-02-04T00:00:00.000000Z'],
        ] as const) {
          const config = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : definition,
            messageTimestamp,
          });
          expect((await dwn.processMessage(alice.did, config.message)).status.code).toBe(202);
        }

        const audience = await createAudienceControlWrite({
          author           : bob,
          dateCreated      : '2025-02-03T00:00:00.000000Z',
          messageTimestamp : '2025-02-03T00:00:00.000000Z',
          protocol,
          rolePath         : 'member',
          roleRuleSet      : encryptedOpenDefinition.structure.member as ProtocolRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const closedConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedClosedDefinition,
          messageTimestamp   : '2025-02-02T00:00:00.000000Z',
        });
        expect((await dwn.processMessage(alice.did, closedConfig.message)).status.code).toBe(202);

        const repaired = await messageStore.query(alice.did, [{ recordId: audience.recordsWrite.message.recordId }]);
        expect(repaired.messages).toHaveLength(0);
      });

      it('should purge an audience sealed to a key superseded by newly learned governing history', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/control-record-history-key';
        const definition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const aliceKeyDeriver = TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk);
        const bobKeyDeriver = TestDataGenerator.createProtocolPathKeyDeriver(bob.keyId, bob.encryptionKeyPair.privateJwk);
        const aliceKeyDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(definition, aliceKeyDeriver);
        const bobKeyDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(definition, bobKeyDeriver);

        for (const messageTimestamp of ['2025-03-01T00:00:00.000000Z', '2025-03-04T00:00:00.000000Z']) {
          const config = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : aliceKeyDefinition,
            messageTimestamp,
          });
          expect((await dwn.processMessage(alice.did, config.message)).status.code).toBe(202);
        }

        const audience = await createAudienceControlWrite({
          author           : alice,
          dateCreated      : '2025-03-03T00:00:00.000000Z',
          messageTimestamp : '2025-03-03T00:00:00.000000Z',
          protocol,
          rolePath         : 'member',
          roleRuleSet      : aliceKeyDefinition.structure.member as ProtocolRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const governingConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : bobKeyDefinition,
          messageTimestamp   : '2025-03-02T00:00:00.000000Z',
        });
        expect((await dwn.processMessage(alice.did, governingConfig.message)).status.code).toBe(202);

        const repaired = await messageStore.query(alice.did, [{ recordId: audience.recordsWrite.message.recordId }]);
        expect(repaired.messages).toHaveLength(0);
      });

      it('should retain historically valid controls when the newest role temporarily lacks key agreement', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocol = 'http://config-validity.example/control-record-current-key-missing';
        const definition: ProtocolDefinition = {
          protocol,
          published : true,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const keyDeriver = TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk);
        const encryptedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(definition, keyDeriver);
        const encryptedConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedDefinition,
          messageTimestamp   : '2025-04-01T00:00:00.000000Z',
        });
        expect((await dwn.processMessage(alice.did, encryptedConfig.message)).status.code).toBe(202);

        const audience = await createAudienceControlWrite({
          author           : alice,
          dateCreated      : '2025-04-02T00:00:00.000000Z',
          messageTimestamp : '2025-04-02T00:00:00.000000Z',
          protocol,
          rolePath         : 'member',
          roleRuleSet      : encryptedDefinition.structure.member as ProtocolRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const temporarilyUnkeyedConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : definition,
          messageTimestamp   : '2025-04-03T00:00:00.000000Z',
        });
        expect((await dwn.processMessage(alice.did, temporarilyUnkeyedConfig.message)).status.code).toBe(202);

        const retained = await messageStore.query(alice.did, [{ recordId: audience.recordsWrite.message.recordId }]);
        expect(retained.messages.length).toBeGreaterThan(0);
      });

      it('should return 400 if protocol is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // query for non-normalized protocol
        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : minimalProtocolDefinition
        });

        // overwrite protocol because #create auto-normalizes protocol
        protocolsConfig.message.descriptor.definition.protocol = 'example.com/';

        // Re-create auth because we altered the descriptor after signing
        protocolsConfig.message.authorization = await Message.createAuthorization({
          descriptor : protocolsConfig.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records write message
        const reply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.UrlProtocolNotNormalized);
      });

      it('should return 400 if schema is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition = dexProtocolDefinition;
        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        // overwrite schema because #create auto-normalizes schema
        protocolsConfig.message.descriptor.definition.types.ask.schema = 'ask';

        // Re-create auth because we altered the descriptor after signing
        protocolsConfig.message.authorization = await Message.createAuthorization({
          descriptor : protocolsConfig.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records write message
        const reply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.UrlSchemaNotNormalized);
      });

      it('rejects non-tenant non-granted ProtocolsConfigures with 401', async () => {
        // Bob tries to ProtocolsConfigure to Alice's DWN without a permission grant
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition = dexProtocolDefinition;
        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: bob,
          protocolDefinition,
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(401);
        expect(protocolsConfigureReply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureAuthorizationFailed);
      });

      it('should reject ProtocolsConfigure with action rule containing duplicated actor (`who` or `who` + `of` combination) within a rule set', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://foo-bar',
          published : true,
          types     : {
            foo: {},
          },
          structure: {
            foo: {
              $actions: [
                {
                  who : 'anyone',
                  can : [ProtocolAction.Create]
                },
                // duplicated `who` value
                {
                  who : 'anyone',
                  can : [ProtocolAction.Update]
                }
              ]
            }
          }
        };

        // manually craft the invalid ProtocolsConfigure message because our library will not let you create an invalid definition
        const descriptor: ProtocolsConfigureDescriptor = {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : Time.getCurrentTimestamp(),
          definition       : protocolDefinition
        };

        const authorization = await Message.createAuthorization({
          descriptor,
          signer: Jws.createSigner(alice)
        });
        const protocolsConfigureMessage = { descriptor, authorization };

        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfigureMessage);
        expect(protocolsConfigureReply.status.code).toBe(400);
        expect(protocolsConfigureReply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureDuplicateActorInRuleSet);


        // similar test as above but with `of` property
        const protocolDefinition2: ProtocolDefinition = {
          protocol  : 'http://foo-bar',
          published : true,
          types     : {
            foo : {},
            bar : {},
          },
          structure: {
            foo: {
              bar: {
                $actions: [
                  {
                    who : 'recipient',
                    of  : 'foo',
                    can : [ProtocolAction.Create]
                  },
                  // duplicated `who` value
                  {
                    who : 'recipient',
                    of  : 'foo',
                    can : [ProtocolAction.Update]
                  }
                ]
              }
            }
          }
        };

        const descriptor2: ProtocolsConfigureDescriptor = {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : Time.getCurrentTimestamp(),
          definition       : protocolDefinition2
        };

        const authorization2 = await Message.createAuthorization({
          descriptor : descriptor2,
          signer     : Jws.createSigner(alice)
        });
        const protocolsConfigureMessage2 = { descriptor: descriptor2, authorization: authorization2 };

        const protocolsConfigure2Reply = await dwn.processMessage(alice.did, protocolsConfigureMessage2);
        expect(protocolsConfigure2Reply.status.code).toBe(400);
        expect(protocolsConfigure2Reply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureDuplicateActorInRuleSet);
      });

      it('should reject ProtocolsConfigure with action rule containing duplicated role within a rule set', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://foo',
          published : true,
          types     : {
            user : {},
            foo  : {},
          },
          structure: {
            user: {
              $role: true
            },
            foo: {
              $actions: [
                {
                  role : 'user',
                  can  : [ProtocolAction.Create]
                },
                // duplicated `role` value
                {
                  role : 'user',
                  can  : [ProtocolAction.Update]
                }
              ]
            }
          }
        };

        // manually craft the invalid ProtocolsConfigure message because our library will not let you create an invalid definition
        const descriptor: ProtocolsConfigureDescriptor = {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : Time.getCurrentTimestamp(),
          definition       : protocolDefinition
        };

        const authorization = await Message.createAuthorization({
          descriptor,
          signer: Jws.createSigner(alice)
        });
        const protocolsConfigureMessage = { descriptor, authorization };

        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfigureMessage);
        expect(protocolsConfigureReply.status.code).toBe(400);
        expect(protocolsConfigureReply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureDuplicateRoleInRuleSet);
      });

      it('should reject ProtocolsConfigure with action rule `of` pointing to a sibling type (not an ancestor)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // `bar` and `baz` are siblings under `foo`, so `baz` action rule cannot reference `of: 'foo/bar'`
        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://example.com/sibling-of-test',
          published : true,
          types     : {
            foo : {},
            bar : {},
            baz : {},
          },
          structure: {
            foo: {
              bar : {},
              baz : {
                $actions: [
                  {
                    who : 'author',
                    of  : 'foo/bar', // sibling, not ancestor
                    can : [ProtocolAction.Create]
                  }
                ]
              }
            }
          }
        };

        // manually craft the invalid ProtocolsConfigure message because our library will not let you create an invalid definition
        const descriptor: ProtocolsConfigureDescriptor = {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : Time.getCurrentTimestamp(),
          definition       : protocolDefinition
        };

        const authorization = await Message.createAuthorization({
          descriptor,
          signer: Jws.createSigner(alice)
        });
        const protocolsConfigureMessage = { descriptor, authorization };

        const reply = await dwn.processMessage(alice.did, protocolsConfigureMessage);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureInvalidActionOfNotAnAncestor);
      });

      it('should reject ProtocolsConfigure with action rule `of` pointing to an unrelated type', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // `comment` is a top-level type unrelated to the nested `thread/reply` path
        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://example.com/unrelated-of-test',
          published : true,
          types     : {
            thread  : {},
            reply   : {},
            comment : {},
          },
          structure: {
            thread: {
              reply: {
                $actions: [
                  {
                    who : 'author',
                    of  : 'comment', // unrelated type, not an ancestor of 'thread/reply'
                    can : [ProtocolAction.Create]
                  }
                ]
              }
            },
            comment: {}
          }
        };

        const descriptor: ProtocolsConfigureDescriptor = {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : Time.getCurrentTimestamp(),
          definition       : protocolDefinition
        };

        const authorization = await Message.createAuthorization({
          descriptor,
          signer: Jws.createSigner(alice)
        });
        const protocolsConfigureMessage = { descriptor, authorization };

        const reply = await dwn.processMessage(alice.did, protocolsConfigureMessage);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureInvalidActionOfNotAnAncestor);
      });

      it('should accept ProtocolsConfigure with action rule `of` pointing to itself (same protocol path)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // `of` pointing to the same protocol path is valid: "the author of this record can update it"
        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://example.com/self-of-test',
          published : true,
          types     : {
            foo : {},
            bar : {},
          },
          structure: {
            foo: {
              bar: {
                $actions: [
                  {
                    who : 'author',
                    of  : 'foo/bar', // same as current protocol path — valid self-reference
                    can : [ProtocolAction.Create]
                  }
                ]
              }
            }
          }
        };

        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolsConfigure.message);
        expect(reply.status.code).toBe(202);
      });

      it('should accept ProtocolsConfigure with action rule `of` pointing to a valid ancestor', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // `of: 'thread'` is a valid ancestor of `thread/reply/reaction`
        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://example.com/valid-ancestor-of-test',
          published : true,
          types     : {
            thread   : {},
            reply    : {},
            reaction : {},
          },
          structure: {
            thread: {
              reply: {
                $actions: [
                  {
                    who : 'author',
                    of  : 'thread', // valid ancestor
                    can : [ProtocolAction.Create]
                  }
                ],
                reaction: {
                  $actions: [
                    {
                      who : 'author',
                      of  : 'thread/reply', // valid immediate parent ancestor
                      can : [ProtocolAction.Create]
                    }
                  ]
                }
              }
            }
          }
        };

        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolsConfigure.message);
        expect(reply.status.code).toBe(202);
      });

      describe('Grant authorization', () => {
        it('allows an external party to ProtocolsConfigure only if they have a valid grant', async () => {
          // scenario:
          // 1. Alice grants Bob the access to ProtocolsConfigure on her DWN
          // 2. Verify Bob can perform a ProtocolsConfigure
          // 3. Verify that Mallory cannot to use Bob's permission grant to gain access to Alice's DWN
          // 4. Alice revokes Bob's grant
          // 5. Verify Bob cannot perform ProtocolsConfigure with the revoked grant
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const mallory = await TestDataGenerator.generateDidKeyPersona();

          // 1. Alice grants Bob the access to ProtocolsConfigure on her DWN
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Protocols, method: DwnMethodName.Configure }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // 2. Verify Bob can perform a ProtocolsConfigure
          const permissionGrantId = permissionGrant.recordsWrite.message.recordId;
          const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
            permissionGrantId,
            author             : bob,
            protocolDefinition : minimalProtocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfigure.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // 3. Verify that Mallory cannot to use Bob's permission grant to gain access to Alice's DWN
          const malloryProtocolsQuery = await TestDataGenerator.generateProtocolsConfigure({
            permissionGrantId,
            author             : mallory,
            protocolDefinition : minimalProtocolDefinition
          });
          const malloryProtocolsQueryReply = await dwn.processMessage(alice.did, malloryProtocolsQuery.message);
          expect(malloryProtocolsQueryReply.status.code).toBe(401);
          expect(malloryProtocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationNotGrantedToAuthor);

          // 4. Alice revokes Bob's grant
          const revokeWrite = await PermissionsProtocol.createRevocation({
            signer      : Jws.createSigner(alice),
            grant       : PermissionGrant.parse(permissionGrant.dataEncodedMessage),
            dateRevoked : Time.getCurrentTimestamp()
          });

          const revokeWriteReply = await dwn.processMessage(
            alice.did,
            revokeWrite.recordsWrite.message,
            { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
          );
          expect(revokeWriteReply.status.code).toBe(202);

          // 5. Verify Bob cannot perform ProtocolsQuery with the revoked grant
          const unauthorizedProtocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
            permissionGrantId,
            author             : bob,
            protocolDefinition : {
              ...minimalProtocolDefinition,
              protocol: 'https://example.com/protocol/another-protocol'
            }
          });
          const unauthorizedProtocolsConfigureReply = await dwn.processMessage(alice.did, unauthorizedProtocolsConfigure.message);
          expect(unauthorizedProtocolsConfigureReply.status.code).toBe(401);
          expect(unauthorizedProtocolsConfigureReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantRevoked);
        });

        it('should allow to scope a ProtocolsConfigure to a specific protocol', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Alice grants Bob the access to ProtocolsConfigure on her DWN for a specific protocol
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Protocols, method: DwnMethodName.Configure, protocol: 'https://example.com/protocol/allowed' }
          });

          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // Bob tries to ProtocolsConfigure to Alice's DWN for the allowed protocol
          const protocolConfigureAllowed = await TestDataGenerator.generateProtocolsConfigure({
            author             : bob,
            protocolDefinition : {
              ...minimalProtocolDefinition,
              protocol: 'https://example.com/protocol/allowed'
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const protocolConfigureAllowedReply = await dwn.processMessage(alice.did, protocolConfigureAllowed.message);
          expect(protocolConfigureAllowedReply.status.code).toBe(202);

          // Bob tries to ProtocolsConfigure to Alice's DWN for a different protocol
          const protocolConfigureNotAllowed = await TestDataGenerator.generateProtocolsConfigure({
            author             : bob,
            protocolDefinition : {
              ...minimalProtocolDefinition,
              protocol: 'https://example.com/protocol/not-allowed'
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const protocolConfigureNotAllowedReply = await dwn.processMessage(alice.did, protocolConfigureNotAllowed.message);
          expect(protocolConfigureNotAllowedReply.status.code).toBe(401);
        });
      });

      describe('retained protocol history', () => {
        it('should add ProtocolsConfigure to the message store', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const { message } = await TestDataGenerator.generateProtocolsConfigure({ author: alice });

          const reply = await dwn.processMessage(alice.did, message);
          expect(reply.status.code).toBe(202);

          const messageCid = await Message.getCid(message);
          expect(await messageStore.get(alice.did, messageCid)).toBeDefined();
        });

        it('should retain all ProtocolsConfigure messages for protocol versioning', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const oldestWrite = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: minimalProtocolDefinition });
          await Time.minimalSleep();
          const newestWrite = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: minimalProtocolDefinition });

          let reply = await dwn.processMessage(alice.did, oldestWrite.message);
          expect(reply.status.code).toBe(202);

          reply = await dwn.processMessage(alice.did, newestWrite.message);
          expect(reply.status.code).toBe(202);

          const oldestMessageCid = await Message.getCid(oldestWrite.message);
          const newestMessageCid = await Message.getCid(newestWrite.message);
          const { messages } = await messageStore.query(alice.did, [{
            interface : DwnInterfaceName.Protocols,
            method    : DwnMethodName.Configure,
            protocol  : minimalProtocolDefinition.protocol,
          }]);
          const retainedCids = await Promise.all(messages.map((storedMessage) => Message.getCid(storedMessage)));
          expect(retainedCids).toContain(oldestMessageCid);
          expect(retainedCids).toContain(newestMessageCid);
        });
      });

      describe('temporal protocol versioning', () => {
        it('should authorize records against the protocol definition active at the incoming message timestamp', async () => {
          // scenario:
          // 1. Alice installs protocol v1 with types `post` and `comment`
          // 2. Alice writes a `post` record under v1
          // 3. Alice re-configures the protocol to v2 which removes the `comment` type
          // 4. Alice can still read the records as the tenant
          // 5. Alice cannot update the v1-shaped `post` because the update validates against v2
          const alice = await TestDataGenerator.generateDidKeyPersona();

          // v1: has `post` and `comment` types
          const protocolUri = 'https://example.com/versioned-protocol';
          const protocolDefinitionV1: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post    : { schema: 'https://example.com/post', dataFormats: ['application/json'] },
              comment : { schema: 'https://example.com/comment', dataFormats: ['application/json'] },
            },
            structure: {
              post: {
                $actions : [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read, ProtocolAction.Update] }],
                comment  : {
                  $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
                }
              }
            }
          };

          const configureV1 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV1,
          });
          const configureV1Reply = await dwn.processMessage(alice.did, configureV1.message);
          expect(configureV1Reply.status.code).toBe(202);

          // write a `post` record under v1
          const postRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post',
            dataFormat   : 'application/json',
          });
          const postReply = await dwn.processMessage(alice.did, postRecord.message, { dataStream: postRecord.dataStream });
          expect(postReply.status.code).toBe(202);

          // write a `comment` record under v1
          const commentRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            protocol        : protocolUri,
            protocolPath    : 'post/comment',
            schema          : 'https://example.com/comment',
            dataFormat      : 'application/json',
            parentContextId : postRecord.message.contextId,
          });
          const commentReply = await dwn.processMessage(alice.did, commentRecord.message, { dataStream: commentRecord.dataStream });
          expect(commentReply.status.code).toBe(202);

          await Time.minimalSleep();

          // v2: removes the `comment` type entirely, changes `post` schema
          const protocolDefinitionV2: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: { schema: 'https://example.com/post-v2', dataFormats: ['application/json'] },
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read, ProtocolAction.Update] }],
              }
            }
          };

          const configureV2 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV2,
          });
          const configureV2Reply = await dwn.processMessage(alice.did, configureV2.message);
          expect(configureV2Reply.status.code).toBe(202);

          // read the v1 `post` record — should succeed because `post` still exists in v2
          const readPost = await RecordsRead.create({
            filter : { recordId: postRecord.message.recordId },
            signer : Jws.createSigner(alice),
          });
          const readPostReply = await dwn.processMessage(alice.did, readPost.message);
          expect(readPostReply.status.code).toBe(200);

          // read the v1 `comment` record — tenant/owner reads are still allowed
          const readComment = await RecordsRead.create({
            filter : { recordId: commentRecord.message.recordId },
            signer : Jws.createSigner(alice),
          });
          const readCommentReply = await dwn.processMessage(alice.did, readComment.message);
          expect(readCommentReply.status.code).toBe(200);

          // update the v1 `post` record — should fail because the update message resolves v2 with the v2 schema
          const updatedData = new TextEncoder().encode('{"title":"updated post"}');
          const updatePost = await RecordsWrite.createFrom({
            recordsWriteMessage : postRecord.message,
            data                : updatedData,
            signer              : Jws.createSigner(alice),
          });
          const updatePostReply = await dwn.processMessage(
            alice.did, updatePost.message, { dataStream: DataStream.fromBytes(updatedData) }
          );
          expect(updatePostReply.status.code).toBe(400);
          expect(updatePostReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationInvalidSchema);
        });

        it('should authorize new records against the latest protocol definition, not an older one', async () => {
          // scenario:
          // 1. Alice installs protocol v1 with type `post`
          // 2. Alice re-configures to v2 that changes `post` schema to 'https://example.com/post-v2'
          // 3. A new record with v1 schema should be rejected (not matching the latest definition)
          // 4. A new record with v2 schema should be accepted
          const alice = await TestDataGenerator.generateDidKeyPersona();

          const protocolUri = 'https://example.com/versioned-protocol-2';
          const protocolDefinitionV1: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: { schema: 'https://example.com/post-v1', dataFormats: ['application/json'] },
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              }
            }
          };

          const configureV1 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV1,
          });
          const configureV1Reply = await dwn.processMessage(alice.did, configureV1.message);
          expect(configureV1Reply.status.code).toBe(202);

          await Time.minimalSleep();

          // v2: changes `post` schema
          const protocolDefinitionV2: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: { schema: 'https://example.com/post-v2', dataFormats: ['application/json'] },
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              }
            }
          };

          const configureV2 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV2,
          });
          const configureV2Reply = await dwn.processMessage(alice.did, configureV2.message);
          expect(configureV2Reply.status.code).toBe(202);

          // write a new record with v1 schema — should fail (latest definition requires v2 schema)
          const postV1 = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post-v1',
            dataFormat   : 'application/json',
          });
          const postV1Reply = await dwn.processMessage(alice.did, postV1.message, { dataStream: postV1.dataStream });
          expect(postV1Reply.status.code).toBe(400);
          expect(postV1Reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationInvalidSchema);

          // write a new record with v2 schema — should succeed
          const postV2 = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post-v2',
            dataFormat   : 'application/json',
          });
          const postV2Reply = await dwn.processMessage(alice.did, postV2.message, { dataStream: postV2.dataStream });
          expect(postV2Reply.status.code).toBe(202);
        });

        it('should authorize deletes of v1 records after re-configuring to v2 that removes the type', async () => {
          // scenario:
          // 1. Alice installs protocol v1 with types `post` (with delete action) and `comment`
          // 2. Alice writes a `post/comment` record
          // 3. Alice re-configures to v2 which removes the `comment` type
          // 4. Alice should still be able to delete the v1 `comment` record (governed by v1 definition)
          const alice = await TestDataGenerator.generateDidKeyPersona();

          const protocolUri = 'https://example.com/versioned-protocol-3';
          const protocolDefinitionV1: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post    : {},
              comment : {},
            },
            structure: {
              post: {
                $actions : [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
                comment  : {
                  $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read, ProtocolAction.Delete] }],
                }
              }
            }
          };

          const configureV1 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV1,
          });
          const configureV1Reply = await dwn.processMessage(alice.did, configureV1.message);
          expect(configureV1Reply.status.code).toBe(202);

          // write a `post` record
          const postRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
          });
          const postReply = await dwn.processMessage(alice.did, postRecord.message, { dataStream: postRecord.dataStream });
          expect(postReply.status.code).toBe(202);

          // write a `comment` record under the post
          const commentRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            protocol        : protocolUri,
            protocolPath    : 'post/comment',
            parentContextId : postRecord.message.contextId,
          });
          const commentReply = await dwn.processMessage(alice.did, commentRecord.message, { dataStream: commentRecord.dataStream });
          expect(commentReply.status.code).toBe(202);

          await Time.minimalSleep();

          // v2: removes the `comment` type
          const protocolDefinitionV2: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: {},
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              }
            }
          };

          const configureV2 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV2,
          });
          const configureV2Reply = await dwn.processMessage(alice.did, configureV2.message);
          expect(configureV2Reply.status.code).toBe(202);

          // delete the v1 `comment` record — should succeed (governed by v1 definition)
          const deleteComment = await RecordsDelete.create({
            signer   : Jws.createSigner(alice),
            recordId : commentRecord.message.recordId,
          });
          const deleteReply = await dwn.processMessage(alice.did, deleteComment.message);
          expect(deleteReply.status.code).toBe(202);
        });

        it('should apply action rules from the protocol definition active at the update timestamp', async () => {
          // scenario:
          // 1. Alice installs protocol v1 where anyone can create and update `post` records
          // 2. Bob writes a `post` to Alice's DWN
          // 3. Alice re-configures to v2 that restricts `post` updates to author-only (removes co-update)
          // 4. Bob cannot update because the update message resolves v2, which no longer allows update
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolUri = 'https://example.com/versioned-protocol-4';
          const protocolDefinitionV1: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: {},
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read, ProtocolAction.Update] }],
              }
            }
          };

          const configureV1 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV1,
          });
          const configureV1Reply = await dwn.processMessage(alice.did, configureV1.message);
          expect(configureV1Reply.status.code).toBe(202);

          // Bob writes a `post` record to Alice's DWN under v1
          const postRecord = await TestDataGenerator.generateRecordsWrite({
            author       : bob,
            protocol     : protocolUri,
            protocolPath : 'post',
          });
          const postReply = await dwn.processMessage(alice.did, postRecord.message, { dataStream: postRecord.dataStream });
          expect(postReply.status.code).toBe(202);

          await Time.minimalSleep();

          // v2: restricts actions (only create, no update for anyone)
          const protocolDefinitionV2: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: {},
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              }
            }
          };

          const configureV2 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV2,
          });
          const configureV2Reply = await dwn.processMessage(alice.did, configureV2.message);
          expect(configureV2Reply.status.code).toBe(202);

          // Bob updates his v1 record — should fail because the update message resolves v2, which no longer allows update
          const updatedData = new TextEncoder().encode('updated-post-data');
          const updatePost = await RecordsWrite.createFrom({
            recordsWriteMessage : postRecord.message,
            data                : updatedData,
            signer              : Jws.createSigner(bob),
          });
          const updateReply = await dwn.processMessage(
            alice.did, updatePost.message, { dataStream: DataStream.fromBytes(updatedData) }
          );
          expect(updateReply.status.code).toBe(401);
          expect(updateReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
        });

        it('should handle out-of-order protocol configure processing correctly', async () => {
          // scenario:
          // 1. Create v1 and v2 ProtocolsConfigure messages (v2 has a newer timestamp)
          // 2. Process v2 first, then v1
          // 3. Both should be stored; query should return only v2 (the latest)
          // 4. A record written under v2 schema should succeed
          const alice = await TestDataGenerator.generateDidKeyPersona();

          const protocolUri = 'https://example.com/versioned-protocol-5';
          const protocolDefinitionV1: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: { schema: 'https://example.com/post-v1', dataFormats: ['application/json'] },
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              }
            }
          };

          const configureV1 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV1,
          });

          await Time.minimalSleep();

          const protocolDefinitionV2: ProtocolDefinition = {
            protocol  : protocolUri,
            published : true,
            types     : {
              post: { schema: 'https://example.com/post-v2', dataFormats: ['application/json'] },
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: [ProtocolAction.Create, ProtocolAction.Read] }],
              }
            }
          };

          const configureV2 = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : protocolDefinitionV2,
          });

          // process v2 first (out of order)
          const configureV2Reply = await dwn.processMessage(alice.did, configureV2.message);
          expect(configureV2Reply.status.code).toBe(202);

          // process v1 second (older, arrives later)
          const configureV1Reply = await dwn.processMessage(alice.did, configureV1.message);
          expect(configureV1Reply.status.code).toBe(202);

          // query should return only v2 (the latest)
          const queryMessageData = await TestDataGenerator.generateProtocolsQuery({
            author : alice,
            filter : { protocol: protocolUri }
          });
          const queryReply = await dwn.processMessage(alice.did, queryMessageData.message);
          expect(queryReply.status.code).toBe(200);
          expect(queryReply.entries).toHaveLength(1);
          expect(queryReply.entries![0].descriptor.definition.types.post.schema).toBe('https://example.com/post-v2');

          // writing a new record with v2 schema should succeed (latest definition)
          const postV2 = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post-v2',
            dataFormat   : 'application/json',
          });
          const postV2Reply = await dwn.processMessage(alice.did, postV2.message, { dataStream: postV2.dataStream });
          expect(postV2Reply.status.code).toBe(202);
        });
      });
    });
  });
}
