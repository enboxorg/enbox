import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

export const IdentityProtocolDefinition: ProtocolDefinition = {
  protocol  : 'http://identity.foundation/protocols/web5/identity-store',
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

export const KeyDeliveryProtocolDefinition: ProtocolDefinition = {
  protocol  : 'https://enbox.org/protocols/key-delivery',
  published : false,
  types     : {
    contextKey: {
      dataFormats: ['application/json']
    }
  },
  structure: {
    contextKey: {
      $actions: [
        { who: 'recipient', of: 'contextKey', can: ['read'] },
      ],
      $tags: {
        $requiredTags       : ['protocol', 'contextId'],
        $allowUndefinedTags : false,
        protocol            : { type: 'string' },
        contextId           : { type: 'string' },
      },
    }
  }
};

export const JwkProtocolDefinition: ProtocolDefinition = {
  protocol  : 'http://identity.foundation/protocols/web5/jwk-store',
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