import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/budgets/v1',
  published : true,
  types     : {
    budget: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/budgets/v1/schemas/budget',
    },
    allocation: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/budgets/v1/schemas/allocation',
    },
    editor: {
      schema             : 'https://enbox.id/modules/budgets/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/budgets/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    budget: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'budget/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'budget/viewer',
          can  : ['read'],
        },
      ],
      allocation: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'budget/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'budget/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('budget/editor'),
      viewer : roleDefinition('budget/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
