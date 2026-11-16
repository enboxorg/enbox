import { attachModuleDefinition } from '../../../src/authoring/attachments.js';
import checklistItemSchema from '../../tasks/source/schemas/checklist-item.json' with { type: 'json' };
import { definition as provider } from '../../collaboration/source/definition.js';
import { definition as source } from '../../tasks/source/definition.js';
import taskSchema from '../../tasks/source/schemas/task.json' with { type: 'json' };

export const definition = attachModuleDefinition({
  module       : 'https://enbox.id/modules/shared-tasks/v1',
  source,
  root         : 'task',
  provider,
  parentPath   : 'space',
  alias        : 'collaboration',
  attachment   : 'space',
  roleBindings : { 'task/editor': ['space/admin', 'space/editor'], 'task/viewer': ['space/viewer'] },
  rootActions  : [
    { role: 'collaboration:space/admin', can: ['create', 'read', 'co-update', 'co-delete'] },
    { role: 'collaboration:space/editor', can: ['create', 'read', 'co-update', 'delete'] },
    { role: 'collaboration:space/viewer', can: ['read'] },
  ],
});

export const schemas = { task: taskSchema, checklistItem: checklistItemSchema };
