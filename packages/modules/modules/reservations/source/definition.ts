import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/reservations/v1',
  published : true,
  types     : {
    reservation: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/reservations/v1/schemas/reservation',
    },
    change: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/reservations/v1/schemas/change',
    },
  },
  structure: {
    reservation: {
      $size: {
        max: 1048576,
      },
      change: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
    },
  },
} as const satisfies ModuleDefinition;
