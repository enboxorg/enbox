import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/bills/v1',
  published : true,
  types     : {
    bill: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/bills/v1/schemas/bill',
    },
    payment: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/bills/v1/schemas/payment',
    },
  },
  structure: {
    bill: {
      $size: {
        max: 1048576,
      },
      payment: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
    },
  },
} as const satisfies ModuleDefinition;
