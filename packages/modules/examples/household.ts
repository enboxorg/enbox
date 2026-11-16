import type { Enbox } from '@enbox/api';

import { defineApplicationManifest } from '@enbox/api';

import { CollaborationModule } from '../src/collaboration.js';
import { SharedGroceriesModule } from '../src/shared-groceries.js';
import { SharedMealPlansModule } from '../src/shared-meal-plans.js';
import { SharedTasksModule } from '../src/shared-tasks.js';

/** Register this manifest before connecting the application. */
export const householdApplication = defineApplicationManifest({
  modules: [CollaborationModule, SharedGroceriesModule, SharedMealPlansModule, SharedTasksModule],
});

/** A household setup reused by shopping, meal-planning, and task clients. */
export async function createHousehold(
  enbox: Enbox,
  name: string,
): Promise<{
  spaceId: string;
  contextId: string;
  listId: string;
  listContextId: string;
  itemId: string;
  planId: string;
  taskId: string;
}> {
  const space = await enbox.using(CollaborationModule).records.create('space', { data: { name } });
  const list = await enbox.using(SharedGroceriesModule).records.create('space/list', {
    parentContextId : space.contextId,
    data            : { name: 'Weekly groceries' },
  });
  const item = await enbox.using(SharedGroceriesModule).records.create('space/list/item', {
    parentContextId : list.contextId,
    data            : { name: 'Oat milk', state: 'needed', quantity: { value: '2', unit: 'carton' } },
  });
  const plan = await enbox.using(SharedMealPlansModule).records.create('space/plan', {
    parentContextId : space.contextId,
    data            : { name: 'This week' },
  });
  const task = await enbox.using(SharedTasksModule).records.create('space/task', {
    parentContextId : space.contextId,
    data            : { title: 'Water the plants', state: 'todo' },
  });
  return {
    spaceId       : space.id,
    contextId     : space.contextId!,
    listId        : list.id,
    listContextId : list.contextId!,
    itemId        : item.id,
    planId        : plan.id,
    taskId        : task.id,
  };
}
