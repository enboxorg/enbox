import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/movies-tv/v1',
  published : true,
  types     : {
    title: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/movies-tv/v1/schemas/title',
    },
    viewing: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/movies-tv/v1/schemas/viewing',
    },
    rating: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/movies-tv/v1/schemas/rating',
    },
  },
  structure: {
    title: {
      $size: {
        max: 1048576,
      },
      viewing: {
        $size: {
          max: 1048576,
        },
      },
      rating: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
