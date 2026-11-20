import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/conversations/v1',
  published : true,
  types     : {
    conversation: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/conversations/v1/schemas/conversation',
    },
    message: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/conversations/v1/schemas/message',
    },
    reaction: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/conversations/v1/schemas/reaction',
    },
    state: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/conversations/v1/schemas/state',
    },
    editor: {
      schema             : 'https://enbox.id/modules/conversations/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/conversations/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    conversation: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'conversation/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'conversation/viewer',
          can  : ['read'],
        },
      ],
      message: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'conversation/editor',
            can  : ['create', 'read', 'update', 'delete'],
          },
          {
            role : 'conversation/viewer',
            can  : ['read'],
          },
        ],
        reaction: {
          $size: {
            max: 1048576,
          },
          $immutable : true,
          $actions   : [
            {
              role : 'conversation/editor',
              can  : ['create', 'read', 'delete'],
            },
            {
              role : 'conversation/viewer',
              can  : ['read'],
            },
          ],
        },
      },
      editor : roleDefinition('conversation/editor'),
      viewer : roleDefinition('conversation/viewer'),
    },
    state: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
