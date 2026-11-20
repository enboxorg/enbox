import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/sleep/v1',
  published : true,
  types     : {
    session: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/sleep/v1/schemas/session',
    },
  },
  structure: {
    session: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
