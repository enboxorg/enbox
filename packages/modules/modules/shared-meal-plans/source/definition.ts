import { attachModuleDefinition } from '../../../src/authoring/attachments.js';
import mealSchema from '../../meal-plans/source/schemas/meal.json' with { type: 'json' };
import planSchema from '../../meal-plans/source/schemas/plan.json' with { type: 'json' };
import { definition as provider } from '../../collaboration/source/definition.js';
import { definition as source } from '../../meal-plans/source/definition.js';

export const definition = attachModuleDefinition({
  module       : 'https://enbox.id/modules/shared-meal-plans/v1',
  source,
  root         : 'plan',
  provider,
  parentPath   : 'space',
  alias        : 'collaboration',
  attachment   : 'space',
  roleBindings : { 'plan/editor': ['space/admin', 'space/editor'], 'plan/viewer': ['space/viewer'] },
  rootActions  : [
    { role: 'collaboration:space/admin', can: ['create', 'read', 'co-update', 'co-delete'] },
    { role: 'collaboration:space/editor', can: ['create', 'read', 'co-update', 'delete'] },
    { role: 'collaboration:space/viewer', can: ['read'] },
  ],
});

export const schemas = { plan: planSchema, meal: mealSchema };
