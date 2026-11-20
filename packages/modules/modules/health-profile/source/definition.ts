import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/health-profile/v1',
  published : true,
  types     : {
    profile: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/health-profile/v1/schemas/profile',
    },
    condition: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/health-profile/v1/schemas/condition',
    },
    allergy: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/health-profile/v1/schemas/allergy',
    },
  },
  structure: {
    profile: {
      $size: {
        max: 1048576,
      },
      $recordLimit: {
        max: 1,
      },
      condition: {
        $size: {
          max: 1048576,
        },
      },
      allergy: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
