import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/collaboration/v1',
  published : true,
  types     : {
    space: {
      schema             : 'https://enbox.id/modules/collaboration/v1/schemas/space',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    admin: {
      schema             : 'https://enbox.id/modules/collaboration/v1/schemas/admin',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    editor: {
      schema             : 'https://enbox.id/modules/collaboration/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/collaboration/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    space: {
      $size: {
        max: 16384,
      },
      $actions: [
        {
          role : 'space/admin',
          can  : ['read', 'co-update'],
        },
        {
          role : 'space/editor',
          can  : ['read'],
        },
        {
          role : 'space/viewer',
          can  : ['read'],
        },
      ],
      admin  : roleDefinition('space/admin'),
      editor : roleDefinition('space/editor'),
      viewer : roleDefinition('space/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
