import type { ModuleTestActor } from './utils/module-test-world.js';
import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { ModuleTestWorld } from './utils/module-test-world.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CollaborationCodecs, CollaborationDefinition } from '../src/collaboration.js';
import { DataStream, RecordsDelete, RecordsRead, RecordsWrite } from '@enbox/dwn-sdk-js';
import { GroceriesCodecs, GroceriesDefinition } from '../src/groceries.js';
import { MealPlansCodecs, MealPlansDefinition } from '../src/meal-plans.js';
import { TasksCodecs, TasksDefinition } from '../src/tasks.js';

describe('shared household membership', () => {
  let world: ModuleTestWorld;
  let owner: ModuleTestActor;
  let admin: ModuleTestActor;
  let editor: ModuleTestActor;
  let viewer: ModuleTestActor;
  let space: RecordsWriteMessage;
  let sibling: RecordsWriteMessage;
  let list: RecordsWriteMessage;
  let mealPlan: RecordsWriteMessage;
  let task: RecordsWriteMessage;
  let otherTask: RecordsWriteMessage;
  let viewerRole: RecordsWriteMessage;

  async function read(actor: ModuleTestActor, record: RecordsWriteMessage, moduleRole?: string): Promise<number> {
    const request = await RecordsRead.create({ filter: { recordId: record.recordId }, signer: actor.signer, moduleRole });
    return (await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message)).status.code;
  }
  async function remove(actor: ModuleTestActor, record: RecordsWriteMessage, moduleRole?: string, prune = false): Promise<number> {
    const request = await RecordsDelete.create({ recordId: record.recordId, signer: actor.signer, moduleRole, prune });
    return (await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message)).status.code;
  }

  beforeAll(async () => {
    world = await ModuleTestWorld.create([
      CollaborationDefinition,
      GroceriesDefinition,
      MealPlansDefinition,
      TasksDefinition,
    ]);
    [owner, admin, editor, viewer] = world.actors;
    for (const name of ['Home', 'Other household']) {
      const created = await world.write({
        actor      : owner,
        definition : CollaborationDefinition,
        path       : 'space',
        data       : (await CollaborationCodecs.space.encode({ name })).data,
      });
      expect(created.reply.status.code, created.reply.status.detail).toBe(202);
      if (name === 'Home') {
        space = created.message!;
      } else {
        sibling = created.message!;
      }
    }
    await world.assign(CollaborationDefinition, 'space/admin', space.contextId!, admin);
    await world.assign(CollaborationDefinition, 'space/editor', space.contextId!, editor);
    viewerRole = await world.assign(CollaborationDefinition, 'space/viewer', space.contextId!, viewer);
    const shopping = await world.write({
      actor           : owner,
      definition      : GroceriesDefinition,
      path            : 'space/list',
      parentContextId : space.contextId,
      data            : (await GroceriesCodecs.list.encode({ name: 'Groceries' })).data,
    });
    list = shopping.message!;
    const meals = await world.write({
      actor           : owner,
      definition      : MealPlansDefinition,
      path            : 'space/plan',
      parentContextId : space.contextId,
      data            : (await MealPlansCodecs.plan.encode({ name: 'This week' })).data,
    });
    mealPlan = meals.message!;
    for (const parent of [space, sibling]) {
      const created = await world.write({
        actor           : owner,
        definition      : TasksDefinition,
        path            : 'space/task',
        parentContextId : parent.contextId,
        data            : (await TasksCodecs.task.encode({ title: 'Water plants', state: 'todo' })).data,
      });
      expect(created.reply.status.code, created.reply.status.detail).toBe(202);
      if (parent === space) {
        task = created.message!;
      } else {
        otherTask = created.message!;
      }
    }
  }, 30_000);

  afterAll(async () => {
    await world.close();
  });

  it('reuses one viewer assignment for all selected features while denying another household', async () => {
    for (const record of [list, mealPlan, task]) {
      expect(await read(viewer, record, 'collaboration:space/viewer')).toBe(200);
    }
    expect(await read(viewer, otherTask, 'collaboration:space/viewer')).toBe(401);
    expect(await remove(viewer, task, 'collaboration:space/viewer')).toBe(401);
  });

  it('keeps a space membership scoped away from independently owned tasks in the same module', async () => {
    const independent = await world.write({
      actor      : owner, definition : TasksDefinition, path       : 'task',
      data       : (await TasksCodecs.task.encode({ title: 'Private task', state: 'todo' })).data,
    });
    expect(independent.reply.status.code).toBe(202);
    expect(await read(viewer, independent.message!, 'collaboration:space/viewer')).toBe(401);
    await world.assign(TasksDefinition, 'task/viewer', independent.message!.contextId!, viewer);
    expect(await read(viewer, independent.message!, 'task/viewer')).toBe(200);
    expect(await read(viewer, task, 'task/viewer')).toBe(401);
  });

  it('encrypts member-authored shopping items through the shared provider and decrypts them for another member', async () => {
    const result = await world.write({
      actor           : editor,
      definition      : GroceriesDefinition,
      path            : 'space/list/item',
      parentContextId : list.contextId,
      moduleRole      : 'collaboration:space/editor',
      data            : (await GroceriesCodecs.item.encode({ name: 'Milk', state: 'needed' })).data,
    });
    expect(result.reply.status.code, result.reply.status.detail).toBe(202);
    const request = await RecordsRead.create({
      filter     : { recordId: result.message!.recordId },
      signer     : viewer.signer,
      moduleRole : 'collaboration:space/viewer',
    });
    const reply = await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message);
    expect(reply.status.code, reply.status.detail).toBe(200);
    const plaintext = await viewer.harness.agent.dwn.decryptRecordData({
      author       : viewer.did,
      target       : owner.did,
      recordsWrite : result.message!,
      moduleRole   : 'collaboration:space/viewer',
      dataStream   : reply.entry!.data!,
    });
    expect(JSON.parse(new TextDecoder().decode(await DataStream.toBytes(plaintext))).name).toBe('Milk');
  });

  it('keeps membership issuance and revocation with the owner even for space administrators', async () => {
    expect(await remove(admin, viewerRole, 'space/admin')).toBe(401);
    const bytes = new TextEncoder().encode('{}');
    const request = await RecordsWrite.create({
      module          : CollaborationDefinition.module,
      modulePath      : 'space/editor',
      schema          : CollaborationDefinition.types.editor.schema,
      parentContextId : space.contextId,
      recipient       : viewer.did,
      dataFormat      : 'application/json',
      data            : bytes,
      signer          : admin.signer,
      moduleRole      : 'space/admin',
    });
    const result = await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message, {
      dataStream: DataStream.fromBytes(bytes),
    });
    expect(result.status.code).toBe(401);
  });

  it('distinguishes author deletion, content moderation and owner-only pruning', async () => {
    const created = await world.write({
      actor           : editor,
      definition      : TasksDefinition,
      path            : 'space/task',
      parentContextId : space.contextId,
      moduleRole      : 'collaboration:space/editor',
      data            : (await TasksCodecs.task.encode({ title: 'My task', state: 'todo' })).data,
    });
    expect(created.reply.status.code).toBe(202);
    expect(await remove(editor, task, 'collaboration:space/editor')).toBe(401);
    expect(await remove(editor, created.message!, 'collaboration:space/editor')).toBe(202);
    expect(await remove(admin, task, 'collaboration:space/admin', true)).toBe(401);
    expect(await remove(admin, task, 'collaboration:space/admin')).toBe(202);
    expect(await remove(admin, space, 'space/admin', true)).toBe(401);
  });

  it('keeps personal state private despite linking a shared record', async () => {
    const state = await world.write({
      actor      : owner,
      definition : TasksDefinition,
      path       : 'state',
      data       : (await TasksCodecs.state.encode({ task: { recordId: task.recordId, moduleUri: TasksDefinition.module }, pinned: true }))
        .data,
    });
    expect(state.reply.status.code).toBe(202);
    expect(await read(viewer, state.message!)).toBe(401);
    expect(TasksDefinition.structure.space).not.toHaveProperty('state');
  });

  it('lets recipients leave and lets owner pruning follow the physical subtree across modules', async () => {
    expect(await remove(viewer, viewerRole)).toBe(202);
    expect(await read(viewer, list, 'collaboration:space/viewer')).toBe(401);
    expect(await remove(owner, space, undefined, true)).toBe(202);
    expect(await read(owner, list)).toBe(404);
    expect(await read(owner, mealPlan)).toBe(404);
    expect(await read(owner, otherTask)).toBe(200);
  });
});
