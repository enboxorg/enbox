import type { ModuleActionRule, ModuleDefinition, ModuleRuleSet, ModuleType } from '../types/modules-types.js';

import { DwnConstant } from './dwn-constant.js';
import { validateJsonSchema } from '../schema-validator.js';
import { validateModuleUrlNormalized } from '../utils/url.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

/** Synchronous access to the caller's already selected configuration snapshot. */
export type ModuleDefinitionLookup = (moduleUri: string) => ModuleDefinition | undefined;

export type ResolveModuleGraphOptions = {
  /** Installed-key validation is enabled by default. Authored definitions explicitly opt out. */
  requireKeyAgreement?: boolean;
};

export type ResolvedModuleAddress = {
  readonly owningModuleUri: string;
  readonly owningModulePath: string;
};

export type ResolvedAncestorStep = ResolvedModuleAddress & {
  readonly declaringModuleUri: string;
  readonly declaringModulePath: string;
  readonly typeName: string;
  readonly ruleSet: ModuleRuleSet;
  readonly recordType: ModuleType;
};

export type ResolvedRoleReference = ResolvedModuleAddress & {
  readonly rawRole: string;
  /** Physical ancestors in root-to-parent order, excluding the role record. */
  readonly physicalAncestors: readonly ResolvedAncestorStep[];
  readonly physicalDepth: number;
  readonly parentPhysicalDepth: number;
  readonly parentAncestor?: ResolvedModuleAddress;
  readonly ruleSet: ModuleRuleSet;
};

export type ResolvedActorReference = ResolvedModuleAddress & {
  readonly who: 'author' | 'recipient';
  readonly rawOf: string;
  readonly physicalDepth: number;
};

export type ResolvedModuleAction = {
  readonly rule: ModuleActionRule;
  readonly resolvedRole?: ResolvedRoleReference;
  readonly resolvedActor?: ResolvedActorReference;
};

export type ResolvedModuleNode = ResolvedAncestorStep & {
  readonly kind: 'record' | 'ref';
  /** The local declaration; for a reference, `ruleSet` instead identifies its concrete target. */
  readonly declaredRuleSet: ModuleRuleSet;
  /** Physical ancestors in root-to-parent order, excluding this record. References add no record. */
  readonly physicalAncestors: readonly ResolvedAncestorStep[];
  readonly physicalDepth: number;
  readonly parentPhysicalDepth: number;
  readonly expectedParent?: ResolvedModuleAddress;
  readonly rolesByRawRef: ReadonlyMap<string, ResolvedRoleReference>;
  /** Only actions declared on this node, never actions inherited from a referenced parent. */
  readonly actions: readonly ResolvedModuleAction[];
};

export interface ResolvedModuleGraph {
  readonly rootModuleUri: string;
  readonly definitionsByUri: ReadonlyMap<string, ModuleDefinition>;
  readonly nodesByDeclaredPath: ReadonlyMap<string, ResolvedModuleNode>;
  /** Resolves in the root module's lexical namespace. */
  resolveInvokedRole(moduleRole: string): ResolvedRoleReference;
}

type MutableResolvedNode = Omit<ResolvedModuleNode, 'rolesByRawRef' | 'actions'> & {
  rolesByRawRef: Map<string, ResolvedRoleReference>;
  actions: ResolvedModuleAction[];
};

/**
 * Resolves a module's complete dependency closure without fetching or changing caller state.
 * Every definition is copied so later mutations of authoring input cannot alter this graph.
 */
export function resolveModuleGraph(
  definition: ModuleDefinition,
  getDefinition: ModuleDefinitionLookup,
  options: ResolveModuleGraphOptions = {},
): ResolvedModuleGraph {
  return new ModuleGraphResolver(getDefinition, options.requireKeyAgreement ?? true).resolve(definition);
}

class ModuleGraphResolver {
  private readonly _definitions = new Map<string, ModuleDefinition>();
  private readonly _nodes = new Map<string, MutableResolvedNode>();
  private readonly _loading = new Set<string>();
  private readonly _resolving = new Set<string>();
  private readonly _refTargets = new Map<string, Map<string, string>>();

