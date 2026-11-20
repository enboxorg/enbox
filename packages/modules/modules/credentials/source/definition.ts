import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/credentials/v1',
  published : true,
  types     : {
    credential: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/credentials/v1/schemas/credential',
    },
    artifact: {
      dataFormats        : ['application/octet-stream'],
      encryptionRequired : true,
    },
    verification: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/credentials/v1/schemas/verification',
    },
    presentation: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/credentials/v1/schemas/presentation',
    },
  },
  structure: {
    credential: {
      $size: {
        max: 1048576,
      },
      artifact: {
        $size: {
          max: 4194304,
        },
        $immutable   : true,
        $recordLimit : {
          max: 1,
        },
      },
      verification: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
    },
    presentation: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
