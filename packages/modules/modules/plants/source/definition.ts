import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/plants/v1',
  published : true,
  types     : {
    plant: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/plants/v1/schemas/plant',
    },
    care: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/plants/v1/schemas/care',
    },
    editor: {
      schema             : 'https://enbox.id/modules/plants/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/plants/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    plant: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'plant/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'plant/viewer',
          can  : ['read'],
        },
      ],
      care: {
        $size: {
          max: 1048576,
        },
        $immutable : true,
        $actions   : [
          {
            role : 'plant/editor',
            can  : ['create', 'read', 'delete'],
          },
          {
            role : 'plant/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('plant/editor'),
      viewer : roleDefinition('plant/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
