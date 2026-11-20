import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/notebook/v1',
  published : true,
  types     : {
    notebook: {
      schema             : 'https://enbox.id/schemas/notebook/v1/notebook',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    page: {
      schema             : 'https://enbox.id/schemas/notebook/v1/page',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    delta: {
      dataFormats        : ['application/octet-stream'],
      encryptionRequired : true,
    },
    attachment: {
      schema             : 'https://enbox.id/schemas/notebook/v1/attachment',
      dataFormats        : ['application/octet-stream'],
      encryptionRequired : true,
    },
    admin: {
      schema      : 'https://enbox.id/schemas/notebook/v1/admin',
      dataFormats : ['application/json'],
    },
    editor: {
      schema      : 'https://enbox.id/schemas/notebook/v1/editor',
      dataFormats : ['application/json'],
    },
    viewer: {
      schema      : 'https://enbox.id/schemas/notebook/v1/viewer',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    notebook: {
      $size: {
        max: 65536,
      },
      page: {
        $size: {
          max: 32768,
        },
        $actions: [
          {
            role : 'notebook/page/admin',
            can  : ['read'],
          },
          {
            role : 'notebook/page/editor',
            can  : ['read'],
          },
          {
            role : 'notebook/page/viewer',
            can  : ['read'],
          },
        ],
        delta: {
          $immutable : true,
          $squash    : true,
          $size      : {
            max: 2097152,
          },
          $actions: [
            {
              role : 'notebook/page/admin',
              can  : ['create', 'squash', 'read'],
            },
            {
              role : 'notebook/page/editor',
              can  : ['create', 'read'],
            },
            {
              role : 'notebook/page/viewer',
              can  : ['read'],
            },
          ],
        },
        attachment: {
          $immutable : true,
          $size      : {
            max: 50004108,
          },
          $actions: [
            {
              role : 'notebook/page/admin',
              can  : ['create', 'delete', 'read'],
            },
            {
              role : 'notebook/page/editor',
              can  : ['create', 'delete', 'read'],
            },
            {
              role : 'notebook/page/viewer',
              can  : ['read'],
            },
          ],
        },
        admin: roleDefinition('notebook/page/admin', {
          selfRead   : false,
          readableBy : ['notebook/page/admin', 'notebook/page/editor', 'notebook/page/viewer'],
        }),
        editor: roleDefinition('notebook/page/editor', {
          selfRead   : false,
          readableBy : ['notebook/page/admin', 'notebook/page/editor', 'notebook/page/viewer'],
        }),
        viewer: roleDefinition('notebook/page/viewer', { selfRead: false }),
      },
    },
  },
} as const satisfies ModuleDefinition;
