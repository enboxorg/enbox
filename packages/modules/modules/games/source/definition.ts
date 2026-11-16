import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/games/v1',
  published : true,
  types     : {
    game: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/games/v1/schemas/game',
    },
    session: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/games/v1/schemas/session',
    },
    progress: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/games/v1/schemas/progress',
    },
  },
  structure: {
    game: {
      $size: {
        max: 1048576,
      },
      session: {
        $size: {
          max: 1048576,
        },
      },
      progress: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
