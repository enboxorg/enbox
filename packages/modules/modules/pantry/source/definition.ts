import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/pantry/v1',
  published : true,
  types     : {
    pantry: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/pantry/v1/schemas/pantry',
    },
    item: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/pantry/v1/schemas/item',
    },
    change: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/pantry/v1/schemas/change',
    },
    editor: {
      schema             : 'https://enbox.id/modules/pantry/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/pantry/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    pantry: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'pantry/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'pantry/viewer',
          can  : ['read'],
        },
      ],
      item: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'pantry/editor',
            can  : ['create', 'read', 'co-update'],
          },
          {
            role : 'pantry/viewer',
            can  : ['read'],
          },
        ],
        change: {
          $size: {
            max: 1048576,
          },
          $immutable : true,
          $actions   : [
            {
              role : 'pantry/editor',
              can  : ['create', 'read', 'delete'],
            },
            {
              role : 'pantry/viewer',
              can  : ['read'],
            },
          ],
        },
      },
      editor : roleDefinition('pantry/editor'),
      viewer : roleDefinition('pantry/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
