import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const IdentityModuleDefinition: ModuleDefinition = {
  module    : 'https://identity.foundation/modules/web5/identity-store',
  published : false,
  types     : {
    portableDid: {
      schema      : 'https://identity.foundation/schemas/web5/portable-did',
      dataFormats : [
        'application/json'
      ]
    },
    identityMetadata: {
      schema      : 'https://identity.foundation/schemas/web5/identity-metadata',
      dataFormats : [
        'application/json'
      ]
    }
  },
  structure: {
    portableDid      : {},
    identityMetadata : {}
  }
};

export const JwkModuleDefinition: ModuleDefinition = {
  module    : 'https://identity.foundation/modules/web5/jwk-store',
  published : false,
  types     : {
    privateJwk: {
      schema             : 'https://identity.foundation/schemas/web5/private-jwk',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
  },
  structure: {
    privateJwk: {}
  }
};
