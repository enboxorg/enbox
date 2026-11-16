import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/podcasts/v1',
  published : true,
  types     : {
    show: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/podcasts/v1/schemas/show',
    },
    episode: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/podcasts/v1/schemas/episode',
    },
    playback: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/podcasts/v1/schemas/playback',
    },
  },
  structure: {
    show: {
      $size: {
        max: 1048576,
      },
      episode: {
        $size: {
          max: 1048576,
        },
        playback: {
          $size: {
            max: 1048576,
          },
          $recordLimit: {
            max: 1,
          },
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
