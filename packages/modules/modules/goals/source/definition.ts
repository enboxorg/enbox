import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/goals/v1',
  published : true,
  types     : {
    goal: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/goals/v1/schemas/goal',
    },
    progress: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/goals/v1/schemas/progress',
    },
  },
  structure: {
    goal: {
      $size: {
        max: 1048576,
      },
      progress: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
    },
  },
} as const satisfies ModuleDefinition;
