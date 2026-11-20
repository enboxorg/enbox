import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/places/v1',
  published : true,
  types     : {
    place: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/places/v1/schemas/place',
    },
    editor: {
      schema             : 'https://enbox.id/modules/places/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/places/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    place: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'place/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'place/viewer',
          can  : ['read'],
        },
      ],
      editor : roleDefinition('place/editor'),
      viewer : roleDefinition('place/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
