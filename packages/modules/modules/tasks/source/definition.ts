import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/tasks/v1',
  published : true,
  types     : {
    task: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/tasks/v1/schemas/task',
    },
    checklistItem: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/tasks/v1/schemas/checklist-item',
    },
    state: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/tasks/v1/schemas/state',
    },
    editor: {
      schema             : 'https://enbox.id/modules/tasks/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/tasks/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    task: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'task/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'task/viewer',
          can  : ['read'],
        },
      ],
      checklistItem: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'task/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'task/viewer',
            can  : ['read'],
          },
        ],
      },
      editor : roleDefinition('task/editor'),
      viewer : roleDefinition('task/viewer'),
    },
    state: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
