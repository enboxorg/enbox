import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/measurements/v1',
  published : true,
  types     : {
    measurement: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/measurements/v1/schemas/measurement',
    },
  },
  structure: {
    measurement: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
