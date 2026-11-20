import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/workouts/v1',
  published : true,
  types     : {
    routine: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/workouts/v1/schemas/routine',
    },
    workout: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/workouts/v1/schemas/workout',
    },
    exercise: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/workouts/v1/schemas/exercise',
    },
  },
  structure: {
    routine: {
      $size: {
        max: 1048576,
      },
    },
    workout: {
      $size: {
        max: 1048576,
      },
      exercise: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
