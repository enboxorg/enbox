import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/recipes/v1',
  published : true,
  types     : {
    recipe: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/recipes/v1/schemas/recipe',
    },
    variation: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/recipes/v1/schemas/variation',
    },
    editor: {
      schema             : 'https://enbox.id/modules/recipes/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/recipes/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    recipe: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'recipe/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'recipe/viewer',
          can  : ['read'],
        },
      ],
      variation: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'recipe/editor',
            can  : ['create', 'read', 'update', 'delete'],
          },
          {
            role : 'recipe/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('recipe/editor'),
      viewer : roleDefinition('recipe/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
