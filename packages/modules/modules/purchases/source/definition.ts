import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/purchases/v1',
  published : true,
  types     : {
    purchase: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/purchases/v1/schemas/purchase',
    },
    item: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/purchases/v1/schemas/item',
    },
    return: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/purchases/v1/schemas/return',
    },
  },
  structure: {
    purchase: {
      $size: {
        max: 1048576,
      },
      item: {
        $size: {
          max: 1048576,
        },
      },
      return: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
