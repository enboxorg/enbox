import type { ProtocolTagSchema, ProtocolTagsDefinition } from '../types/protocols-types.js';

type TagSchema = ProtocolTagSchema | Record<string, unknown>;

type TagValidationError = {
  instancePath: string;
  message: string;
};

const allowedTagTypes = new Set(['string', 'number', 'integer', 'boolean', 'array']);
const allowedArrayItemTypes = new Set(['string', 'number', 'integer']);
const numericConstraintKeywords = [ 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum' ];
const stringConstraintKeywords = [ 'minLength', 'maxLength' ];
const arrayConstraintKeywords = [ 'minItems', 'maxItems', 'minContains', 'maxContains' ];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathSegment(segment: string | number): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function appendPath(path: string, segment: string | number): string {
  return `${path}/${pathSegment(segment)}`;
}

function hasOwnProperty(value: Record<string, unknown>, property: string): boolean {
  return Object.hasOwn(value, property);
}

function addError(errors: TagValidationError[], instancePath: string, message: string): void {
  errors.push({ instancePath, message });
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
  }

  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.hasOwn(right, key) && valuesEqual(left[key], right[key]));
  }

  return false;
}

function getTagSchemas(tagsDefinition: ProtocolTagsDefinition): Record<string, TagSchema> {
  const schemas: Record<string, TagSchema> = {};

  for (const [ tag, schema ] of Object.entries(tagsDefinition)) {
    if (tag === '$requiredTags' || tag === '$allowUndefinedTags') {
      continue;
    }

    schemas[tag] = schema as TagSchema;
  }

  return schemas;
}

function validateSchemaConstraintTypes(
  schema: Record<string, unknown>,
  dataPath: string,
  errors: TagValidationError[],
): void {
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      addError(errors, appendPath(dataPath, 'enum'), 'must be non-empty array');
    }
  }

  for (const keyword of numericConstraintKeywords) {
    if (schema[keyword] !== undefined && !isNumber(schema[keyword])) {
      addError(errors, appendPath(dataPath, keyword), 'must be number');
    }
  }

  for (const keyword of [ ...stringConstraintKeywords, ...arrayConstraintKeywords ]) {
    if (schema[keyword] !== undefined && (!Number.isInteger(schema[keyword]) || (schema[keyword] as number) < 0)) {
      addError(errors, appendPath(dataPath, keyword), 'must be integer');
    }
  }

  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
    addError(errors, appendPath(dataPath, 'uniqueItems'), 'must be boolean');
  }
}

function validateTagSubschemaDefinition(
  schema: unknown,
  dataPath: string,
  allowedTypes: Set<string>,
  errors: TagValidationError[],
): void {
  if (!isRecord(schema)) {
    addError(errors, dataPath, 'must be object');
    return;
  }

  if (schema.type !== undefined && (typeof schema.type !== 'string' || !allowedTypes.has(schema.type))) {
    addError(errors, appendPath(dataPath, 'type'), 'must be equal to one of the allowed values');
  }

  validateSchemaConstraintTypes(schema, dataPath, errors);
}

/**
 * Validates DWN protocol tag schema definitions without invoking Ajv's runtime compiler.
 *
 * The broader protocol message shape is already checked by the precompiled
 * ProtocolRuleSet validator. This function covers the tag-schema constraints
 * that are deliberately modeled as a small DWN subset rather than arbitrary
 * JSON Schema.
 */
export function validateProtocolTagSchemaDefinition(
  schema: unknown,
  dataVar: string,
): string | undefined {
  const errors: TagValidationError[] = [];

  validateTagSubschemaDefinition(schema, '', allowedTagTypes, errors);

  if (isRecord(schema)) {
    if (schema.items !== undefined) {
      validateTagSubschemaDefinition(schema.items, '/items', allowedArrayItemTypes, errors);
    }

    if (schema.contains !== undefined) {
      validateTagSubschemaDefinition(schema.contains, '/contains', allowedArrayItemTypes, errors);
    }
  }

  return formatTagValidationErrors(errors, dataVar);
}

function validateType(type: unknown, value: unknown, dataPath: string, errors: TagValidationError[]): boolean {
  switch (type) {
  case undefined:
    return true;
  case 'string':
    if (typeof value === 'string') {
      return true;
    }
    addError(errors, dataPath, 'must be string');
    return false;
  case 'number':
    if (isNumber(value)) {
      return true;
    }
    addError(errors, dataPath, 'must be number');
    return false;
  case 'integer':
    if (isNumber(value) && Number.isInteger(value)) {
      return true;
    }
    addError(errors, dataPath, 'must be integer');
    return false;
  case 'boolean':
    if (typeof value === 'boolean') {
      return true;
    }
    addError(errors, dataPath, 'must be boolean');
    return false;
  case 'array':
    if (Array.isArray(value)) {
      return true;
    }
    addError(errors, dataPath, 'must be array');
    return false;
  default:
    addError(errors, dataPath, 'must match a supported tag schema type');
    return false;
  }
}

function validateEnum(schema: Record<string, unknown>, value: unknown, dataPath: string, errors: TagValidationError[]): void {
  if (Array.isArray(schema.enum) && !schema.enum.some(allowed => valuesEqual(allowed, value))) {
    addError(errors, dataPath, 'must be equal to one of the allowed values');
  }
}

