import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/insurance/v1',
  published : true,
  types     : {
    policy: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/insurance/v1/schemas/policy',
    },
    subject: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/insurance/v1/schemas/subject',
    },
    claim: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/insurance/v1/schemas/claim',
    },
  },
  structure: {
    policy: {
      $size: {
        max: 1048576,
      },
      subject: {
        $size: {
          max: 1048576,
        },
      },
      claim: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
