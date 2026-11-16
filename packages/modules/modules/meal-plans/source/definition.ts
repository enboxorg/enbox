import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/meal-plans/v1',
  published : true,
  types     : {
    plan: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/meal-plans/v1/schemas/plan',
    },
    meal: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/meal-plans/v1/schemas/meal',
    },
    editor: {
      schema             : 'https://enbox.id/modules/meal-plans/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/meal-plans/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    plan: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'plan/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'plan/viewer',
          can  : ['read'],
        },
      ],
      meal: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'plan/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'plan/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('plan/editor'),
      viewer : roleDefinition('plan/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
