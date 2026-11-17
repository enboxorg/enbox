import type { ModuleTestActor } from './utils/module-test-world.js';
import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { CollaborationDefinition } from '../src/collaboration.js';
import { ModuleTestWorld } from './utils/module-test-world.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ConversationsCodecs, ConversationsDefinition } from '../src/conversations.js';
import { EventsCodecs, EventsDefinition } from '../src/events.js';
import { GroceriesCodecs, GroceriesDefinition } from '../src/groceries.js';
import { RecordsDelete, RecordsRead, RecordsWrite } from '@enbox/dwn-sdk-js';
import { SharedExpensesCodecs, SharedExpensesDefinition } from '../src/shared-expenses.js';

describe('collaborative state and authored contributions', () => {
  let world: ModuleTestWorld;
  let owner: ModuleTestActor;
  let editor: ModuleTestActor;
  let viewer: ModuleTestActor;
  let attendee: ModuleTestActor;
  let event: RecordsWriteMessage;
  let group: RecordsWriteMessage;
  let list: RecordsWriteMessage;

  async function update(record: RecordsWriteMessage, actor: ModuleTestActor, moduleRole: string): Promise<number> {
    // Retain the original valid ciphertext while signing a new update message.
    const write = await RecordsWrite.createFrom({ recordsWriteMessage: record, signer: actor.signer, moduleRole });
    return (await world.owner.harness.agent.dwn.node.processMessage(owner.did, write.message)).status.code;
  }

  async function remove(record: RecordsWriteMessage, actor: ModuleTestActor, moduleRole: string): Promise<number> {
    const request = await RecordsDelete.create({ recordId: record.recordId, signer: actor.signer, moduleRole });
    return (await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message)).status.code;
  }

  beforeAll(async () => {
    world = await ModuleTestWorld.create([
      CollaborationDefinition, EventsDefinition, SharedExpensesDefinition, GroceriesDefinition, ConversationsDefinition,
    ]);
    [owner, editor, viewer, attendee] = world.actors;
    const eventResult = await world.write({
      actor      : owner,
      definition : EventsDefinition,
      path       : 'event',
      data       : (await EventsCodecs.event.encode({ title: 'Picnic', startsOn: '2026-12-01' })).data,
    });
    const groupResult = await world.write({
      actor      : owner,
      definition : SharedExpensesDefinition,
      path       : 'group',
      data       : (await SharedExpensesCodecs.group.encode({
        name         : 'Friends',
        participants : [
          { id: 'owner', name: 'Owner' },
          { id: 'editor', name: 'Editor' },
        ],
      })).data,
    });
    const listResult = await world.write({
      actor      : owner,
      definition : GroceriesDefinition,
      path       : 'list',
      data       : (await GroceriesCodecs.list.encode({ name: 'Picnic shopping' })).data,
    });
    event = eventResult.message!;
    group = groupResult.message!;
    list = listResult.message!;
    for (const [definition, parent, prefix] of [
      [EventsDefinition, event, 'event'],
      [SharedExpensesDefinition, group, 'group'],
      [GroceriesDefinition, list, 'list'],
    ] as const) {
      await world.assign(definition, `${prefix}/editor`, parent.contextId!, editor);
      await world.assign(definition, `${prefix}/viewer`, parent.contextId!, viewer);
    }
    await world.assign(EventsDefinition, 'event/attendee', event.contextId!, attendee);
  }, 30_000);

  afterAll(async () => {
    await world.close();
  });

  it('uses a separate attendee role for RSVP while viewers remain read-only', async () => {
    const input = {
      definition      : EventsDefinition,
      path            : 'event/response',
      parentContextId : event.contextId,
      data            : (await EventsCodecs.response.encode({ response: 'accepted', respondedAt: '2026-11-15T12:00:00Z' })).data,
    };
    const denied = await world.write({ ...input, actor: viewer, moduleRole: 'event/viewer' });
    expect(denied.reply.status.code, denied.reply.status.detail).toBe(401);
    const response = await world.write({ ...input, actor: attendee, moduleRole: 'event/attendee' });
    expect(response.reply.status.code, response.reply.status.detail).toBe(202);
    expect(await update(response.message!, editor, 'event/editor')).toBe(401);
    expect(await remove(response.message!, editor, 'event/editor')).toBe(401);
    expect(await update(response.message!, attendee, 'event/attendee')).toBe(202);
    expect(await remove(response.message!, attendee, 'event/attendee')).toBe(202);
    expect(await update(event, attendee, 'event/attendee')).toBe(401);
  });

  it('keeps the expense roster owner-managed and financial contributions author-managed', async () => {
    expect(await update(group, editor, 'group/editor')).toBe(401);
    const data = (await SharedExpensesCodecs.expense.encode({
      description : 'Lunch',
      paidBy      : 'owner',
      amount      : { amount: '20', currency: 'USD' },
      shares      : [
        { participantId: 'owner', amount: { amount: '10', currency: 'USD' } },
        { participantId: 'editor', amount: { amount: '10', currency: 'USD' } },
      ],
    })).data;
    const theirs = await world.write({
      actor           : owner,
      definition      : SharedExpensesDefinition,
      path            : 'group/expense',
      parentContextId : group.contextId,
      data,
    });
    expect(theirs.reply.status.code, theirs.reply.status.detail).toBe(202);
    expect(await update(theirs.message!, editor, 'group/editor')).toBe(401);
    expect(await remove(theirs.message!, editor, 'group/editor')).toBe(401);
    const mine = await world.write({
      actor           : editor,
      definition      : SharedExpensesDefinition,
      path            : 'group/expense',
      parentContextId : group.contextId,
      data,
      moduleRole      : 'group/editor',
    });
    expect(mine.reply.status.code, mine.reply.status.detail).toBe(202);
    expect(await update(mine.message!, editor, 'group/editor')).toBe(202);
    expect(await remove(mine.message!, editor, 'group/editor')).toBe(202);
  });

  it('still permits shared editing and deletion of grocery list items', async () => {
    const item = await world.write({
      actor           : owner,
      definition      : GroceriesDefinition,
      path            : 'list/item',
      parentContextId : list.contextId,
      data            : (await GroceriesCodecs.item.encode({ name: 'Apples', state: 'needed' })).data,
    });
    expect(item.reply.status.code, item.reply.status.detail).toBe(202);
    expect(await update(item.message!, editor, 'list/editor')).toBe(202);
    expect(await remove(item.message!, editor, 'list/editor')).toBe(202);
  });

  it('allows deleting an authored message without pruning another participant\'s reactions', async () => {
    const conversation = await world.write({
      actor      : owner,
      definition : ConversationsDefinition,
      path       : 'conversation',
      data       : (await ConversationsCodecs.conversation.encode({ title: 'Friends', kind: 'group' })).data,
    });
    expect(conversation.reply.status.code, conversation.reply.status.detail).toBe(202);
    for (const actor of [editor, attendee]) {
      await world.assign(ConversationsDefinition, 'conversation/editor', conversation.message!.contextId!, actor);
    }
    const message = await world.write({
      actor           : editor,
      definition      : ConversationsDefinition,
      path            : 'conversation/message',
      parentContextId : conversation.message!.contextId,
      moduleRole      : 'conversation/editor',
      data            : (await ConversationsCodecs.message.encode({ role: 'user', text: 'Lunch?', sentAt: '2026-11-15T12:00:00Z' })).data,
    });
    expect(message.reply.status.code, message.reply.status.detail).toBe(202);
    const reaction = await world.write({
      actor           : attendee,
      definition      : ConversationsDefinition,
      path            : 'conversation/message/reaction',
      parentContextId : message.message!.contextId,
      moduleRole      : 'conversation/editor',
      data            : (await ConversationsCodecs.reaction.encode({ value: 'yes', reactedAt: '2026-11-15T12:01:00Z' })).data,
    });
    expect(reaction.reply.status.code, reaction.reply.status.detail).toBe(202);
    const prune = await RecordsDelete.create({
      recordId   : message.message!.recordId,
      signer     : editor.signer,
      moduleRole : 'conversation/editor',
      prune      : true,
    });
    expect((await world.owner.harness.agent.dwn.node.processMessage(owner.did, prune.message)).status.code).toBe(401);
    expect(await remove(message.message!, editor, 'conversation/editor')).toBe(202);
    const read = await RecordsRead.create({
      filter     : { recordId: reaction.message!.recordId },
      signer     : attendee.signer,
      moduleRole : 'conversation/editor',
    });
    expect((await world.owner.harness.agent.dwn.node.processMessage(owner.did, read.message)).status.code).toBe(200);
  });
});
