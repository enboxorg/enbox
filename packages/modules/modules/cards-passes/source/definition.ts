import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/cards-passes/v1',
  published : true,
  types     : {
    pass: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/cards-passes/v1/schemas/pass',
    },
  },
  structure: {
    pass: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
