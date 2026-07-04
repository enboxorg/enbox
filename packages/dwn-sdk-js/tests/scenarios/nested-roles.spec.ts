import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ResumableTaskStore } from '../../src/index.js';

import sinon from 'sinon';
import slackProtocolDefinitionJson from '../vectors/protocol-definitions/slack.json' with { type: 'json' };
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { RecordsQuery, RecordsRead } from '../../src/index.js';
import { asProtocolDefinition } from '../utils/protocol-definition.js';

const slackProtocolDefinition = asProtocolDefinition(slackProtocolDefinitionJson);

export function testNestedRoleScenarios(): void {
  describe('Nested role scenarios', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    // important to follow the `beforeAll` and `afterAll` pattern to initialize and clean the stores in tests
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

    it('should support Slack-like protocol with community and gated channels', async () => {
      // scenario:
      // 1. Alice installs the Slack-like protocol
      // 2. Alice creates a community
      // 3. Alice can assign Bob as an `admin` in the community
      // 4. Bob can invoke his `admin` role to perform actions:
      //   4a. Bob can read the community record
      //   4b. Bob can create gated-channels 1 & 2 in the community
      //   4c. Bob can query all gated-channels in the community
      // 5. Bob as the creator/author of the channels can add participants in the gated-channels
      //   5a. Bob can add himself and Carol as participants in the gated-channel 1
      //   5b. Bob can add himself and Daniel as participants in the gated-channel 2
      // 6. Carol can read the gated channel 1 record by invoking her child participant role to the gated channel 1
      // 7. Carol CANNOT add anyone as a participant in the gated-channel 2 since she is not a participant in the channel
      // 8. Carol CANNOT add Daniel as another participant in the gated-channel without invoking her role
      // 9. Carol can invoke her participant role to add Daniel as another participant in the gated-channel
      // 10. Bob can invoke the participant role to write a chat message in the channel
      // 11. Carol can invoke the participant role to read chat messages in the channel
      // 12. Carol can invoke the participant role to react to Bob's chat message in the channel
      // 13. Mallory CANNOT invoke the participant role (which she is not given) to read the chat messages in the channel
      // 14. Mallory CANNOT invoke the participant role (which she is not given) to write a chat message in the channel

      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const carol = await TestDataGenerator.generateDidKeyPersona();
      const daniel = await TestDataGenerator.generateDidKeyPersona();
      const mallory = await TestDataGenerator.generateDidKeyPersona(); // unauthorized person

      const protocolDefinition = slackProtocolDefinition;

      // 1. Alice installs the Slack-like protocol
      const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition
      });
      const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
      expect(protocolsConfigureReply.status.code).toBe(202);

      // 2. Alice creates a community
      const communityRecord = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'community'
      });
      const communityRecordReply = await dwn.processMessage(alice.did, communityRecord.message, { dataStream: communityRecord.dataStream });
      expect(communityRecordReply.status.code).toBe(202);

      // 3. Alice can assign Bob as an 'admin' in the community
      const communityAdminBobRecord = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        recipient       : bob.did,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'community/admin',
        parentContextId : communityRecord.message.contextId,
      });
      const communityAdminBobRecordReply
        = await dwn.processMessage(alice.did, communityAdminBobRecord.message, { dataStream: communityAdminBobRecord.dataStream });
      expect(communityAdminBobRecordReply.status.code).toBe(202);

      // 4. Bob can invoke his `admin` role to perform actions:
      //   4a. Bob can read the community record
      const bobCommunityRead = await RecordsRead.create({
        signer       : Jws.createSigner(bob),
        protocolRole : 'community/admin',
        filter       : {
          protocol     : protocolDefinition.protocol,
          protocolPath : 'community',
          contextId    : communityRecord.message.contextId
        }
      });
      const bobCommunityReadReply = await dwn.processMessage(alice.did, bobCommunityRead.message);
      expect(bobCommunityReadReply.status.code).toBe(200);
      expect(bobCommunityReadReply.entry!.recordsWrite?.recordId).toBe(communityRecord.message.recordId);

      //   4b. Bob can create gated-channels 1 & 2 in the community
      const channel1Record = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        protocol        : protocolDefinition.protocol,
        protocolRole    : 'community/admin',
        protocolPath    : 'community/gatedChannel',
        parentContextId : communityRecord.message.contextId
      });
      const channel1RecordReply = await dwn.processMessage(alice.did, channel1Record.message, { dataStream: channel1Record.dataStream });
      expect(channel1RecordReply.status.code).toBe(202);

      const channel2Record = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        protocol        : protocolDefinition.protocol,
        protocolRole    : 'community/admin',
        protocolPath    : 'community/gatedChannel',
        parentContextId : communityRecord.message.contextId
      });
      const channel2RecordReply = await dwn.processMessage(alice.did, channel2Record.message, { dataStream: channel2Record.dataStream });
      expect(channel2RecordReply.status.code).toBe(202);

      //   4c. Bob can query all gated-channels in the community
      const bobQuery = await RecordsQuery.create({
        signer       : Jws.createSigner(bob),
        protocolRole : 'community/admin',
        filter       : {
          protocol     : protocolDefinition.protocol,
          protocolPath : 'community/gatedChannel',
          contextId    : communityRecord.message.contextId
        }
      });
      const bobQueryReply = await dwn.processMessage(alice.did, bobQuery.message);
      expect(bobQueryReply.status.code).toBe(200);
      expect(bobQueryReply.entries?.length).toBe(2);

      // 5. Bob as the creator/author of the channels can  add participants in the gated-channels
      // 5a. Bob can add himself and Carol as participants in the gated-channel 1
      const channel1ParticipantBobRecord = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        recipient       : bob.did,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'community/gatedChannel/participant',
        parentContextId : channel1Record.message.contextId,
      });
      const channel1ParticipantBobRecordReply
        = await dwn.processMessage(alice.did, channel1ParticipantBobRecord.message, { dataStream: channel1ParticipantBobRecord.dataStream });
      expect(channel1ParticipantBobRecordReply.status.code).toBe(202);

      const channel1ParticipantCarolRecord = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        recipient       : carol.did,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'community/gatedChannel/participant',
        parentContextId : channel1Record.message.contextId,
      });
      const channel1ParticipantCarolRecordReply
        = await dwn.processMessage(alice.did, channel1ParticipantCarolRecord.message, { dataStream: channel1ParticipantCarolRecord.dataStream });
      expect(channel1ParticipantCarolRecordReply.status.code).toBe(202);

      // 5b. Bob can add himself and Daniel as participants in the gated-channel 2
      const channel2ParticipantBobRecord = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        recipient       : bob.did,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'community/gatedChannel/participant',
        parentContextId : channel2Record.message.contextId,
      });
      const channel2ParticipantBobRecordReply
              = await dwn.processMessage(alice.did, channel2ParticipantBobRecord.message, { dataStream: channel2ParticipantBobRecord.dataStream });
      expect(channel2ParticipantBobRecordReply.status.code).toBe(202);

      const channel2ParticipantDanielRecord = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        recipient       : daniel.did,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'community/gatedChannel/participant',
        parentContextId : channel2Record.message.contextId,
      });
      const channel2ParticipantDanielRecordReply
        = await dwn.processMessage(alice.did, channel2ParticipantDanielRecord.message, { dataStream: channel2ParticipantDanielRecord.dataStream });
      expect(channel2ParticipantDanielRecordReply.status.code).toBe(202);

      // 6. Carol can read the gated channel 1 record by invoking her child participant role to the gated channel 1
      const carolRead = await RecordsRead.create({
        signer       : Jws.createSigner(carol),
        protocolRole : 'community/gatedChannel/participant',
        filter       : {
          protocol     : protocolDefinition.protocol,
          protocolPath : 'community/gatedChannel',
          contextId    : channel1Record.message.contextId
        }
      });
      const carolReadReply = await dwn.processMessage(alice.did, carolRead.message);
      expect(carolReadReply.status.code).toBe(200);
      expect(carolReadReply.entry!.recordsWrite?.recordId).toBe(channel1Record.message.recordId);

      // 7. Carol CANNOT add anyone as a participant in the gated-channel 2 since she is not a participant in the channel
      const participantCarolRecord = await TestDataGenerator.generateRecordsWrite({
        author          : carol,
        recipient       : carol.did,
        protocol        : protocolDefinition.protocol,
        protocolRole    : 'community/gatedChannel/participant',
        protocolPath    : 'community/gatedChannel/participant',
        parentContextId : channel2Record.message.contextId
      });
      const participantCarolRecordReply
        = await dwn.processMessage(alice.did, participantCarolRecord.message, { dataStream: participantCarolRecord.dataStream });
      expect(participantCarolRecordReply.status.code).toBe(401);
      expect(participantCarolRecordReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);

      // 8. Carol CANNOT add Daniel as another participant in the gated-channel without invoking her role
      const participantDanielRecordAttempt1 = await TestDataGenerator.generateRecordsWrite({
        author          : carol,
        recipient       : daniel.did,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'community/gatedChannel/participant',
        parentContextId : channel1Record.message.contextId,
      });
      const participantDanielRecordAttempt1Reply
        = await dwn.processMessage(alice.did, participantDanielRecordAttempt1.message, { dataStream: participantDanielRecordAttempt1.dataStream });
      expect(participantDanielRecordAttempt1Reply.status.code).toBe(401);
      expect(participantDanielRecordAttempt1Reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

      // 9. Carol can invoke her participant role to add Daniel as another participant in the gated-channel
      const participantDanielRecordAttempt2 = await TestDataGenerator.generateRecordsWrite({
        author          : carol,
        recipient       : daniel.did,
        protocol        : protocolDefinition.protocol,
        protocolRole    : 'community/gatedChannel/participant',
        protocolPath    : 'community/gatedChannel/participant',
        parentContextId : channel1Record.message.contextId,
      });
      const participantDanielRecordAttempt2Reply
        = await dwn.processMessage(alice.did, participantDanielRecordAttempt2.message, { dataStream: participantDanielRecordAttempt2.dataStream });
      expect(participantDanielRecordAttempt2Reply.status.code).toBe(202);

      // 10. Bob can invoke the participant role to write a chat message in the channel
      const bobChatMessage = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        protocol        : protocolDefinition.protocol,
        protocolRole    : 'community/gatedChannel/participant',
        protocolPath    : 'community/gatedChannel/message',
        parentContextId : channel1Record.message.contextId
      });
      const bobChatMessageReply = await dwn.processMessage(alice.did, bobChatMessage.message, { dataStream: bobChatMessage.dataStream });
      expect(bobChatMessageReply.status.code).toBe(202);

      // 11. Carol can invoke the participant role to read chat messages in the channel
      const carolQuery = await RecordsQuery.create({
        signer       : Jws.createSigner(carol),
        protocolRole : 'community/gatedChannel/participant',
        filter       : {
          protocol     : protocolDefinition.protocol,
          protocolPath : 'community/gatedChannel/message',
          contextId    : channel1Record.message.contextId
        }
      });
      const carolQueryReply = await dwn.processMessage(alice.did, carolQuery.message);
      expect(carolQueryReply.status.code).toBe(200);
      expect(carolQueryReply.entries?.[0].recordId).toBe(bobChatMessage.message.recordId);

      // 12. Carol can invoke the participant role to react to Bob's chat message in the channel
      const carolReaction = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        protocol        : protocolDefinition.protocol,
        protocolRole    : 'community/gatedChannel/participant',
        protocolPath    : 'community/gatedChannel/message/reaction',
        parentContextId : bobChatMessage.message.contextId
      });
      const carolReactionReply = await dwn.processMessage(alice.did, carolReaction.message, { dataStream: carolReaction.dataStream });
      expect(carolReactionReply.status.code).toBe(202);

      // 13. Mallory CANNOT invoke the participant role (which she is not given) to read the chat messages in the channel
      const malloryQuery = await RecordsQuery.create({
        signer       : Jws.createSigner(mallory),
        protocolRole : 'community/gatedChannel/participant',
        filter       : {
          protocol     : protocolDefinition.protocol,
          protocolPath : 'community/gatedChannel/message',
          contextId    : channel1Record.message.contextId
        }
      });
      const malloryQueryReply = await dwn.processMessage(alice.did, malloryQuery.message);
      expect(malloryQueryReply.status.code).toBe(401);
      expect(malloryQueryReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);

      // 14. Mallory CANNOT invoke the participant role (which she is not given) to write a chat message in the channel
      const malloryChatMessage = await TestDataGenerator.generateRecordsWrite({
        author          : mallory,
        protocol        : protocolDefinition.protocol,
        protocolRole    : 'community/gatedChannel/participant',
        protocolPath    : 'community/gatedChannel/message',
        parentContextId : channel1Record.message.contextId
      });
      const malloryChatMessageReply = await dwn.processMessage(alice.did, malloryChatMessage.message, { dataStream: malloryChatMessage.dataStream });
      expect(malloryChatMessageReply.status.code).toBe(401);
      expect(malloryChatMessageReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
    });
  });
}
