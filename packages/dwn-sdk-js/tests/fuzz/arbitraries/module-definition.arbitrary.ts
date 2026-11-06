/**
 * fast-check arbitraries for generating ModuleDefinition structures.
 * Generates both valid-ish and adversarial module definitions for fuzzing
 * ModulesConfigure.validateModuleDefinition().
 */
import type { Arbitrary } from 'fast-check';
import type { ModuleAction, ModuleActionRule, ModuleDefinition, ModuleRuleSet, ModuleType } from '../../../src/types/modules-types.js';

import fc from 'fast-check';

/** Simple identifier names used as type/path keys in module definitions. */
const typeNames = ['post', 'comment', 'reply', 'thread', 'image', 'profile', 'message', 'attachment', 'reaction', 'vote'];

/** Valid data format strings. */
const dataFormats = ['application/json', 'text/plain', 'image/png', 'application/octet-stream', 'text/html'];

/** Valid module actions. */
const moduleActions: ModuleAction[] = ['create', 'read', 'update', 'delete', 'co-update', 'co-delete'] as ModuleAction[];

/**
 * Generates a ModuleType definition.
 */
export function moduleType(): Arbitrary<ModuleType> {
  return fc.record({
    schema      : fc.option(fc.webUrl(), { nil: undefined }),
    dataFormats : fc.option(
      fc.array(fc.constantFrom(...dataFormats), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
  });
}

/**
 * Generates a single ModuleActionRule.
 */
export function actionRule(): Arbitrary<ModuleActionRule> {
  return fc.oneof(
    // anyone can [actions]
    fc.record({
      who : fc.constant('anyone' as const),
      can : fc.array(fc.constantFrom(...moduleActions), { minLength: 1, maxLength: 3 }),
    }),
    // author/recipient of [path] can [actions]
    fc.record({
      who : fc.constantFrom('author', 'recipient'),
      of  : fc.constantFrom(...typeNames),
      can : fc.array(fc.constantFrom(...moduleActions), { minLength: 1, maxLength: 3 }),
    }),
    // role can [actions]
    fc.record({
      role : fc.constantFrom(...typeNames),
      can  : fc.array(fc.constantFrom(...moduleActions), { minLength: 1, maxLength: 3 }),
    }),
  );
}

/**
 * Generates a ModuleRuleSet (a single node in the module `structure` tree).
 * Recursion depth is bounded to prevent stack overflow.
 */
export function ruleSet(maxDepth: number = 2): Arbitrary<ModuleRuleSet> {
  if (maxDepth <= 0) {
    // Leaf node: just actions, no nested children
    return fc.record({
      $actions: fc.option(
        fc.array(actionRule(), { minLength: 1, maxLength: 3 }),
        { nil: undefined }
      ),
    }) as Arbitrary<ModuleRuleSet>;
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
    return result as ModuleRuleSet;
  });
}

/**
 * Generates a ModuleDefinition with plausible structure.
 * Types are generated to roughly match the structure keys.
 */
export function moduleDefinition(): Arbitrary<ModuleDefinition> {
  return fc.record({
    module    : fc.webUrl(),
    published : fc.boolean(),
    types     : fc.dictionary(
      fc.constantFrom(...typeNames),
      moduleType(),
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
 * Generates an adversarial module definition designed to stress validation.
 * Includes deeply nested structures, invalid URLs, and unusual type configurations.
 */
export function adversarialModuleDefinition(): Arbitrary<Record<string, unknown>> {
  return fc.oneof(
    // Deeply nested structure
    fc.record({
      module    : fc.string({ minLength: 1, maxLength: 200 }),
      published : fc.boolean(),
      types     : fc.dictionary(fc.string({ minLength: 1, maxLength: 30 }), fc.anything(), { minKeys: 0, maxKeys: 10 }),
      structure : fc.dictionary(fc.string({ minLength: 1, maxLength: 30 }), fc.anything(), { minKeys: 0, maxKeys: 10 }),
    }),
    // Missing required fields
    fc.record({
      module: fc.string(),
    }),
    // Extra unexpected fields
    fc.record({
      module    : fc.webUrl(),
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
