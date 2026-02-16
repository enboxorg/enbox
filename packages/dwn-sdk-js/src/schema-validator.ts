import * as precompiledValidators from '../generated/precompiled-validators.js';
import { DwnError, DwnErrorCode } from './core/dwn-error.js';

/** AJV-style validate function with an optional `errors` array after invocation. */
interface ValidateError {
  instancePath: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}
type ValidateFn = ((payload: unknown) => boolean) & { errors?: ValidateError[] };

/**
 * Validates the given payload using JSON schema keyed by the given schema name. Throws if the given payload fails validation.
 * @param schemaName the schema name use to look up the JSON schema to be used for schema validation.
 *                   The list of schema names can be found in compile-validators.js
 * @param payload javascript object to be validated
 */
export function validateJsonSchema(schemaName: string, payload: unknown): void {
  const validateFn = (precompiledValidators as Record<string, ValidateFn>)[schemaName];

  if (!validateFn) {
    throw new DwnError(DwnErrorCode.SchemaValidatorSchemaNotFound, `schema for ${schemaName} not found.`);
  }

  validateFn(payload);

  if (!validateFn.errors) {
    return;
  }

  // AJV is configured by default to stop validating after the 1st error is encountered which means
  // there will only ever be one error;
  const [ errorObj ] = validateFn.errors;
  let { instancePath, message, keyword } = errorObj;

  if (!instancePath) {
    instancePath = schemaName;
  }

  // handle a few frequently occurred errors to give more meaningful error for debugging

  if (keyword === 'additionalProperties') {
    const keyword = errorObj.params.additionalProperty;
    throw new DwnError(DwnErrorCode.SchemaValidatorAdditionalPropertyNotAllowed, `${message}: ${instancePath}: ${keyword}`);
  }

  if (keyword === 'unevaluatedProperties') {
    const keyword = errorObj.params.unevaluatedProperty;
    throw new DwnError(DwnErrorCode.SchemaValidatorUnevaluatedPropertyNotAllowed, `${message}: ${instancePath}: ${keyword}`);
  }

  throw new DwnError(DwnErrorCode.SchemaValidatorFailure, `${instancePath}: ${message}`);
}