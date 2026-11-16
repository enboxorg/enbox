import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/housing/v1',
  published : true,
  types     : {
    residence: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/housing/v1/schemas/residence',
    },
    occupancy: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/housing/v1/schemas/occupancy',
    },
    lease: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/housing/v1/schemas/lease',
    },
  },
  structure: {
    residence: {
      $size: {
        max: 1048576,
      },
      occupancy: {
        $size: {
          max: 1048576,
        },
      },
      lease: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
