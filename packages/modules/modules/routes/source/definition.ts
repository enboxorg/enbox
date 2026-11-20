import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/routes/v1',
  published : true,
  types     : {
    route: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/routes/v1/schemas/route',
    },
    waypoint: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/routes/v1/schemas/waypoint',
    },
    track: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/routes/v1/schemas/track',
    },
    editor: {
      schema             : 'https://enbox.id/modules/routes/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/routes/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    route: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'route/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'route/viewer',
          can  : ['read'],
        },
      ],
      waypoint: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'route/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'route/viewer',
            can  : ['read'],
          },
        ],
      },
      track: {
        $size: {
          max: 1048576,
        },
        $immutable : true,
        $actions   : [
          {
            role : 'route/editor',
            can  : ['create', 'read', 'delete'],
          },
          {
            role : 'route/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('route/editor'),
      viewer : roleDefinition('route/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
