import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/stock-watchlists/v1',
  published : true,
  types     : {
    watchlist: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/stock-watchlists/v1/schemas/watchlist',
    },
    instrument: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/stock-watchlists/v1/schemas/instrument',
    },
    note: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/stock-watchlists/v1/schemas/note',
    },
    editor: {
      schema             : 'https://enbox.id/modules/stock-watchlists/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/stock-watchlists/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    watchlist: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'watchlist/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'watchlist/viewer',
          can  : ['read'],
        },
      ],
      instrument: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'watchlist/editor',
            can  : ['create', 'read', 'co-update'],
          },
          {
            role : 'watchlist/viewer',
            can  : ['read'],
          },
        ],
        note: {
          $size: {
            max: 1048576,
          },
          $actions: [
            {
              role : 'watchlist/editor',
              can  : ['create', 'read', 'update', 'delete'],
            },
            {
              role : 'watchlist/viewer',
              can  : ['read'],
            },
          ],
        },
      },
      editor : roleDefinition('watchlist/editor'),
      viewer : roleDefinition('watchlist/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
