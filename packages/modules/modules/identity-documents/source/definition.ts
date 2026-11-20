import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { PayloadSchema, SchemaValue } from '../../../src/catalog-types.js';

import document from './schemas/document.json' with { type: 'json' };
import documentType from './document-type.json' with { type: 'json' };
import extraction from './schemas/extraction.json' with { type: 'json' };
import fields from './identity-fields.json' with { type: 'json' };
import review from './schemas/review.json' with { type: 'json' };

export const definition = {
  module    : 'https://enbox.id/modules/identity-documents/v1',
  published : true,
  types     : {
    document: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/identity-documents/v1/schemas/document',
    },
    extraction: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/identity-documents/v1/schemas/extraction',
    },
    review: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/identity-documents/v1/schemas/review',
    },
  },
  structure: {
    document: {
      $size: {
        max: 1048576,
      },
      extraction: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
      review: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
    },
  },
} as const satisfies ModuleDefinition;

/** Apply the same printed-field contract to current values, original observations, and corrections. */
function withDocumentFields(
  schema: PayloadSchema & { properties: PayloadSchema; allOf?: readonly SchemaValue[] },
  fieldKey: 'fields' | 'corrections',
): PayloadSchema {
  const requireKindFor = (key: string, kind: string): PayloadSchema => ({
    if: {
      required   : [fieldKey],
      properties : { [fieldKey]: { type: 'object', required: [key] } },
    },
    then: {
      required   : ['documentType'],
      properties : { documentType: { const: kind } },
    },
  });
  return {
    ...schema,
    properties : { ...schema.properties, documentType, [fieldKey]: fields },
    allOf      : [
      ...(schema.allOf ?? []),
      requireKindFor('drivingPrivileges', 'drivers-licence'),
      requireKindFor('passportTypeCode', 'passport'),
    ],
  };
}

export const schemas = {
  document   : withDocumentFields(document, 'fields'),
  extraction : withDocumentFields(extraction, 'fields'),
  review     : withDocumentFields(review, 'corrections'),
};
