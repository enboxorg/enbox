import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/shared-expenses/v1',
  published : true,
  types     : {
    group: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/shared-expenses/v1/schemas/group',
    },
    expense: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/shared-expenses/v1/schemas/expense',
    },
    settlement: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/shared-expenses/v1/schemas/settlement',
    },
    editor: {
      schema             : 'https://enbox.id/modules/shared-expenses/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/shared-expenses/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    group: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'group/editor',
          can  : ['read'],
        },
        {
          role : 'group/viewer',
          can  : ['read'],
        },
      ],
      expense: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'group/editor',
            can  : ['create', 'read', 'update', 'delete'],
          },
          {
            role : 'group/viewer',
            can  : ['read'],
          },
        ],
      },
      settlement: {
        $size: {
          max: 1048576,
        },
        $immutable : true,
        $actions   : [
          {
            role : 'group/editor',
            can  : ['create', 'read', 'delete'],
          },
          {
            role : 'group/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('group/editor'),
      viewer : roleDefinition('group/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
