import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { ModuleCatalogEntry, PayloadSchema } from '../catalog-types.js';

import { defineModule } from '@enbox/api';
import { ProfileCodecs } from '../profile-codecs.js';
export { ProfileCodecs };
export type { ProfileData, LinkData, AvatarData, HeroData } from '../profile-codecs.js';
export const ProfileDefinition = {
  module    : 'https://identity.foundation/modules/profile',
  published : true,
  types     : {
    profile : { dataFormats: ['application/json'], schema: 'https://identity.foundation/schemas/profile/profile' },
    link    : { dataFormats: ['application/json'], schema: 'https://identity.foundation/schemas/profile/link' },
    avatar  : { dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
    hero    : { dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
  },
  structure: {
    profile: {
      $size        : { max: 10000 },
      $recordLimit : { max: 1 },
      $actions     : [{ who: 'anyone', can: ['read'] }],
      link         : { $actions: [{ who: 'anyone', can: ['read'] }] },
      avatar       : { $size: { max: 12582912 }, $recordLimit: { max: 1 }, $actions: [{ who: 'anyone', can: ['read'] }] },
      hero         : { $size: { max: 25165824 }, $recordLimit: { max: 1 }, $actions: [{ who: 'anyone', can: ['read'] }] },
    },
  },
} as const satisfies ModuleDefinition;
export const ProfileModule = defineModule({ definition: ProfileDefinition, codecs: ProfileCodecs });
export const ProfileSchemas: Readonly<Record<string, PayloadSchema>> = {
  profile: {
    $schema     : 'http://json-schema.org/draft-07/schema#',
    $id         : 'https://identity.foundation/schemas/profile/profile',
    title       : 'ProfileData',
    description : 'Data shape for a profile record.',
    type        : 'object',
    properties  : {
      displayName: {
        type        : 'string',
        description : 'The display name of the identity.',
      },
      bio: {
        type        : 'string',
        description : 'An optional biography.',
      },
      tagline: {
        type        : 'string',
        description : 'An optional tagline.',
      },
      location: {
        type        : 'string',
        description : 'An optional location.',
      },
      website: {
        type        : 'string',
        description : 'An optional website URL.',
      },
      pronouns: {
        type        : 'string',
        description : 'Optional pronouns.',
      },
    },
    required             : ['displayName'],
    additionalProperties : false,
  },
  link: {
    $schema     : 'http://json-schema.org/draft-07/schema#',
    $id         : 'https://identity.foundation/schemas/profile/link',
    title       : 'LinkData',
    description : 'Data shape for an external link record.',
    type        : 'object',
    properties  : {
      url: {
        type        : 'string',
        description : 'The URL of the link.',
      },
      title: {
        type        : 'string',
        description : 'The display title of the link.',
      },
      icon: {
        type        : 'string',
        description : 'An optional icon for the link.',
      },
      sortOrder: {
        type        : 'number',
        description : 'An optional sort order for display.',
      },
    },
    required             : ['url', 'title'],
    additionalProperties : false,
  },
};
export const ProfileCatalog: ModuleCatalogEntry = {
  ...{
    id              : 'profile',
    name            : 'Profiles',
    category        : 'Identity and digital life',
    description     : 'The user\'s self-authored display identity, biography, images, and links.',
    uri             : 'https://identity.foundation/modules/profile',
    exportName      : 'ProfileModule',
    status          : 'experimental',
    captureExamples : ['Update my public bio to this text.'],
    capture         : {
      identity : 'Match the owner\'s self-published profile and selected profile links.',
      exclude  : ['Private contact-book annotations about other people.'],
      workflow : 'Publish deliberate profile fields and media using the established public profile paths.',
    },
    notes        : [],
    dependencies : {},
  },
  definition : ProfileDefinition,
  records    : [
    {
      ...{
        path               : 'profile',
        type               : 'profile',
        dataFormats        : ['application/json'],
        encryptionRequired : false,
        role               : false,
        immutable          : false,
        singleton          : true,
        schemaUri          : 'https://identity.foundation/schemas/profile/profile',
        squashable         : false,
        maxBytes           : 10000,
        actions            : [{ who: 'anyone', can: ['read'] }],
      },
      schema: ProfileSchemas['profile'],
    },
    {
      ...{
        path               : 'profile/link',
        type               : 'link',
        dataFormats        : ['application/json'],
        encryptionRequired : false,
        role               : false,
        immutable          : false,
        singleton          : false,
        schemaUri          : 'https://identity.foundation/schemas/profile/link',
        squashable         : false,
        actions            : [{ who: 'anyone', can: ['read'] }],
      },
      schema: ProfileSchemas['link'],
    },
    {
      ...{
        path               : 'profile/avatar',
        type               : 'avatar',
        dataFormats        : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
        encryptionRequired : false,
        role               : false,
        immutable          : false,
        singleton          : true,
        squashable         : false,
        maxBytes           : 12582912,
        actions            : [{ who: 'anyone', can: ['read'] }],
      },
    },
    {
      ...{
        path               : 'profile/hero',
        type               : 'hero',
        dataFormats        : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
        encryptionRequired : false,
        role               : false,
        immutable          : false,
        singleton          : true,
        squashable         : false,
        maxBytes           : 25165824,
        actions            : [{ who: 'anyone', can: ['read'] }],
      },
    },
  ],
  examples: [
    {
      path     : 'profile',
      encoding : 'json',
      data     : {
        displayName : 'Alex Example',
        bio         : 'Personal data, owned by people.',
      },
    },
    {
      path     : 'profile/link',
      encoding : 'json',
      data     : {
        url   : 'https://example.com',
        title : 'Website',
      },
    },
    {
      path       : 'profile/avatar',
      encoding   : 'base64',
      data       : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7fkAAAAASUVORK5CYII=',
      dataFormat : 'image/png',
    },
    {
      path       : 'profile/hero',
      encoding   : 'base64',
      data       : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7fkAAAAASUVORK5CYII=',
      dataFormat : 'image/png',
    },
  ],
};
