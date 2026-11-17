import type { Enbox } from '@enbox/api';

import { defineApplicationManifest } from '@enbox/api';

import { CollaborationModule } from '../src/collaboration.js';
import { GroceriesModule } from '../src/groceries.js';
import { MealPlansModule } from '../src/meal-plans.js';
import { TasksModule } from '../src/tasks.js';

/** Register this manifest before connecting the application. */
export const householdApplication = defineApplicationManifest({
  modules: [CollaborationModule, GroceriesModule, MealPlansModule, TasksModule],
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
  const list = await enbox.using(GroceriesModule).records.create('space/list', {
    parentContextId : space.contextId,
    data            : { name: 'Weekly groceries' },
  });
  const item = await enbox.using(GroceriesModule).records.create('space/list/item', {
    parentContextId : list.contextId,
    data            : { name: 'Oat milk', state: 'needed', quantity: { value: '2', unit: 'carton' } },
  });
  const plan = await enbox.using(MealPlansModule).records.create('space/plan', {
    parentContextId : space.contextId,
    data            : { name: 'This week' },
  });
  const task = await enbox.using(TasksModule).records.create('space/task', {
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
