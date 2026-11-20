import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/online-accounts/v1',
  published : true,
  types     : {
    account: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/online-accounts/v1/schemas/account',
    },
    identityLink: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/online-accounts/v1/schemas/identity-link',
    },
  },
  structure: {
    account: {
      $size: {
        max: 1048576,
      },
      identityLink: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
