import type { SchemaRegistry } from './authoring/schema-bundle.js';

import addressSchema from './schema-values/address.json' with { type: 'json' };
import alertSchema from './schema-values/alert.json' with { type: 'json' };
import instrumentSchema from './schema-values/instrument.json' with { type: 'json' };
import labelsSchema from './schema-values/labels.json' with { type: 'json' };
import moneySchema from './schema-values/money.json' with { type: 'json' };
import noteTextSchema from './schema-values/note-text.json' with { type: 'json' };
import provenanceSchema from './schema-values/provenance.json' with { type: 'json' };
import quantitySchema from './schema-values/quantity.json' with { type: 'json' };
import realtimeLiveSchema from './schema-values/realtime-live.json' with { type: 'json' };
import realtimeSessionSchema from './schema-values/realtime-session.json' with { type: 'json' };
import recordReferenceSchema from './schema-values/record-reference.json' with { type: 'json' };
import recurrenceSchema from './schema-values/recurrence.json' with { type: 'json' };
import roleAssignmentSchema from './schema-values/role-assignment.json' with { type: 'json' };

/** Shared value contracts, bundled locally by module authoring. */
export const sharedSchemas: SchemaRegistry = Object.freeze({
  [addressSchema.$id]         : addressSchema,
  [alertSchema.$id]           : alertSchema,
  [instrumentSchema.$id]      : instrumentSchema,
  [labelsSchema.$id]          : labelsSchema,
  [moneySchema.$id]           : moneySchema,
  [noteTextSchema.$id]        : noteTextSchema,
  [provenanceSchema.$id]      : provenanceSchema,
  [quantitySchema.$id]        : quantitySchema,
  [realtimeLiveSchema.$id]    : realtimeLiveSchema,
  [realtimeSessionSchema.$id] : realtimeSessionSchema,
  [recordReferenceSchema.$id] : recordReferenceSchema,
  [recurrenceSchema.$id]      : recurrenceSchema,
  [roleAssignmentSchema.$id]  : roleAssignmentSchema,
});

export {
  addressSchema,
  alertSchema,
  instrumentSchema,
  labelsSchema,
  moneySchema,
  noteTextSchema,
  provenanceSchema,
  quantitySchema,
  realtimeLiveSchema,
  realtimeSessionSchema,
  recordReferenceSchema,
  recurrenceSchema,
  roleAssignmentSchema,
};
