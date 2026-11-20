import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/trips/v1',
  published : true,
  types     : {
    trip: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/trips/v1/schemas/trip',
    },
    item: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/trips/v1/schemas/item',
    },
    editor: {
      schema             : 'https://enbox.id/modules/trips/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/trips/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    trip: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'trip/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'trip/viewer',
          can  : ['read'],
        },
      ],
      item: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'trip/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'trip/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('trip/editor'),
      viewer : roleDefinition('trip/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
