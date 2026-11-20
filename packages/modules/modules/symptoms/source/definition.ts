import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/symptoms/v1',
  published : true,
  types     : {
    episode: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/symptoms/v1/schemas/episode',
    },
  },
  structure: {
    episode: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
