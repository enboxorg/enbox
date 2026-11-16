import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://identity.foundation/modules/connect',
  published : true,
  types     : {
    wallet: {
      dataFormats        : ['application/json'],
      encryptionRequired : false,
      schema             : 'https://identity.foundation/schemas/connect/wallet',
    },
  },
  structure: {
    wallet: {
      $size: {
        max: 1048576,
      },
      $recordLimit: {
        max: 1,
      },
      $actions: [
        {
          who : 'anyone',
          can : ['read'],
        },
      ],
    },
  },
} as const satisfies ModuleDefinition;
