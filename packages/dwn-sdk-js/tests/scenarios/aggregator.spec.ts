import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import { type DataStore, DataStream, type MessageStore, type ModuleDefinition, type ResumableTaskStore } from '../../src/index.js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { Dwn } from '../../src/dwn.js';
import { Jws } from '../../src/utils/jws.js';
import { ModulesConfigure } from '../../src/interfaces/modules-configure.js';
import { RecordsQuery } from '../../src/interfaces/records-query.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

// This is a test suite that demonstrates how to use the DWN to create aggregators
// Aggregators allows multiple authors to write records to the aggregator's DID based on a role
//
// NOTE: This will be more evident when we introduce `signWithRole`.
// This would allow writing to your local DWN without any role field, but when writing to an aggregator, you could conform to their own roles.
describe('Aggregator Model', () => {
  let didResolver: DidResolver;
  let messageStore: MessageStore;
  let dataStore: DataStore;
  let resumableTaskStore: ResumableTaskStore;
  let eventLog: EventLog;
  let dwn: Dwn;

  const module = 'https://example.org/notes';

  // A simple module for the user that only allows them to write or read their own notes
  const userModuleDefinition:ModuleDefinition = {
    module,
    published : true,
    types     : {
      note: {
        schema      : 'https://example.org/note',
        dataFormats : ['text/plain', 'application/json'],
      }
    },
    structure: {
      note: {}
    }
  };

  // A simple module that allows members of an aggregator to write notes to the aggregator
  // Anyone can query or read public notes, the rest of the notes are enforced by `recipient/author` rules.
  const aggregatorModuleDefinition:ModuleDefinition = {
    module,
    published : true,
    types     : {
      note: {
        schema      : 'https://example.org/note',
        dataFormats : ['text/plain', 'application/json'],
      },
      member: {
        schema      : 'https://example.org/member',
        dataFormats : ['application/json'],
      }
    },
    structure: {
      member: {
        $role: true,
      },
      note: {
        $actions: [{
          role : 'member',
          can  : ['create', 'update', 'delete']
        }]
      }
    }
  };

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

  it('should support querying from multiple authors', async () => {
    // scenario: Alice, Bob, Carol are members of an aggregator.
    // Alice writes a note to Carol, Bob writes a note to Alice, Carol writes a note to Bob.
    // Daniel is not a member of the aggregator and tries to unsuccessfully write a note to Alice.
    // Daniel can query public notes from multiple authors in a single query.
    // Alice and Bob create private notes with Carol as the recipient.
    // Bob creates a private note to Alice.
    // Daniel does not see the private notes in his query.
    // Carol can see all notes from Alice and Bob in her query, including the private notes intended for her.
    // Alice can see all notes from Bob and Carol in her query, including the private notes intended for her.

    // create aggregator DID and install aggregator note module
    const aggregator = await TestDataGenerator.generateDidKeyPersona();
    const aggregatorModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(aggregator),
      definition : aggregatorModuleDefinition,
    });
    const aggregatorModuleReply = await dwn.processMessage(aggregator.did, aggregatorModuleConfigure.message);
    expect(aggregatorModuleReply.status.code).toBe(202, 'aggregator configure');

    // create 4 users and install user note module
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const aliceModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(alice),
      definition : userModuleDefinition,
    });
    const aliceModuleReply = await dwn.processMessage(alice.did, aliceModuleConfigure.message);
    expect(aliceModuleReply.status.code).toBe(202, 'alice configure');

    const bob = await TestDataGenerator.generateDidKeyPersona();
    const bobModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(bob),
      definition : userModuleDefinition,
    });
    const bobModuleReply = await dwn.processMessage(bob.did, bobModuleConfigure.message);
    expect(bobModuleReply.status.code).toBe(202, 'bob configure');

    const carol = await TestDataGenerator.generateDidKeyPersona();
    const carolModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(carol),
      definition : userModuleDefinition,
    });
    const carolModuleReply = await dwn.processMessage(carol.did, carolModuleConfigure.message);
    expect(carolModuleReply.status.code).toBe(202, 'carol configure');

    const daniel = await TestDataGenerator.generateDidKeyPersona();
    const danielModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(daniel),
      definition : userModuleDefinition,
    });
    const danielModuleReply = await dwn.processMessage(daniel.did, danielModuleConfigure.message);
    expect(danielModuleReply.status.code).toBe(202, 'daniel configure');


    // The aggregator creates member records for alice, bob and carol

    const aliceMemberData = TestDataGenerator.randomBytes(256);
    const aliceMember = await RecordsWrite.create({
      signer     : Jws.createSigner(aggregator),
      recipient  : alice.did,
      module     : userModuleDefinition.module,
      modulePath : 'member',
      schema     : 'https://example.org/member',
      dataFormat : 'application/json',
      data       : aliceMemberData,
    });
    const aliceMemberReply = await dwn.processMessage(aggregator.did, aliceMember.message, { dataStream: DataStream.fromBytes(aliceMemberData) });
    expect(aliceMemberReply.status.code).toBe(202, 'alice member ' + aliceMemberReply.status.detail);

    const bobMemberData = TestDataGenerator.randomBytes(256);
    const bobMember = await RecordsWrite.create({
      signer     : Jws.createSigner(aggregator),
      recipient  : bob.did,
      module     : userModuleDefinition.module,
      modulePath : 'member',
      schema     : 'https://example.org/member',
      dataFormat : 'application/json',
      data       : bobMemberData,
    });
    const bobMemberReply = await dwn.processMessage(aggregator.did, bobMember.message, { dataStream: DataStream.fromBytes(bobMemberData) });
    expect(bobMemberReply.status.code).toBe(202, 'bob member');

    const carolMemberData = TestDataGenerator.randomBytes(256);
    const carolMember = await RecordsWrite.create({
      signer     : Jws.createSigner(aggregator),
      recipient  : carol.did,
      module     : userModuleDefinition.module,
      modulePath : 'member',
      schema     : 'https://example.org/member',
      dataFormat : 'application/json',
      data       : carolMemberData,
    });

    const carolMemberReply = await dwn.processMessage(aggregator.did, carolMember.message, { dataStream: DataStream.fromBytes(carolMemberData) });
    expect(carolMemberReply.status.code).toBe(202, 'carol member');

    // alice writes a public note to carol and posts it in the aggregator
    const aliceNoteData = TestDataGenerator.randomBytes(256);
    const aliceNoteToCarol = await RecordsWrite.create({
      signer     : Jws.createSigner(alice),
      recipient  : carol.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : aliceNoteData,
      moduleRole : 'member'
    });

    // Alice writes it to her own DWN and the aggregator
    const aliceLocalDWN = await dwn.processMessage(alice.did, aliceNoteToCarol.message, { dataStream: DataStream.fromBytes(aliceNoteData) });
    expect(aliceLocalDWN.status.code).toBe(202, 'alice note');
    const aliceAggregatorDWN = await dwn.processMessage(aggregator.did, aliceNoteToCarol.message, {
      dataStream: DataStream.fromBytes(aliceNoteData)
    });
    expect(aliceAggregatorDWN.status.code).toBe(202, 'alice note aggregator');

    // bob writes a public note to alice and posts it in the aggregator
    const bobNoteToAliceData = TestDataGenerator.randomBytes(256);
    const bobNoteToAlice = await RecordsWrite.create({
      signer     : Jws.createSigner(bob),
      recipient  : alice.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : bobNoteToAliceData,
      moduleRole : 'member'
    });

    // Bob writes it to his own DWN and the aggregator
    const bobLocalDWN = await dwn.processMessage(bob.did, bobNoteToAlice.message, { dataStream: DataStream.fromBytes(bobNoteToAliceData) });
    expect(bobLocalDWN.status.code).toBe(202, 'bob note');
    const bobAggregatorDWN = await dwn.processMessage(aggregator.did, bobNoteToAlice.message, {
      dataStream: DataStream.fromBytes(bobNoteToAliceData)
    });
    expect(bobAggregatorDWN.status.code).toBe(202, 'bob note aggregator');

    // carol writes a public note to bob and posts it in the aggregator
    const carolNoteToBobData = TestDataGenerator.randomBytes(256);
    const carolNoteToBob = await RecordsWrite.create({
      signer     : Jws.createSigner(carol),
      recipient  : bob.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : carolNoteToBobData,
      moduleRole : 'member'
    });

    // Carol writes it to her own DWN and the aggregator
    const carolLocalDWN = await dwn.processMessage(carol.did, carolNoteToBob.message, {
      dataStream: DataStream.fromBytes(carolNoteToBobData)
    });
    expect(carolLocalDWN.status.code).toBe(202, 'carol note');
    const carolAggregatorDWN = await dwn.processMessage(aggregator.did, carolNoteToBob.message, {
      dataStream: DataStream.fromBytes(carolNoteToBobData)
    });
    expect(carolAggregatorDWN.status.code).toBe(202, 'carol note aggregator');

    // daniel writes a public note to alice and posts it in the aggregator (which will reject it as he is not a member)
    const danielNoteToAlice = TestDataGenerator.randomBytes(256);
    const danielNote = await RecordsWrite.create({
      signer     : Jws.createSigner(daniel),
      recipient  : alice.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : danielNoteToAlice,
      moduleRole : 'member'
    });

    // Daniel writes it to his own DWN and the aggregator
    const danielLocalDWN = await dwn.processMessage(daniel.did, danielNote.message, { dataStream: DataStream.fromBytes(danielNoteToAlice) });
    expect(danielLocalDWN.status.code).toBe(202, 'daniel note');
    const danielAggregatorDWN = await dwn.processMessage(aggregator.did, danielNote.message, { dataStream: DataStream.fromBytes(danielNoteToAlice) });
    expect(danielAggregatorDWN.status.code).toBe(401, 'daniel note aggregator');


    // daniel can read public notes from multiple authors in a single query
    const danielRead = await RecordsQuery.create({
      signer : Jws.createSigner(daniel),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        author     : [alice.did, bob.did],
      }
    });

    const danielReadReply = await dwn.processMessage(aggregator.did, danielRead.message);
    expect(danielReadReply.status.code).toBe(200, 'daniel read');
    expect(danielReadReply.entries?.length).toBe(2, 'daniel read records');
    expect(danielReadReply.entries![0].recordId).toBe(aliceNoteToCarol.message.recordId, 'daniel read alice note');
    expect(danielReadReply.entries![1].recordId).toBe(bobNoteToAlice.message.recordId, 'daniel read bob note');

    // create  private notes to carol from alice and bob
    const alicePrivateNoteToCarol = TestDataGenerator.randomBytes(256);
    const aliceNoteToCarolPrivate = await RecordsWrite.create({
      signer     : Jws.createSigner(alice),
      recipient  : carol.did,
      published  : false,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : alicePrivateNoteToCarol,
      moduleRole : 'member'
    });

    const aliceNoteToCarolLocal = await dwn.processMessage(alice.did, aliceNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(alicePrivateNoteToCarol)
    });
    expect(aliceNoteToCarolLocal.status.code).toBe(202, 'alice private note');

    const aliceNoteToCarolAggregator = await dwn.processMessage(aggregator.did, aliceNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(alicePrivateNoteToCarol)
    });
    expect(aliceNoteToCarolAggregator.status.code).toBe(202, 'alice private note aggregator');

    const bobPrivateNoteToCarol = TestDataGenerator.randomBytes(256);
    const bobNoteToCarolPrivate = await RecordsWrite.create({
      signer     : Jws.createSigner(bob),
      recipient  : carol.did,
      published  : false,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : bobPrivateNoteToCarol,
      moduleRole : 'member'
    });

    const bobNoteToCarolLocal = await dwn.processMessage(bob.did, bobNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(bobPrivateNoteToCarol)
    });
    expect(bobNoteToCarolLocal.status.code).toBe(202, 'bob private note');

    const bobNoteToCarolAggregator = await dwn.processMessage(aggregator.did, bobNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(bobPrivateNoteToCarol)
    });
    expect(bobNoteToCarolAggregator.status.code).toBe(202, 'bob private note aggregator');

    // create a private note from bob to alice
    const bobNoteToAlicePrivateData = TestDataGenerator.randomBytes(256);
    const bobNoteToAlicePrivate = await RecordsWrite.create({
      signer     : Jws.createSigner(bob),
      recipient  : alice.did,
      published  : false,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : bobNoteToAlicePrivateData,
      moduleRole : 'member'
    });

    const bobNoteToAliceLocal = await dwn.processMessage(bob.did, bobNoteToAlicePrivate.message, {
      dataStream: DataStream.fromBytes(bobNoteToAlicePrivateData)
    });
    expect(bobNoteToAliceLocal.status.code).toBe(202, 'alice private note to bob');
    const bobNoteToAliceAggregator = await dwn.processMessage(aggregator.did, bobNoteToAlicePrivate.message, {
      dataStream: DataStream.fromBytes(bobNoteToAlicePrivateData)
    });
    expect(bobNoteToAliceAggregator.status.code).toBe(202, 'alice private note to bob aggregator');

    // confirm daniel can still only read the public notes
    const danielRead2 = await RecordsQuery.create({
      signer : Jws.createSigner(daniel),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        author     : [alice.did, bob.did],
      }
    });

    const danielReadReply2 = await dwn.processMessage(aggregator.did, danielRead2.message);
    expect(danielReadReply2.status.code).toBe(200, 'daniel read 2');
    expect(danielReadReply2.entries?.length).toBe(2, 'daniel read records 2');
    expect(danielReadReply2.entries![0].recordId).toBe(aliceNoteToCarol.message.recordId, 'daniel read alice note 2');
    expect(danielReadReply2.entries![1].recordId).toBe(bobNoteToAlice.message.recordId, 'daniel read bob note 2');

    // carol queries for notes from alice and bob and gets the public notes and private notes destined for her
    // carol does not see the private note from alice to bob
    const carolRead = await RecordsQuery.create({
      signer : Jws.createSigner(carol),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        author     : [alice.did, bob.did],
      }
    });

    const carolReadReply = await dwn.processMessage(aggregator.did, carolRead.message);
    expect(carolReadReply.status.code).toBe(200, 'carol read');
    expect(carolReadReply.entries?.length).toBe(4, 'carol read records');
    expect(carolReadReply.entries![0].recordId).toBe(aliceNoteToCarol.message.recordId, 'carol read alice note');
    expect(carolReadReply.entries![1].recordId).toBe(bobNoteToAlice.message.recordId, 'carol read bob note');
    expect(carolReadReply.entries![2].recordId).toBe(aliceNoteToCarolPrivate.message.recordId, 'carol read alice private note');
    expect(carolReadReply.entries![3].recordId).toBe(bobNoteToCarolPrivate.message.recordId, 'carol read bob private note');

    // alice queries for notes from bob and carol and gets the public notes and private notes destined for her
    const aliceRead = await RecordsQuery.create({
      signer : Jws.createSigner(alice),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        author     : [bob.did, carol.did],
      }
    });

    const aliceReadReply = await dwn.processMessage(aggregator.did, aliceRead.message);
    expect(aliceReadReply.status.code).toBe(200, 'alice read');
    expect(aliceReadReply.entries?.length).toBe(3, 'alice read records');
    expect(aliceReadReply.entries![0].recordId).toBe(bobNoteToAlice.message.recordId, 'alice note to carol public');
    expect(aliceReadReply.entries![1].recordId).toBe(carolNoteToBob.message.recordId, 'carol note to bob public');
    expect(aliceReadReply.entries![2].recordId).toBe(bobNoteToAlicePrivate.message.recordId, 'bob note to alice private');
  });

  it('should support querying from multiple recipients', async () => {

    // create aggregator DID and install aggregator note module
    const aggregator = await TestDataGenerator.generateDidKeyPersona();
    const aggregatorModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(aggregator),
      definition : aggregatorModuleDefinition,
    });
    const aggregatorModuleReply = await dwn.processMessage(aggregator.did, aggregatorModuleConfigure.message);
    expect(aggregatorModuleReply.status.code).toBe(202, 'aggregator configure');

    // create 4 users and install user note module
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const aliceModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(alice),
      definition : userModuleDefinition,
    });
    const aliceModuleReply = await dwn.processMessage(alice.did, aliceModuleConfigure.message);
    expect(aliceModuleReply.status.code).toBe(202, 'alice configure');

    const bob = await TestDataGenerator.generateDidKeyPersona();
    const bobModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(bob),
      definition : userModuleDefinition,
    });
    const bobModuleReply = await dwn.processMessage(bob.did, bobModuleConfigure.message);
    expect(bobModuleReply.status.code).toBe(202, 'bob configure');

    const carol = await TestDataGenerator.generateDidKeyPersona();
    const carolModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(carol),
      definition : userModuleDefinition,
    });
    const carolModuleReply = await dwn.processMessage(carol.did, carolModuleConfigure.message);
    expect(carolModuleReply.status.code).toBe(202, 'carol configure');

    const daniel = await TestDataGenerator.generateDidKeyPersona();
    const danielModuleConfigure = await ModulesConfigure.create({
      signer     : Jws.createSigner(daniel),
      definition : userModuleDefinition,
    });
    const danielModuleReply = await dwn.processMessage(daniel.did, danielModuleConfigure.message);
    expect(danielModuleReply.status.code).toBe(202, 'daniel configure');


    // The aggregator creates member records for alice, bob and carol

    const aliceMemberData = TestDataGenerator.randomBytes(256);
    const aliceMember = await RecordsWrite.create({
      signer     : Jws.createSigner(aggregator),
      recipient  : alice.did,
      module     : userModuleDefinition.module,
      modulePath : 'member',
      schema     : 'https://example.org/member',
      dataFormat : 'application/json',
      data       : aliceMemberData,
    });
    const aliceMemberReply = await dwn.processMessage(aggregator.did, aliceMember.message, { dataStream: DataStream.fromBytes(aliceMemberData) });
    expect(aliceMemberReply.status.code).toBe(202, 'alice member ' + aliceMemberReply.status.detail);

    const bobMemberData = TestDataGenerator.randomBytes(256);
    const bobMember = await RecordsWrite.create({
      signer     : Jws.createSigner(aggregator),
      recipient  : bob.did,
      module     : userModuleDefinition.module,
      modulePath : 'member',
      schema     : 'https://example.org/member',
      dataFormat : 'application/json',
      data       : bobMemberData,
    });
    const bobMemberReply = await dwn.processMessage(aggregator.did, bobMember.message, { dataStream: DataStream.fromBytes(bobMemberData) });
    expect(bobMemberReply.status.code).toBe(202, 'bob member');

    const carolMemberData = TestDataGenerator.randomBytes(256);
    const carolMember = await RecordsWrite.create({
      signer     : Jws.createSigner(aggregator),
      recipient  : carol.did,
      module     : userModuleDefinition.module,
      modulePath : 'member',
      schema     : 'https://example.org/member',
      dataFormat : 'application/json',
      data       : carolMemberData,
    });

    const carolMemberReply = await dwn.processMessage(aggregator.did, carolMember.message, { dataStream: DataStream.fromBytes(carolMemberData) });
    expect(carolMemberReply.status.code).toBe(202, 'carol member');

    // alice writes a public note to carol and posts it in the aggregator
    const aliceNoteData = TestDataGenerator.randomBytes(256);
    const aliceNoteToCarol = await RecordsWrite.create({
      signer     : Jws.createSigner(alice),
      recipient  : carol.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : aliceNoteData,
      moduleRole : 'member'
    });

    // Alice writes it to her own DWN and the aggregator
    const aliceLocalDWN = await dwn.processMessage(alice.did, aliceNoteToCarol.message, { dataStream: DataStream.fromBytes(aliceNoteData) });
    expect(aliceLocalDWN.status.code).toBe(202, 'alice note');
    const aliceAggregatorDWN = await dwn.processMessage(aggregator.did, aliceNoteToCarol.message, {
      dataStream: DataStream.fromBytes(aliceNoteData)
    });
    expect(aliceAggregatorDWN.status.code).toBe(202, 'alice note aggregator');

    // bob writes a public note to alice and posts it in the aggregator
    const bobNoteToAliceData = TestDataGenerator.randomBytes(256);
    const bobNoteToAlice = await RecordsWrite.create({
      signer     : Jws.createSigner(bob),
      recipient  : alice.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : bobNoteToAliceData,
      moduleRole : 'member'
    });

    // Bob writes it to his own DWN and the aggregator
    const bobLocalDWN = await dwn.processMessage(bob.did, bobNoteToAlice.message, { dataStream: DataStream.fromBytes(bobNoteToAliceData) });
    expect(bobLocalDWN.status.code).toBe(202, 'bob note');
    const bobAggregatorDWN = await dwn.processMessage(aggregator.did, bobNoteToAlice.message, {
      dataStream: DataStream.fromBytes(bobNoteToAliceData)
    });
    expect(bobAggregatorDWN.status.code).toBe(202, 'bob note aggregator');

    // carol writes a public note to bob and posts it in the aggregator
    const carolNoteToBobData = TestDataGenerator.randomBytes(256);
    const carolNoteToBob = await RecordsWrite.create({
      signer     : Jws.createSigner(carol),
      recipient  : bob.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : carolNoteToBobData,
      moduleRole : 'member'
    });

    // Carol writes it to her own DWN and the aggregator
    const carolLocalDWN = await dwn.processMessage(carol.did, carolNoteToBob.message, {
      dataStream: DataStream.fromBytes(carolNoteToBobData)
    });
    expect(carolLocalDWN.status.code).toBe(202, 'carol note');
    const carolAggregatorDWN = await dwn.processMessage(aggregator.did, carolNoteToBob.message, {
      dataStream: DataStream.fromBytes(carolNoteToBobData)
    });
    expect(carolAggregatorDWN.status.code).toBe(202, 'carol note aggregator');

    // daniel writes a public note to alice and posts it in the aggregator (which will reject it as he is not a member)
    const danielNoteToAlice = TestDataGenerator.randomBytes(256);
    const danielNote = await RecordsWrite.create({
      signer     : Jws.createSigner(daniel),
      recipient  : alice.did,
      published  : true,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : danielNoteToAlice,
      moduleRole : 'member'
    });

    // Daniel writes it to his own DWN and the aggregator
    const danielLocalDWN = await dwn.processMessage(daniel.did, danielNote.message, { dataStream: DataStream.fromBytes(danielNoteToAlice) });
    expect(danielLocalDWN.status.code).toBe(202, 'daniel note');
    const danielAggregatorDWN = await dwn.processMessage(aggregator.did, danielNote.message, { dataStream: DataStream.fromBytes(danielNoteToAlice) });
    expect(danielAggregatorDWN.status.code).toBe(401, 'daniel note aggregator');


    // daniel can read public notes from multiple authors in a single query
    const danielRead = await RecordsQuery.create({
      signer : Jws.createSigner(daniel),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        recipient  : [ alice.did, carol.did ],
      }
    });

    const danielReadReply = await dwn.processMessage(aggregator.did, danielRead.message);
    expect(danielReadReply.status.code).toBe(200, 'daniel read');
    expect(danielReadReply.entries?.length).toBe(2, 'daniel read records');
    expect(danielReadReply.entries![0].recordId).toBe(aliceNoteToCarol.message.recordId, 'daniel read alice note');
    expect(danielReadReply.entries![1].recordId).toBe(bobNoteToAlice.message.recordId, 'daniel read bob note');

    // create  private notes to carol from alice and bob
    const alicePrivateNoteToCarol = TestDataGenerator.randomBytes(256);
    const aliceNoteToCarolPrivate = await RecordsWrite.create({
      signer     : Jws.createSigner(alice),
      recipient  : carol.did,
      published  : false,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : alicePrivateNoteToCarol,
      moduleRole : 'member'
    });

    const aliceNoteToCarolLocal = await dwn.processMessage(alice.did, aliceNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(alicePrivateNoteToCarol)
    });
    expect(aliceNoteToCarolLocal.status.code).toBe(202, 'alice private note');

    const aliceNoteToCarolAggregator = await dwn.processMessage(aggregator.did, aliceNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(alicePrivateNoteToCarol)
    });
    expect(aliceNoteToCarolAggregator.status.code).toBe(202, 'alice private note aggregator');

    const bobPrivateNoteToCarol = TestDataGenerator.randomBytes(256);
    const bobNoteToCarolPrivate = await RecordsWrite.create({
      signer     : Jws.createSigner(bob),
      recipient  : carol.did,
      published  : false,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : bobPrivateNoteToCarol,
      moduleRole : 'member'
    });

    const bobNoteToCarolLocal = await dwn.processMessage(bob.did, bobNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(bobPrivateNoteToCarol)
    });
    expect(bobNoteToCarolLocal.status.code).toBe(202, 'bob private note');

    const bobNoteToCarolAggregator = await dwn.processMessage(aggregator.did, bobNoteToCarolPrivate.message, {
      dataStream: DataStream.fromBytes(bobPrivateNoteToCarol)
    });
    expect(bobNoteToCarolAggregator.status.code).toBe(202, 'bob private note aggregator');

    // create a private note from bob to alice
    const bobNoteToAlicePrivateData = TestDataGenerator.randomBytes(256);
    const bobNoteToAlicePrivate = await RecordsWrite.create({
      signer     : Jws.createSigner(bob),
      recipient  : alice.did,
      published  : false,
      module     : userModuleDefinition.module,
      modulePath : 'note',
      dataFormat : 'application/json',
      schema     : 'https://example.org/note',
      data       : bobNoteToAlicePrivateData,
      moduleRole : 'member'
    });

    const bobNoteToAliceLocal = await dwn.processMessage(bob.did, bobNoteToAlicePrivate.message, {
      dataStream: DataStream.fromBytes(bobNoteToAlicePrivateData)
    });
    expect(bobNoteToAliceLocal.status.code).toBe(202, 'alice private note to bob');
    const bobNoteToAliceAggregator = await dwn.processMessage(aggregator.did, bobNoteToAlicePrivate.message, {
      dataStream: DataStream.fromBytes(bobNoteToAlicePrivateData)
    });
    expect(bobNoteToAliceAggregator.status.code).toBe(202, 'alice private note to bob aggregator');

    // confirm daniel can still only read the public notes
    const danielRead2 = await RecordsQuery.create({
      signer : Jws.createSigner(daniel),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        recipient  : [ alice.did, carol.did ],
      }
    });

    const danielReadReply2 = await dwn.processMessage(aggregator.did, danielRead2.message);
    expect(danielReadReply2.status.code).toBe(200, 'daniel read 2');
    expect(danielReadReply2.entries?.length).toBe(2, 'daniel read records 2');
    expect(danielReadReply2.entries![0].recordId).toBe(aliceNoteToCarol.message.recordId, 'daniel read alice note 2');
    expect(danielReadReply2.entries![1].recordId).toBe(bobNoteToAlice.message.recordId, 'daniel read bob note 2');

    // carol queries for notes from alice and bob and gets the public notes and private notes destined for her
    // carol does not see the private note from alice to bob
    const carolRead = await RecordsQuery.create({
      signer : Jws.createSigner(carol),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        recipient  : [ alice.did, carol.did ],
      }
    });

    const carolReadReply = await dwn.processMessage(aggregator.did, carolRead.message);
    expect(carolReadReply.status.code).toBe(200, 'carol read');
    expect(carolReadReply.entries?.length).toBe(4, 'carol read records');
    expect(carolReadReply.entries![0].recordId).toBe(aliceNoteToCarol.message.recordId, 'carol read alice note');
    expect(carolReadReply.entries![1].recordId).toBe(bobNoteToAlice.message.recordId, 'carol read bob note');
    expect(carolReadReply.entries![2].recordId).toBe(aliceNoteToCarolPrivate.message.recordId, 'carol read alice private note');
    expect(carolReadReply.entries![3].recordId).toBe(bobNoteToCarolPrivate.message.recordId, 'carol read bob private note');

    // alice queries for notes from bob and carol and gets the public notes and private notes destined for her
    const aliceRead = await RecordsQuery.create({
      signer : Jws.createSigner(alice),
      filter : {
        module     : userModuleDefinition.module,
        modulePath : 'note',
        recipient  : [ carol.did, bob.did ],
      }
    });

    const aliceReadReply = await dwn.processMessage(aggregator.did, aliceRead.message);
    expect(aliceReadReply.status.code).toBe(200, 'alice read');
    expect(aliceReadReply.entries?.length).toBe(3, 'alice read records');
    expect(aliceReadReply.entries![0].recordId).toBe(aliceNoteToCarol.message.recordId, 'alice note to carol public');
    expect(aliceReadReply.entries![1].recordId).toBe(carolNoteToBob.message.recordId, 'carol note to bob public');
    expect(aliceReadReply.entries![2].recordId).toBe(aliceNoteToCarolPrivate.message.recordId, 'alice to carol private');
  });
});
