import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

import { withCollaborationSpace } from '../../with-collaboration-space.js';

const independent = {
  module    : 'https://enbox.id/modules/groceries/v1',
  published : true,
  types     : {
    list: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/groceries/v1/schemas/list',
    },
    item: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/groceries/v1/schemas/item',
    },
    editor: {
      schema             : 'https://enbox.id/modules/groceries/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/groceries/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    list: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'list/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'list/viewer',
          can  : ['read'],
        },
      ],
      item: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'list/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'list/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('list/editor'),
      viewer : roleDefinition('list/viewer'),
    },
  },
} as const satisfies ModuleDefinition;

export const definition = withCollaborationSpace(independent, 'list');
