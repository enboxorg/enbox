import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/bookmarks/v1',
  published : true,
  types     : {
    bookmark: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/bookmarks/v1/schemas/bookmark',
    },
    folder: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/bookmarks/v1/schemas/folder',
    },
    entry: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/bookmarks/v1/schemas/entry',
    },
    editor: {
      schema             : 'https://enbox.id/modules/bookmarks/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/bookmarks/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    bookmark: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'bookmark/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'bookmark/viewer',
          can  : ['read'],
        },
      ],
      editor : roleDefinition('bookmark/editor'),
      viewer : roleDefinition('bookmark/viewer'),
    },
    folder: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'folder/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'folder/viewer',
          can  : ['read'],
        },
      ],
      entry: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'folder/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'folder/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('folder/editor'),
      viewer : roleDefinition('folder/viewer'),
    },
  },
} as const satisfies ModuleDefinition;