  public constructor(
    private readonly _getDefinition: ModuleDefinitionLookup,
    private readonly _requireKeyAgreement: boolean,
  ) { }

  public resolve(definition: ModuleDefinition): ResolvedModuleGraph {
    this.loadDefinition(definition);
    for (const [moduleUri, loaded] of this._definitions) {
      this.resolveStructure(moduleUri, loaded.structure, '');
    }
    for (const node of this._nodes.values()) {
      this.resolveActions(node);
    }
    const nodesByDeclaredPath = new Map<string, ResolvedModuleNode>();
    for (const node of this._nodes.values()) {
      Object.freeze(node.actions);
      Object.freeze(node);
      if (node.declaringModuleUri === definition.module) {
        nodesByDeclaredPath.set(node.declaringModulePath, node);
      }
    }
    const rootModuleUri = definition.module;
    return Object.freeze({
      rootModuleUri,
      definitionsByUri   : this._definitions,
      nodesByDeclaredPath,
      resolveInvokedRole : (moduleRole: string): ResolvedRoleReference => this.resolveRole(rootModuleUri, moduleRole),
    });
  }

  private loadDefinition(input: ModuleDefinition): void {
    const moduleUri = input.module;
    if (this._loading.has(moduleUri)) {
      throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesCycle, `module dependency cycle at '${moduleUri}'.`);
    }
    if (this._definitions.has(moduleUri)) {
      return;
    }
    validateJsonSchema('ModuleDefinition', input);
    validateModuleUrlNormalized(moduleUri);
    const definition = structuredClone(input);
    this._loading.add(moduleUri);
    this._definitions.set(moduleUri, definition);
    const usedUris = new Set<string>();
    for (const alias of Object.keys(definition.uses ?? {}).sort()) {
      const targetUri = definition.uses![alias];
      validateModuleUrlNormalized(targetUri);
      if (usedUris.has(targetUri)) {
        throw new DwnError(DwnErrorCode.ModulesConfigureDuplicateUsesModule,
          `module '${moduleUri}' declares multiple aliases for '${targetUri}'.`);
      }
      usedUris.add(targetUri);
      if (this._loading.has(targetUri)) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesCycle,
          `module dependency '${moduleUri}' -> '${targetUri}' forms a cycle.`);
      }
      if (this._definitions.has(targetUri)) {
        continue;
      }
      const target = this._getDefinition(targetUri);
      if (target === undefined) {
        throw new DwnError(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled,
          `composed module '${targetUri}' (alias '${alias}') is not installed.`);
      }
      if (target.module !== targetUri) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl,
          `lookup for '${targetUri}' returned definition '${target.module}'.`);
      }
      this.loadDefinition(target);
    }
    this._loading.delete(moduleUri);
  }

  private resolveStructure(moduleUri: string, structure: ModuleRuleSet, parentPath: string): void {
    for (const name of Object.keys(structure).filter(key => !key.startsWith('$')).sort()) {
      const path = parentPath === '' ? name : `${parentPath}/${name}`;
      this.resolveNode(moduleUri, path);
      this.resolveStructure(moduleUri, structure[name] as ModuleRuleSet, path);
    }
  }

  private declaredRuleSet(moduleUri: string, path: string): ModuleRuleSet {
    let node = this._definitions.get(moduleUri)!.structure as ModuleRuleSet;
    for (const segment of path.split('/')) {
      if (segment === '' || segment.startsWith('$') || !Object.hasOwn(node, segment)) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidRefModulePath,
          `module '${moduleUri}' has no declared record path '${path}'.`);
      }
      node = node[segment] as ModuleRuleSet;
    }
    return node;
  }

  private resolveReference(moduleUri: string, reference: string): MutableResolvedNode {
    const colon = reference.indexOf(':');
    if (colon === -1) {
      return this.resolveNode(moduleUri, reference);
    }
    const alias = reference.slice(0, colon);
    const definition = this._definitions.get(moduleUri)!;
    if (definition.uses === undefined || !Object.hasOwn(definition.uses, alias)) {
      throw new DwnError(DwnErrorCode.ModulesConfigureInvalidRefAlias,
        `reference '${reference}' has no alias '${alias}' in module '${moduleUri}'.`);
    }
    return this.resolveNode(definition.uses[alias], reference.slice(colon + 1));
  }

  private resolveNode(moduleUri: string, path: string): MutableResolvedNode {
    const key = JSON.stringify([moduleUri, path]);
    const existing = this._nodes.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (this._resolving.has(key)) {
      throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesCycle,
        `cyclic reference at '${moduleUri}' path '${path}'.`);
    }
    this._resolving.add(key);
    const declaredRuleSet = this.declaredRuleSet(moduleUri, path);
    let node: MutableResolvedNode;
    if (declaredRuleSet.$ref !== undefined) {
      if (path.includes('/')) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidRefNotAtRoot,
          `reference at '${moduleUri}' path '${path}' is not at the structure root.`);
      }
      const target = this.resolveReference(moduleUri, declaredRuleSet.$ref);
      if (target.ruleSet.$squash === true || target.physicalAncestors.some(step => step.ruleSet.$squash === true)) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidRefTargetSquash,
          `reference '${declaredRuleSet.$ref}' at '${moduleUri}' path '${path}' has squashable physical ancestry.`);
      }
      const targets = this._refTargets.get(moduleUri) ?? new Map<string, string>();
      const targetKey = JSON.stringify([target.owningModuleUri, target.owningModulePath]);
      const previousPath = targets.get(targetKey);
      if (previousPath !== undefined) {
        throw new DwnError(DwnErrorCode.ModulesConfigureDuplicateRefTarget,
          `references '${previousPath}' and '${path}' in '${moduleUri}' resolve to the same target '${targetKey}'.`);
      }
      targets.set(targetKey, path);
      this._refTargets.set(moduleUri, targets);
      node = {
        ...target,
        declaringModuleUri  : moduleUri,
        declaringModulePath : path,
        kind                : 'ref',
        declaredRuleSet,
        rolesByRawRef       : new Map(),
        actions             : [],
      };
    } else {
      const typeName = path.split('/').at(-1)!;
      const definition = this._definitions.get(moduleUri)!;
      if (!Object.hasOwn(definition.types, typeName)) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidRuleSetRecordType,
          `record path '${path}' in '${moduleUri}' has no local type '${typeName}'.`);
      }
      const separator = path.lastIndexOf('/');
      const parent = separator === -1 ? undefined : this.resolveNode(moduleUri, path.slice(0, separator));
      const physicalAncestors = parent === undefined ? [] : [...parent.physicalAncestors, this.ancestorStep(parent)];
      node = {
        declaringModuleUri  : moduleUri,
        declaringModulePath : path,
        kind                : 'record',
        owningModuleUri     : moduleUri,
        owningModulePath    : path,
        typeName,
        recordType          : definition.types[typeName],
        ruleSet             : declaredRuleSet,
        declaredRuleSet,
        physicalAncestors   : Object.freeze(physicalAncestors),
        physicalDepth       : physicalAncestors.length + 1,
        parentPhysicalDepth : physicalAncestors.length,
        expectedParent      : parent === undefined ? undefined : this.address(parent),
        rolesByRawRef       : new Map(),
        actions             : [],
      };
    }
    if (node.physicalDepth > DwnConstant.maxRecordNestingDepth) {
      throw new DwnError(DwnErrorCode.ModulesConfigureMaxDepthExceeded,
        `resolved record '${moduleUri}' path '${path}' exceeds ${DwnConstant.maxRecordNestingDepth} physical levels.`);
    }
    this._nodes.set(key, node);
    this._resolving.delete(key);
    return node;
  }

  private address(node: ResolvedModuleAddress): ResolvedModuleAddress {
    return Object.freeze({ owningModuleUri: node.owningModuleUri, owningModulePath: node.owningModulePath });
  }

  private ancestorStep(node: ResolvedModuleNode): ResolvedAncestorStep {
    return Object.freeze({
      declaringModuleUri  : node.declaringModuleUri,
      declaringModulePath : node.declaringModulePath,
      owningModuleUri     : node.owningModuleUri,
      owningModulePath    : node.owningModulePath,
      typeName            : node.typeName,
      recordType          : node.recordType,
      ruleSet             : node.ruleSet,
    });
  }

  private resolveRole(moduleUri: string, rawRole: string): ResolvedRoleReference {
    const target = this.resolveReference(moduleUri, rawRole);
    if (target.ruleSet.$role !== true) {
      throw new DwnError(DwnErrorCode.ModulesConfigureRoleDoesNotExistAtGivenPath,
        `reference '${rawRole}' in '${moduleUri}' does not resolve to a role record.`);
    }
    return Object.freeze({
      ...this.address(target),
      rawRole,
      physicalAncestors   : target.physicalAncestors,
      physicalDepth       : target.physicalDepth,
      parentPhysicalDepth : target.parentPhysicalDepth,
      parentAncestor      : target.expectedParent,
      ruleSet             : target.ruleSet,
    });
  }

  private isSelfOrAncestor(node: ResolvedModuleNode, address: ResolvedModuleAddress): boolean {
    return [node, ...node.physicalAncestors].some(step =>
      step.owningModuleUri === address.owningModuleUri && step.owningModulePath === address.owningModulePath
    );
  }

  private resolveActions(node: MutableResolvedNode): void {
    const roles = new Set<string>();
    const actors = new Set<string>();
    for (const rule of node.declaredRuleSet.$actions ?? []) {
      if (rule.role !== undefined) {
        const role = this.resolveRole(node.declaringModuleUri, rule.role);
        if (role.parentAncestor !== undefined && !this.isSelfOrAncestor(node, role.parentAncestor)) {
          throw new DwnError(DwnErrorCode.ModulesConfigureInvalidRoleAncestor,
            `role '${rule.role}' cannot obtain its parent context from '${node.declaringModulePath}' in '${node.declaringModuleUri}'.`);
        }
        const roleKey = JSON.stringify([role.owningModuleUri, role.owningModulePath]);
        if (roles.has(roleKey)) {
          throw new DwnError(DwnErrorCode.ModulesConfigureDuplicateRoleInRuleSet,
            `duplicate canonical role '${rule.role}' at '${node.declaringModulePath}'.`);
        }
        roles.add(roleKey);
        if (this._requireKeyAgreement && node.kind === 'record' && node.recordType.encryptionRequired === true &&
            rule.can.includes('read') && role.ruleSet.$keyAgreement === undefined) {
          throw new DwnError(DwnErrorCode.ModulesConfigureInvalidEncryptedRoleMissingKeyAgreement,
            `encrypted path '${node.declaringModulePath}' references role '${rule.role}' without $keyAgreement.`);
        }
        node.rolesByRawRef.set(rule.role, role);
        node.actions.push(Object.freeze({ rule, resolvedRole: role }));
      } else {
        let resolvedActor: ResolvedActorReference | undefined;
        if (rule.of !== undefined) {
          const target = this.resolveReference(node.declaringModuleUri, rule.of);
          if (!this.isSelfOrAncestor(node, target)) {
            throw new DwnError(DwnErrorCode.ModulesConfigureInvalidActionOfNotAnAncestor,
              `actor target '${rule.of}' is not an ancestor of '${node.declaringModulePath}' in '${node.declaringModuleUri}'.`);
          }
          resolvedActor = Object.freeze({
            ...this.address(target),
            who           : rule.who as 'author' | 'recipient',
            rawOf         : rule.of,
            physicalDepth : target.physicalDepth,
          });
        }
        const actorKey = JSON.stringify([rule.who, resolvedActor?.owningModuleUri, resolvedActor?.owningModulePath]);
        if (actors.has(actorKey)) {
          throw new DwnError(DwnErrorCode.ModulesConfigureDuplicateActorInRuleSet,
            `duplicate canonical actor '${rule.who}' at '${node.declaringModulePath}'.`);
        }
        actors.add(actorKey);
        node.actions.push(Object.freeze({ rule, resolvedActor }));
      }
    }
  }
}
