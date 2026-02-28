/**
 * fast-check arbitraries for generating ProtocolDefinition structures.
 * Generates both valid-ish and adversarial protocol definitions for fuzzing
 * ProtocolsConfigure.validateProtocolDefinition().
 */
import type { Arbitrary } from 'fast-check';
import type { ProtocolAction, ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet, ProtocolType } from '../../../src/types/protocols-types.js';

import fc from 'fast-check';

/** Simple identifier names used as type/path keys in protocol definitions. */
const typeNames = ['post', 'comment', 'reply', 'thread', 'image', 'profile', 'message', 'attachment', 'reaction', 'vote'];

/** Valid data format strings. */
const dataFormats = ['application/json', 'text/plain', 'image/png', 'application/octet-stream', 'text/html'];

/** Valid protocol actions. */
const protocolActions: ProtocolAction[] = ['create', 'read', 'update', 'delete', 'co-update', 'co-delete'] as ProtocolAction[];

/**
 * Generates a ProtocolType definition.
 */
export function protocolType(): Arbitrary<ProtocolType> {
  return fc.record({
    schema      : fc.option(fc.webUrl(), { nil: undefined }),
    dataFormats : fc.option(
      fc.array(fc.constantFrom(...dataFormats), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
  });
}

/**
 * Generates a single ProtocolActionRule.
 */
export function actionRule(): Arbitrary<ProtocolActionRule> {
  return fc.oneof(
    // anyone can [actions]
    fc.record({
      who : fc.constant('anyone' as const),
      can : fc.array(fc.constantFrom(...protocolActions), { minLength: 1, maxLength: 3 }),
    }),
    // author/recipient of [path] can [actions]
    fc.record({
      who : fc.constantFrom('author', 'recipient'),
      of  : fc.constantFrom(...typeNames),
      can : fc.array(fc.constantFrom(...protocolActions), { minLength: 1, maxLength: 3 }),
    }),
    // role can [actions]
    fc.record({
      role : fc.constantFrom(...typeNames),
      can  : fc.array(fc.constantFrom(...protocolActions), { minLength: 1, maxLength: 3 }),
    }),
  );
}

/**
 * Generates a ProtocolRuleSet (a single node in the protocol `structure` tree).
 * Recursion depth is bounded to prevent stack overflow.
 */
export function ruleSet(maxDepth: number = 2): Arbitrary<ProtocolRuleSet> {
  if (maxDepth <= 0) {
    // Leaf node: just actions, no nested children
    return fc.record({
      $actions: fc.option(
        fc.array(actionRule(), { minLength: 1, maxLength: 3 }),
        { nil: undefined }
      ),
    }) as Arbitrary<ProtocolRuleSet>;
  }

  return fc.record({
    $actions: fc.option(
      fc.array(actionRule(), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
    children: fc.option(
      fc.dictionary(
        fc.constantFrom(...typeNames),
        ruleSet(maxDepth - 1),
        { minKeys: 0, maxKeys: 3 },
      ),
      { nil: undefined }
    ),
  }).map(({ $actions, children }) => {
    const result: Record<string, unknown> = {};
    if ($actions !== undefined) {
      result.$actions = $actions;
    }
    if (children !== undefined) {
      for (const [key, value] of Object.entries(children)) {
        result[key] = value;
      }
    }
    return result as ProtocolRuleSet;
  });
}

/**
 * Generates a ProtocolDefinition with plausible structure.
 * Types are generated to roughly match the structure keys.
 */
export function protocolDefinition(): Arbitrary<ProtocolDefinition> {
  return fc.record({
    protocol  : fc.webUrl(),
    published : fc.boolean(),
    types     : fc.dictionary(
      fc.constantFrom(...typeNames),
      protocolType(),
      { minKeys: 1, maxKeys: 5 },
    ),
    structure: fc.dictionary(
      fc.constantFrom(...typeNames),
      ruleSet(2),
      { minKeys: 1, maxKeys: 4 },
    ),
  });
}

/**
 * Generates an adversarial protocol definition designed to stress validation.
 * Includes deeply nested structures, invalid URLs, and unusual type configurations.
 */
export function adversarialProtocolDefinition(): Arbitrary<Record<string, unknown>> {
  return fc.oneof(
    // Deeply nested structure
    fc.record({
      protocol  : fc.string({ minLength: 1, maxLength: 200 }),
      published : fc.boolean(),
      types     : fc.dictionary(fc.string({ minLength: 1, maxLength: 30 }), fc.anything(), { minKeys: 0, maxKeys: 10 }),
      structure : fc.dictionary(fc.string({ minLength: 1, maxLength: 30 }), fc.anything(), { minKeys: 0, maxKeys: 10 }),
    }),
    // Missing required fields
    fc.record({
      protocol: fc.string(),
    }),
    // Extra unexpected fields
    fc.record({
      protocol  : fc.webUrl(),
      published : fc.boolean(),
      types     : fc.constant({}),
      structure : fc.constant({}),
      extra     : fc.anything(),
    }),
    // Completely random object
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.anything(),
      { minKeys: 0, maxKeys: 10 },
    ),
  );
}
