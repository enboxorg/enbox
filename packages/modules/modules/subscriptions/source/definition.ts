import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/subscriptions/v1',
  published : true,
  types     : {
    subscription: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/subscriptions/v1/schemas/subscription',
    },
    change: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/subscriptions/v1/schemas/change',
    },
  },
  structure: {
    subscription: {
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
