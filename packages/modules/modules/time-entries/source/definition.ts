import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/time-entries/v1',
  published : true,
  types     : {
    entry: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/time-entries/v1/schemas/entry',
    },
  },
  structure: {
    entry: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
