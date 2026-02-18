import type { DidResolver } from '@enbox/dids';
import type { EventStream } from '../../src/types/subscriptions.js';
import type { GenerateProtocolsConfigureOutput } from '../utils/test-data-generator.js';
import type {
  DataStore,
  MessageStore,
  ProtocolDefinition,
  ProtocolsConfigureDescriptor,
  ResumableTaskStore,
  StateIndex,
} from '../../src/index.js';

import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import chai, { expect } from 'chai';

import dexProtocolDefinition from '../vectors/protocol-definitions/dex.json' with { type: 'json' };
import minimalProtocolDefinition from '../vectors/protocol-definitions/minimal.json' with { type: 'json' };

import { GeneralJwsBuilder } from '../../src/jose/jws/general/builder.js';
import { lexicographicalCompare } from '../../src/utils/string.js';
import { Message } from '../../src/core/message.js';
import { ProtocolAction } from '../../src/types/protocols-types.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventStream } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { Time } from '../../src/utils/time.js';

import { DataStream, Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Jws, PermissionGrant, PermissionsProtocol, RecordsDelete, RecordsRead, RecordsWrite } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

chai.use(chaiAsPromised);

export function testProtocolsConfigureHandler(): void {
  describe('ProtocolsConfigureHandler.handle()', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let stateIndex: StateIndex;
    let eventStream: EventStream;
    let dwn: Dwn;

    describe('functional tests', () => {

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      before(async () => {
        didResolver = new UniversalResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        resumableTaskStore = stores.resumableTaskStore;
        stateIndex = stores.stateIndex;
        eventStream = TestEventStream.get();

        dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, eventStream, resumableTaskStore });
      });

      beforeEach(async () => {
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
        await stateIndex.clear();
      });

      after(async () => {
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
        expect(reply.status.code).to.equal(202);
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

        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.contain('expected no more than 1 signature');
      });

      it('should return 401 if auth fails', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateProtocolsConfigure({ author: alice });

        // use a bad signature to fail authentication
        const badSignature = await TestDataGenerator.randomSignatureString();
        message.authorization.signature.signatures[0].signature = badSignature;

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).to.equal(401);
        expect(reply.status.detail).to.contain(DwnErrorCode.GeneralJwsVerifierInvalidSignature);
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
        expect(reply1.status.code).to.equal(202);

        // older messages are also accepted (stored as historical versions)
        const reply2 = await dwn.processMessage(alice.did, oldProtocolsConfigure.message);
        expect(reply2.status.code).to.equal(202);

        // newer message is also accepted and becomes the latest
        const newProtocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const reply3 = await dwn.processMessage(alice.did, newProtocolsConfigure.message);
        expect(reply3.status.code).to.equal(202);

        // only the newest protocol should be returned by query (ProtocolsQuery returns only latest)
        const queryMessageData = await TestDataGenerator.generateProtocolsQuery({
          author : alice,
          filter : { protocol: protocolDefinition.protocol }
        });
        const queryReply = await dwn.processMessage(alice.did, queryMessageData.message);

        expect(queryReply.status.code).to.equal(200);
        expect(queryReply.entries?.length).to.equal(1);
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
        expect(reply1.status.code).to.equal(202);

        // all versions are accepted (stored as historical versions)
        const reply2 = await dwn.processMessage(alice.did, lowestProtocolsConfigure.message);
        expect(reply2.status.code).to.equal(202);

        // highest lexicographic value is also accepted and becomes the latest
        const reply3 = await dwn.processMessage(alice.did, highestProtocolsConfigure.message);
        expect(reply3.status.code).to.equal(202);

        // query should only return the latest protocol definition (highest by CID tiebreak)
        const queryMessageData = await TestDataGenerator.generateProtocolsQuery({
          author : alice,
          filter : { protocol: protocolDefinition1.protocol }
        });
        const queryReply = await dwn.processMessage(alice.did, queryMessageData.message);

        expect(queryReply.status.code).to.equal(200);
        expect(queryReply.entries?.length).to.equal(1);
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
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.contain(DwnErrorCode.UrlProtocolNotNormalized);
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
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.contain(DwnErrorCode.UrlSchemaNotNormalized);
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
        expect(protocolsConfigureReply.status.code).to.equal(401);
        expect(protocolsConfigureReply.status.detail).to.contain(DwnErrorCode.ProtocolsConfigureAuthorizationFailed);
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
        expect(protocolsConfigureReply.status.code).to.equal(400);
        expect(protocolsConfigureReply.status.detail).to.contain(DwnErrorCode.ProtocolsConfigureDuplicateActorInRuleSet);


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
        expect(protocolsConfigure2Reply.status.code).to.equal(400);
        expect(protocolsConfigure2Reply.status.detail).to.contain(DwnErrorCode.ProtocolsConfigureDuplicateActorInRuleSet);
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
        expect(protocolsConfigureReply.status.code).to.equal(400);
        expect(protocolsConfigureReply.status.detail).to.contain(DwnErrorCode.ProtocolsConfigureDuplicateRoleInRuleSet);
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
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.contain(DwnErrorCode.ProtocolsConfigureInvalidActionOfNotAnAncestor);
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
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.contain(DwnErrorCode.ProtocolsConfigureInvalidActionOfNotAnAncestor);
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
        expect(reply.status.code).to.equal(202);
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
        expect(reply.status.code).to.equal(202);
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
          expect(grantRecordsWriteReply.status.code).to.equal(202);

          // 2. Verify Bob can perform a ProtocolsConfigure
          const permissionGrantId = permissionGrant.recordsWrite.message.recordId;
          const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
            permissionGrantId,
            author             : bob,
            protocolDefinition : minimalProtocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfigure.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);

          // 3. Verify that Mallory cannot to use Bob's permission grant to gain access to Alice's DWN
          const malloryProtocolsQuery = await TestDataGenerator.generateProtocolsConfigure({
            permissionGrantId,
            author             : mallory,
            protocolDefinition : minimalProtocolDefinition
          });
          const malloryProtocolsQueryReply = await dwn.processMessage(alice.did, malloryProtocolsQuery.message);
          expect(malloryProtocolsQueryReply.status.code).to.equal(401);
          expect(malloryProtocolsQueryReply.status.detail).to.contain(DwnErrorCode.GrantAuthorizationNotGrantedToAuthor);

          // 4. Alice revokes Bob's grant
          const revokeWrite = await PermissionsProtocol.createRevocation({
            signer      : Jws.createSigner(alice),
            grant       : await PermissionGrant.parse(permissionGrant.dataEncodedMessage),
            dateRevoked : Time.getCurrentTimestamp()
          });

          const revokeWriteReply = await dwn.processMessage(
            alice.did,
            revokeWrite.recordsWrite.message,
            { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
          );
          expect(revokeWriteReply.status.code).to.equal(202);

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
          expect(unauthorizedProtocolsConfigureReply.status.code).to.equal(401);
          expect(unauthorizedProtocolsConfigureReply.status.detail).to.contain(DwnErrorCode.GrantAuthorizationGrantRevoked);
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
          expect(grantRecordsWriteReply.status.code).to.equal(202);

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
          expect(protocolConfigureAllowedReply.status.code).to.equal(202);

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
          expect(protocolConfigureNotAllowedReply.status.code).to.equal(401);
        });
      });

      describe('state index', () => {
        it('should add event for ProtocolsConfigure', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const { message } = await TestDataGenerator.generateProtocolsConfigure({ author: alice });

          const reply = await dwn.processMessage(alice.did, message);
          expect(reply.status.code).to.equal(202);

          const events = await stateIndex.getLeaves(alice.did, []);
          expect(events.length).to.equal(1);

          const messageCid = await Message.getCid(message);
          expect(events[0]).to.equal(messageCid);
        });

        it('should retain all ProtocolsConfigure events for protocol versioning', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const oldestWrite = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: minimalProtocolDefinition });
          await Time.minimalSleep();
          const newestWrite = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: minimalProtocolDefinition });

          let reply = await dwn.processMessage(alice.did, oldestWrite.message);
          expect(reply.status.code).to.equal(202);

          reply = await dwn.processMessage(alice.did, newestWrite.message);
          expect(reply.status.code).to.equal(202);

          const events = await stateIndex.getLeaves(alice.did, []);
          expect(events.length).to.equal(2);

          const oldestMessageCid = await Message.getCid(oldestWrite.message);
          const newestMessageCid = await Message.getCid(newestWrite.message);
          expect(events).to.include(oldestMessageCid);
          expect(events).to.include(newestMessageCid);
        });
      });

      describe('temporal protocol versioning', () => {
        it('should authorize records created under v1 even after re-configuring to v2 that removes the type', async () => {
          // scenario:
          // 1. Alice installs protocol v1 with types `post` and `comment`
          // 2. Alice writes a `post` record under v1
          // 3. Alice re-configures the protocol to v2 which removes the `comment` type
          // 4. Alice should still be able to read the v1 `post` record
          // 5. Alice should still be able to update the v1 `post` record (governed by v1 definition)
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
          expect(configureV1Reply.status.code).to.equal(202);

          // write a `post` record under v1
          const postRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post',
            dataFormat   : 'application/json',
          });
          const postReply = await dwn.processMessage(alice.did, postRecord.message, { dataStream: postRecord.dataStream });
          expect(postReply.status.code).to.equal(202);

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
          expect(commentReply.status.code).to.equal(202);

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
          expect(configureV2Reply.status.code).to.equal(202);

          // read the v1 `post` record — should succeed because read authorization uses v1 definition
          const readPost = await RecordsRead.create({
            filter : { recordId: postRecord.message.recordId },
            signer : Jws.createSigner(alice),
          });
          const readPostReply = await dwn.processMessage(alice.did, readPost.message);
          expect(readPostReply.status.code).to.equal(200);

          // read the v1 `comment` record — should succeed (governed by v1 definition where `comment` exists)
          const readComment = await RecordsRead.create({
            filter : { recordId: commentRecord.message.recordId },
            signer : Jws.createSigner(alice),
          });
          const readCommentReply = await dwn.processMessage(alice.did, readComment.message);
          expect(readCommentReply.status.code).to.equal(200);

          // update the v1 `post` record — should succeed (governed by v1 definition)
          const updatedData = new TextEncoder().encode('{"title":"updated post"}');
          const updatePost = await RecordsWrite.createFrom({
            recordsWriteMessage : postRecord.message,
            data                : updatedData,
            signer              : Jws.createSigner(alice),
          });
          const updatePostReply = await dwn.processMessage(
            alice.did, updatePost.message, { dataStream: DataStream.fromBytes(updatedData) }
          );
          expect(updatePostReply.status.code).to.equal(202);
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
          expect(configureV1Reply.status.code).to.equal(202);

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
          expect(configureV2Reply.status.code).to.equal(202);

          // write a new record with v1 schema — should fail (latest definition requires v2 schema)
          const postV1 = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post-v1',
            dataFormat   : 'application/json',
          });
          const postV1Reply = await dwn.processMessage(alice.did, postV1.message, { dataStream: postV1.dataStream });
          expect(postV1Reply.status.code).to.equal(400);
          expect(postV1Reply.status.detail).to.contain(DwnErrorCode.ProtocolAuthorizationInvalidSchema);

          // write a new record with v2 schema — should succeed
          const postV2 = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post-v2',
            dataFormat   : 'application/json',
          });
          const postV2Reply = await dwn.processMessage(alice.did, postV2.message, { dataStream: postV2.dataStream });
          expect(postV2Reply.status.code).to.equal(202);
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
          expect(configureV1Reply.status.code).to.equal(202);

          // write a `post` record
          const postRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
          });
          const postReply = await dwn.processMessage(alice.did, postRecord.message, { dataStream: postRecord.dataStream });
          expect(postReply.status.code).to.equal(202);

          // write a `comment` record under the post
          const commentRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            protocol        : protocolUri,
            protocolPath    : 'post/comment',
            parentContextId : postRecord.message.contextId,
          });
          const commentReply = await dwn.processMessage(alice.did, commentRecord.message, { dataStream: commentRecord.dataStream });
          expect(commentReply.status.code).to.equal(202);

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
          expect(configureV2Reply.status.code).to.equal(202);

          // delete the v1 `comment` record — should succeed (governed by v1 definition)
          const deleteComment = await RecordsDelete.create({
            signer   : Jws.createSigner(alice),
            recordId : commentRecord.message.recordId,
          });
          const deleteReply = await dwn.processMessage(alice.did, deleteComment.message);
          expect(deleteReply.status.code).to.equal(202);
        });

        it('should not retroactively apply v2 action rules to records created under v1', async () => {
          // scenario:
          // 1. Alice installs protocol v1 where anyone can create and update `post` records
          // 2. Bob writes a `post` to Alice's DWN
          // 3. Alice re-configures to v2 that restricts `post` updates to author-only (removes co-update)
          // 4. Bob should still be able to update his own record (governed by v1 definition which had update)
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
          expect(configureV1Reply.status.code).to.equal(202);

          // Bob writes a `post` record to Alice's DWN under v1
          const postRecord = await TestDataGenerator.generateRecordsWrite({
            author       : bob,
            protocol     : protocolUri,
            protocolPath : 'post',
          });
          const postReply = await dwn.processMessage(alice.did, postRecord.message, { dataStream: postRecord.dataStream });
          expect(postReply.status.code).to.equal(202);

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
          expect(configureV2Reply.status.code).to.equal(202);

          // Bob updates his v1 record — should succeed because v1 definition (which governs this record) allowed update
          const updatedData = new TextEncoder().encode('updated-post-data');
          const updatePost = await RecordsWrite.createFrom({
            recordsWriteMessage : postRecord.message,
            data                : updatedData,
            signer              : Jws.createSigner(bob),
          });
          const updateReply = await dwn.processMessage(
            alice.did, updatePost.message, { dataStream: DataStream.fromBytes(updatedData) }
          );
          expect(updateReply.status.code).to.equal(202);
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
          expect(configureV2Reply.status.code).to.equal(202);

          // process v1 second (older, arrives later)
          const configureV1Reply = await dwn.processMessage(alice.did, configureV1.message);
          expect(configureV1Reply.status.code).to.equal(202);

          // query should return only v2 (the latest)
          const queryMessageData = await TestDataGenerator.generateProtocolsQuery({
            author : alice,
            filter : { protocol: protocolUri }
          });
          const queryReply = await dwn.processMessage(alice.did, queryMessageData.message);
          expect(queryReply.status.code).to.equal(200);
          expect(queryReply.entries?.length).to.equal(1);
          expect(queryReply.entries![0].descriptor.definition.types.post.schema).to.equal('https://example.com/post-v2');

          // writing a new record with v2 schema should succeed (latest definition)
          const postV2 = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolUri,
            protocolPath : 'post',
            schema       : 'https://example.com/post-v2',
            dataFormat   : 'application/json',
          });
          const postV2Reply = await dwn.processMessage(alice.did, postV2.message, { dataStream: postV2.dataStream });
          expect(postV2Reply.status.code).to.equal(202);
        });
      });
    });
  });
}