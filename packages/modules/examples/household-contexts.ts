import type { Enbox } from '@enbox/api';

import { CollaborationModule } from '../src/collaboration.js';
import { defineApplicationManifest } from '@enbox/api';
import { householdApplication } from './household.js';
import { SharedGroceriesModule } from '../src/shared-groceries.js';
import { SharedMealPlansModule } from '../src/shared-meal-plans.js';
import { SharedTasksModule } from '../src/shared-tasks.js';
import { bindContexts, defineContextModule } from '@enbox/contexts';

/** Reuse the existing companion; domain definitions do not invent invitations or follow journals. */
export const HouseholdContextsModule = defineContextModule(CollaborationModule);
export const managedHouseholdApplication = defineApplicationManifest({
  modules: [...householdApplication.modules, HouseholdContextsModule],
});

/** An independent shopping client opens the same context with explicit feature selection. */
export async function listHouseholdShopping(enbox: Enbox, contextId: string): Promise<string[]> {
  const contexts = bindContexts(enbox, HouseholdContextsModule).withModules({
    groceries : SharedGroceriesModule,
    meals     : SharedMealPlansModule,
    tasks     : SharedTasksModule,
  });
  const household = await contexts.open('space', contextId);
  const lists = await household.using(SharedGroceriesModule).records.query('space/list');
  return lists.records.map((record): string => record.id);
}
