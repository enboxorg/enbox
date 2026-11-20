import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/belongings/v1',
  published : true,
  types     : {
    item: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/belongings/v1/schemas/item',
    },
    editor: {
      schema             : 'https://enbox.id/modules/belongings/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/belongings/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    item: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'item/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'item/viewer',
          can  : ['read'],
        },
      ],
      editor : roleDefinition('item/editor'),
      viewer : roleDefinition('item/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
