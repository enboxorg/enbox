import type { ModuleActionRule, ModuleDefinition, ModuleRuleSet, ModuleType } from '@enbox/dwn-sdk-js';

import { ModulesConfigure, resolveModuleGraph } from '@enbox/dwn-sdk-js';

import { assertModulePath, assertRoleReference } from './roles.js';

export type AttachModuleDefinitionOptions = {
  module: string;
  source: ModuleDefinition;
  /** One concrete source root; owner-local sibling state is deliberately excluded. */
  root: string;
  provider: ModuleDefinition;
  parentPath: string;
  alias: string;
  attachment: string;
  /** Explicit local source-role to provider-role mappings; one source role may map to several provider roles. */
  roleBindings: Readonly<Record<string, readonly string[]>>;
  /** Complete actions for the newly attached root, including any intended create authority. */
  rootActions: readonly ModuleActionRule[];
  /** Extra authored definitions needed by either source or provider. */
  dependencies?: readonly ModuleDefinition[];
};

/**
 * Author a concrete extension from an existing record subtree. Source memberships
 * are replaced with explicit provider references, never copied or implicitly merged.
 * Run codegen on the result for literal-preserving typed application exports.
 */
export function attachModuleDefinition(options: AttachModuleDefinitionOptions): ModuleDefinition {
  if (options.module === options.source.module) {
    throw new TypeError('attachModuleDefinition: an extension must have its own module URI.');
  }
  return buildAttachment(options, false);
}

/** Add another structural location for an existing record tree while keeping its module and payload identities. */
export function addModuleAttachment(options: Omit<AttachModuleDefinitionOptions, 'module'>): ModuleDefinition {
  if (Object.hasOwn(options.source.structure, options.attachment)) {
    throw new TypeError(`addModuleAttachment: '${options.attachment}' conflicts with an existing root.`);
  }
  return buildAttachment({ ...options, module: options.source.module }, true);
}

function buildAttachment(options: AttachModuleDefinitionOptions, includeSource: boolean): ModuleDefinition {
  const { source, provider, root, alias, attachment, parentPath } = options;
  assertModulePath(root);
  assertModulePath(attachment);
  assertModulePath(parentPath);
  if (root.includes('/') || attachment.includes('/') || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(alias)) {
    throw new TypeError('attachModuleDefinition: root, attachment, and alias must be single names.');
  }
  if (options.module === provider.module) {
    throw new TypeError('attachModuleDefinition: an extension must have its own module URI.');
  }
  const sourceRoot = source.structure[root];
  if (sourceRoot === undefined || sourceRoot.$ref !== undefined || sourceRoot.$role === true) {
    throw new TypeError(`attachModuleDefinition: '${root}' must be a concrete source root.`);
  }
  const uses = { ...source.uses };
  if (Object.hasOwn(uses, alias) || Object.values(uses).includes(provider.module)) {
    throw new TypeError('attachModuleDefinition: provider alias or URI conflicts with a source dependency.');
  }
  uses[alias] = provider.module;
  const types: Record<string, ModuleType> = {};
  const boundRoles = new Set<string>();
  const sourceRoles = new Set<string>();
  const rebind = (actions: ModuleActionRule[] = []): ModuleActionRule[] =>
    actions.flatMap((action): ModuleActionRule[] => {
      if (action.role !== undefined && !action.role.includes(':')) {
        const targets = options.roleBindings[action.role];
        if (targets === undefined || targets.length === 0) {
          throw new TypeError(`attachModuleDefinition: source role '${action.role}' needs an explicit binding.`);
        }
        boundRoles.add(action.role);
        return targets.map((role): ModuleActionRule => {
          assertModulePath(role);
          return { ...structuredClone(action), role: `${alias}:${role}` };
        });
      }
      if (action.of !== undefined && !action.of.includes(':')) {
        if (action.of !== root && !action.of.startsWith(`${root}/`)) {
          throw new TypeError(`attachModuleDefinition: actor '${action.of}' lies outside the selected subtree.`);
        }
        return [{ ...structuredClone(action), of: `${attachment}/${action.of}` }];
      }
      return [structuredClone(action)];
    });
  const visit = (node: ModuleRuleSet, path: string): ModuleRuleSet => {
    const result: ModuleRuleSet = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') {
        throw new TypeError('attachModuleDefinition: source subtree must contain concrete records only.');
      }
      if (key === '$actions') {
        result.$actions = rebind(value as ModuleActionRule[]);
      } else if (key.startsWith('$')) {
        result[key] = structuredClone(value);
      } else {
        const child = value as ModuleRuleSet;
        if (child.$role === true) {
          sourceRoles.add(`${path}/${key}`);
          if (options.roleBindings[`${path}/${key}`] === undefined) {
            throw new TypeError(`attachModuleDefinition: membership '${path}/${key}' needs an explicit binding.`);
          }
        } else {
          result[key] = visit(child, `${path}/${key}`);
        }
      }
    }
    const name = path.split('/').at(-1)!;
    if (source.types[name] === undefined) {
      throw new TypeError(`attachModuleDefinition: missing type '${name}'.`);
    }
    types[name] = structuredClone(source.types[name]);
    return result;
  };
  const subtree = visit(sourceRoot, root);
  subtree.$actions = structuredClone([...options.rootActions]);
  for (const role of Object.keys(options.roleBindings)) {
    assertRoleReference(role);
    if (!sourceRoles.has(role) || !boundRoles.has(role)) {
      throw new TypeError(`attachModuleDefinition: unused or unknown source role '${role}'.`);
    }
  }
  const definition: ModuleDefinition = {
    module    : options.module,
    published : includeSource ? source.published : true,
    uses,
    types     : includeSource ? structuredClone(source.types) : types,
    structure : { ...(includeSource ? structuredClone(source.structure) : {}), [attachment]: { $ref: `${alias}:${parentPath}`, [root]: subtree } },
  };
  validateAuthoredGraph(definition, [provider, ...(options.dependencies ?? [])]);
  return definition;
}

/** Validate authored graphs without treating dependency installation as authority. */
export function validateAuthoredGraph(definition: ModuleDefinition, dependencies: readonly ModuleDefinition[]): void {
  const lookup = new Map<string, ModuleDefinition>();
  for (const dependency of dependencies) {
    if (lookup.has(dependency.module)) {
      throw new TypeError(`Duplicate dependency '${dependency.module}'.`);
    }
    lookup.set(dependency.module, dependency);
  }
  ModulesConfigure.validateModuleDefinition(definition, { requireKeyAgreement: false });
  resolveModuleGraph(definition, (uri): ModuleDefinition | undefined => lookup.get(uri), { requireKeyAgreement: false });
}
