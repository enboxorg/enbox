import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import episode from './schemas/episode.json' with { type: 'json' };
import series from './schemas/series.json' with { type: 'json' };
import work from './schemas/work.json' with { type: 'json' };
import workProperties from './work-properties.json' with { type: 'json' };

export const definition = {
  module    : 'https://enbox.id/modules/media-library/v1',
  published : true,
  types     : {
    work: {
      schema             : 'https://enbox.id/modules/media-library/v1/schemas/work',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    series: {
      schema             : 'https://enbox.id/modules/media-library/v1/schemas/series',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    episode: {
      schema             : 'https://enbox.id/modules/media-library/v1/schemas/episode',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    activity: {
      schema             : 'https://enbox.id/modules/media-library/v1/schemas/activity',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    annotation: {
      schema             : 'https://enbox.id/modules/media-library/v1/schemas/annotation',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
  },
  structure: {
    work: {
      $size: {
        max: 131072,
      },
      activity: {
        $size: {
          max: 65536,
        },
        $immutable: true,
      },
      annotation: {
        $size: {
          max: 131072,
        },
      },
    },
    series: {
      $size: {
        max: 131072,
      },
      episode: {
        $size: {
          max: 131072,
        },
        activity: {
          $size: {
            max: 65536,
          },
          $immutable: true,
        },
        annotation: {
          $size: {
            max: 131072,
          },
        },
      },
      annotation: {
        $size: {
          max: 131072,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;

// Schema.org metadata and library intent have the same meaning on editions, series and episodes.
export const schemas = {
  work    : { ...work, properties: { ...workProperties, ...work.properties } },
  series  : { ...series, properties: { ...workProperties, ...series.properties } },
  episode : { ...episode, properties: { ...workProperties, ...episode.properties } },
};
