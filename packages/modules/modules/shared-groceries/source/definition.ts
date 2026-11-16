import { attachModuleDefinition } from '../../../src/authoring/attachments.js';
import itemSchema from '../../groceries/source/schemas/item.json' with { type: 'json' };
import listSchema from '../../groceries/source/schemas/list.json' with { type: 'json' };
import { definition as provider } from '../../collaboration/source/definition.js';
import { definition as source } from '../../groceries/source/definition.js';

export const definition = attachModuleDefinition({
  module       : 'https://enbox.id/modules/shared-groceries/v1',
  source,
  root         : 'list',
  provider,
  parentPath   : 'space',
  alias        : 'collaboration',
  attachment   : 'space',
  roleBindings : { 'list/editor': ['space/admin', 'space/editor'], 'list/viewer': ['space/viewer'] },
  rootActions  : [
    { role: 'collaboration:space/admin', can: ['create', 'read', 'co-update', 'co-delete'] },
    { role: 'collaboration:space/editor', can: ['create', 'read', 'co-update', 'delete'] },
    { role: 'collaboration:space/viewer', can: ['read'] },
  ],
});

export const schemas = { list: listSchema, item: itemSchema };