function validateNumberConstraints(
  schema: Record<string, unknown>,
  value: unknown,
  dataPath: string,
  errors: TagValidationError[],
): void {
  if (!isNumber(value)) {
    return;
  }

  if (isNumber(schema.minimum) && value < schema.minimum) {
    addError(errors, dataPath, `must be >= ${schema.minimum}`);
  }

  if (isNumber(schema.maximum) && value > schema.maximum) {
    addError(errors, dataPath, `must be <= ${schema.maximum}`);
  }

  if (isNumber(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) {
    addError(errors, dataPath, `must be > ${schema.exclusiveMinimum}`);
  }

  if (isNumber(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) {
    addError(errors, dataPath, `must be < ${schema.exclusiveMaximum}`);
  }
}

function validateStringConstraints(
  schema: Record<string, unknown>,
  value: unknown,
  dataPath: string,
  errors: TagValidationError[],
): void {
  if (typeof value !== 'string') {
    return;
  }

  if (Number.isInteger(schema.minLength) && value.length < (schema.minLength as number)) {
    addError(errors, dataPath, `must NOT have fewer than ${schema.minLength} characters`);
  }

  if (Number.isInteger(schema.maxLength) && value.length > (schema.maxLength as number)) {
    addError(errors, dataPath, `must NOT have more than ${schema.maxLength} characters`);
  }
}

function validateArrayConstraints(
  schema: Record<string, unknown>,
  value: unknown,
  dataPath: string,
  errors: TagValidationError[],
): void {
  if (!Array.isArray(value)) {
    return;
  }

  if (Number.isInteger(schema.minItems) && value.length < (schema.minItems as number)) {
    addError(errors, dataPath, `must NOT have fewer than ${schema.minItems} items`);
  }

  if (Number.isInteger(schema.maxItems) && value.length > (schema.maxItems as number)) {
    addError(errors, dataPath, `must NOT have more than ${schema.maxItems} items`);
  }

  if (schema.uniqueItems === true) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (valuesEqual(value[i], value[j])) {
          addError(errors, dataPath, 'must NOT have duplicate items');
          return;
        }
      }
    }
  }
}

function validateTagValue(
  schema: unknown,
  value: unknown,
  dataPath: string,
  errors: TagValidationError[],
): void {
  if (!isRecord(schema)) {
    addError(errors, dataPath, 'must match a supported tag schema');
    return;
  }

  const validType = validateType(schema.type, value, dataPath, errors);
  if (!validType) {
    return;
  }

  validateEnum(schema, value, dataPath, errors);
  validateNumberConstraints(schema, value, dataPath, errors);
  validateStringConstraints(schema, value, dataPath, errors);
  validateArrayConstraints(schema, value, dataPath, errors);

  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => validateTagValue(schema.items, item, appendPath(dataPath, index), errors));
  }

  if (Array.isArray(value) && isRecord(schema.contains)) {
    validateContains(schema, value, dataPath, errors);
  }
}

function validateContains(
  schema: Record<string, unknown>,
  value: unknown[],
  dataPath: string,
  errors: TagValidationError[],
): void {
  const minimumCount = Number.isInteger(schema.minContains) ? schema.minContains as number : 1;
  const maximumCount = Number.isInteger(schema.maxContains) ? schema.maxContains as number : undefined;
  const validItemCount = value.filter(item => {
    const itemErrors: TagValidationError[] = [];
    validateTagValue(schema.contains, item, dataPath, itemErrors);
    return itemErrors.length === 0;
  }).length;

  if (validItemCount < minimumCount || (maximumCount !== undefined && validItemCount > maximumCount)) {
    const message = maximumCount === undefined
      ? `must contain at least ${minimumCount} valid item(s)`
      : `must contain at least ${minimumCount} and no more than ${maximumCount} valid item(s)`;
    addError(errors, dataPath, message);
  }
}

/**
 * Validates a record's `descriptor.tags` against a protocol rule set `$tags` definition.
 */
export function validateProtocolTags(
  tagsDefinition: ProtocolTagsDefinition,
  tags: Record<string, unknown>,
  dataVar: string,
): string | undefined {
  const errors: TagValidationError[] = [];
  const tagSchemas = getTagSchemas(tagsDefinition);
  const requiredTags = Array.isArray(tagsDefinition.$requiredTags) ? tagsDefinition.$requiredTags : [];

  for (const requiredTag of requiredTags) {
    if (!hasOwnProperty(tags, requiredTag)) {
      addError(errors, '', `must have required property '${requiredTag}'`);
    }
  }

  if (tagsDefinition.$allowUndefinedTags !== true) {
    for (const tag of Object.keys(tags)) {
      if (tagSchemas[tag] === undefined) {
        addError(errors, '', 'must NOT have additional properties');
      }
    }
  }

  for (const [ tag, schema ] of Object.entries(tagSchemas)) {
    if (hasOwnProperty(tags, tag)) {
      validateTagValue(schema, tags[tag], appendPath('', tag), errors);
    }
  }

  return formatTagValidationErrors(errors, dataVar);
}

function formatTagValidationErrors(errors: TagValidationError[], dataVar: string): string | undefined {
  if (errors.length === 0) {
    return undefined;
  }

  return errors
    .map(error => `${dataVar}${error.instancePath} ${error.message}`)
    .join(', ');
}
