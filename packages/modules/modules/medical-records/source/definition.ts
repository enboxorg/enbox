import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/medical-records/v1',
  published : true,
  types     : {
    document: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/medical-records/v1/schemas/document',
    },
    visit: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/medical-records/v1/schemas/visit',
    },
    immunization: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/medical-records/v1/schemas/immunization',
    },
  },
  structure: {
    document: {
      $size: {
        max: 1048576,
      },
    },
    visit: {
      $size: {
        max: 1048576,
      },
    },
    immunization: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
