import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { addModuleAttachment } from '../src/authoring/attachments.js';
import { definition as provider } from './collaboration/source/definition.js';

/** Keep independently owned records and add a matching location inside a Collaboration space. */
export function withCollaborationSpace(source: ModuleDefinition, root: string): ModuleDefinition {
  return addModuleAttachment({
    source, root, provider, parentPath   : 'space', alias        : 'collaboration', attachment   : 'space',
    roleBindings : { [`${root}/editor`]: ['space/admin', 'space/editor'], [`${root}/viewer`]: ['space/viewer'] },
    rootActions  : [
      { role: 'collaboration:space/admin', can: ['create', 'read', 'co-update', 'co-delete'] },
      { role: 'collaboration:space/editor', can: ['create', 'read', 'co-update', 'delete'] },
      { role: 'collaboration:space/viewer', can: ['read'] },
    ],
  });
}
