import type { CrossModuleRef } from '../utils/modules.js';
import type { DataEncodedRecordsWriteMessage } from '../types/records-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type {
  ModuleActionRule, ModuleDefinition, ModuleRuleSet, ModulesConfigureDescriptor,
  ModulesConfigureMessage, ModuleTypes, ModuleUses
} from '../types/modules-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { DwnConstant } from '../core/dwn-constant.js';
import { FilterUtility } from '../utils/filter.js';
import { getRoleAudienceContextId } from '../core/module-role-records.js';
import { Message } from '../core/message.js';
import { ModulesGrantAuthorization } from '../core/modules-grant-authorization.js';
import { PermissionGrant } from '../modules/permission-grant.js';
import { Time } from '../utils/time.js';
import { validateJsonSchema } from '../schema-validator.js';
import { validateModuleTagSchemaDefinition } from '../utils/module-tags.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, isCrossModuleRef, parseCrossModuleRef } from '../utils/modules.js';
import { ModuleAction, ModuleActor } from '../types/modules-types.js';
import { normalizeModuleUrl, normalizeSchemaUrl, validateModuleUrlNormalized, validateSchemaUrlNormalized } from '../utils/url.js';

export type ModulesConfigureOptions = {
  messageTimestamp?: string;
  definition: ModuleDefinition;
  signer: MessageSigner;
  /**
   * The delegated grant invoked to sign on behalf of the logical author, which is the grantor of the delegated grant.
   */
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  permissionGrantId?: string;
};

type RuleSetValidationInput = {
  ruleSet: ModuleRuleSet;
  modulePath: string;
  recordTypeNames: string[];
  rolePaths: string[];
  uses?: ModuleUses;
  types: ModuleTypes;
  rootStructure: ModuleDefinition['structure'];
};

export class ModulesConfigure extends AbstractMessage<ModulesConfigureMessage> {
  private static readonly maxRecordNestingDepth = DwnConstant.maxRecordNestingDepth;

  public static async parse(message: ModulesConfigureMessage): Promise<ModulesConfigure> {
    ModulesConfigure.validateReservedEncryptionControlPath(message.descriptor?.definition);
    Message.validateJsonSchema(message);
    ModulesConfigure.validateModuleDefinition(message.descriptor.definition);
    await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);
    Time.validateTimestamp(message.descriptor.messageTimestamp);

    return new ModulesConfigure(message);
  }

  public static async create(options: ModulesConfigureOptions): Promise<ModulesConfigure> {
    const permissionGrantInvocation = Message.normalizePermissionGrantInvocation({
      permissionGrantId: options.permissionGrantId,
    });

    const descriptor: ModulesConfigureDescriptor = {
      interface        : DwnInterfaceName.Modules,
      method           : DwnMethodName.Configure,
      messageTimestamp : options.messageTimestamp ?? Time.getCurrentTimestamp(),
      definition       : ModulesConfigure.normalizeDefinition(options.definition),
      ...permissionGrantInvocation,
    };

    ModulesConfigure.validateReservedEncryptionControlPath(descriptor.definition);

    const authorization = await Message.createAuthorization({
      descriptor,
      signer         : options.signer,
      delegatedGrant : options.delegatedGrant,
      ...permissionGrantInvocation
    });
    const message = { descriptor, authorization };

    Message.validateJsonSchema(message);
    ModulesConfigure.validateModuleDefinition(message.descriptor.definition);

    const modulesConfigure = new ModulesConfigure(message);
    return modulesConfigure;
  }

  /**
   * Authorizes the author-delegate who signed this message.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public async authorizeAuthorDelegate(validationStateReader: ValidationStateReader): Promise<void> {
    const delegatedGrant = PermissionGrant.parse(this.message.authorization.authorDelegatedGrant!);
    await ModulesGrantAuthorization.authorizeConfigure({
      modulesConfigureMessage : this.message,
      expectedGrantor         : this.author!,
      expectedGrantee         : this.signer!,
      permissionGrant         : delegatedGrant,
      validationStateReader
    });
  }

  /**
   * Performs validation on the given module definition that are not easy to do using a JSON schema.
   */
  public static validateModuleDefinition(
    definition: ModuleDefinition,
    options: { requireKeyAgreement?: boolean } = {},
  ): void {
    validateJsonSchema('ModuleDefinition', definition);
    ModulesConfigure.validateReservedEncryptionControlPath(definition);
    const { module, types, uses } = definition;

    // validate module url
    validateModuleUrlNormalized(module);

    // validate schema url normalized
    for (const typeName in types) {
      const schema = types[typeName].schema;
      if (schema !== undefined) {
        validateSchemaUrlNormalized(schema);
      }
    }

    // validate `uses` — alias names must be simple identifiers, values must be normalized URLs, and no self-references
    if (uses !== undefined) {
      ModulesConfigure.validateUses(uses, module);
    }

    // validate `structure`
    ModulesConfigure.validateStructure(definition, options.requireKeyAgreement !== false);
  }

  /**
   * Validates the reserved encryption-control namespace before JSON Schema validation.
   */
  private static validateReservedEncryptionControlPath(definition: unknown): void {
    if (!ModulesConfigure.isRecord(definition)) {
      return;
    }

    if (ModulesConfigure.isRecord(definition.types) && Object.hasOwn(definition.types, '$encryption')) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureReservedEncryptionControlPath,
        `module type '$encryption' is reserved for DWN encryption control records.`
      );
    }

    ModulesConfigure.validateReservedEncryptionControlStructure(definition.structure, '', 0);
  }

  private static validateReservedEncryptionControlStructure(ruleSet: unknown, modulePath: string, depth: number): void {
    if (!ModulesConfigure.isRecord(ruleSet)) {
      return;
    }

    for (const recordType in ruleSet) {
      const childDepth = depth + 1;
      const childPath = modulePath === '' ? recordType : `${modulePath}/${recordType}`;

      if (recordType === '$encryption') {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureReservedEncryptionControlPath,
          `module structure path '${childPath}' is reserved for DWN encryption control records.`
        );
      }

      if (recordType.startsWith('$')) {
        continue;
      }

      if (childDepth > ModulesConfigure.maxRecordNestingDepth) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureRecordNestingDepthExceeded,
          `record nesting depth exceeded ${ModulesConfigure.maxRecordNestingDepth} levels.`
        );
      }

      ModulesConfigure.validateReservedEncryptionControlStructure(ruleSet[recordType], childPath, childDepth);
    }
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Validates the `uses` map: alias names must match `^[a-zA-Z][a-zA-Z0-9_-]*$`,
   * values must be normalized module URLs, and no alias may reference the module itself.
   */
  private static validateUses(uses: ModuleUses, ownModuleUri: string): void {
    const aliasPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
    const targetUris = new Set<string>();

    for (const alias in uses) {
      if (!aliasPattern.test(alias)) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidUsesAlias,
          `invalid 'uses' alias '${alias}': must match pattern ${aliasPattern.toString()}.`
        );
      }

      try {
        validateModuleUrlNormalized(uses[alias]);
      } catch {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl,
          `invalid 'uses' module URL for alias '${alias}': '${uses[alias]}' is not a valid normalized module URL.`
        );
      }

      // reject self-references: a module cannot compose itself
      if (uses[alias] === ownModuleUri) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidUsesSelfReference,
          `'uses' alias '${alias}' references the module's own URI '${ownModuleUri}'. ` +
          `a module cannot compose itself.`
        );
      }
      if (targetUris.has(uses[alias])) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureDuplicateUsesModule,
          `multiple aliases reference module '${uses[alias]}'; use one alias per module URI`
        );
      }
      targetUris.add(uses[alias]);
    }
  }

  private static validateStructure(definition: ModuleDefinition, requireKeyAgreement: boolean): void {
    const { uses } = definition;

    // gather all declared record types
    const recordTypeNames = Object.keys(definition.types);

    const hasEncryptedTypes = Object.values(definition.types).some((type): boolean => type.encryptionRequired === true);
    if (requireKeyAgreement && hasEncryptedTypes && definition.$keyAgreement === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureMissingTopLevelKeyAgreement,
        `Module '${definition.module}' declares encrypted types but has no top-level $keyAgreement.`
      );
    }

    // gather all roles (local roles only — cross-module roles are validated by alias existence)
    const rolePaths = ModulesConfigure.collectRolePaths('', definition.structure as ModuleRuleSet, []);

    const localTypeNames = new Set<string>();
    const collectLocalTypes = (structure: ModuleRuleSet): void => {
      for (const [name, value] of Object.entries(structure)) {
        if (name.startsWith('$')) {
          continue;
        }
        const node = value as ModuleRuleSet;
        if (node.$ref === undefined) {
          localTypeNames.add(name);
        }
        collectLocalTypes(node);
      }
    };
    collectLocalTypes(definition.structure);
    for (const [name, node] of Object.entries(definition.structure)) {
      if (node.$ref !== undefined && Object.hasOwn(definition.types, name) && !localTypeNames.has(name)) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRefTypeCollision,
          `attachment '${name}' cannot declare a local type unless a local record node also uses that type`
        );
      }
    }

    // validate the entire rule set structure recursively
    ModulesConfigure.validateRuleSetRecursively({
      ruleSet       : definition.structure as ModuleRuleSet,
      modulePath    : '',
      recordTypeNames,
      rolePaths,
      uses,
      types             : definition.types,
      rootStructure     : definition.structure,
      requireKeyAgreement,
    });
  }

  /**
   * Parses the given rule set hierarchy to get all the role module paths.
   */
  private static collectRolePaths(modulePath: string, ruleSet: ModuleRuleSet, rolePaths: string[]): string[] {
    for (const recordType in ruleSet) {
      // ignore non-nested-record properties
      if (recordType.startsWith('$')) {
        continue;
      }

      const childRuleSet = ruleSet[recordType] as ModuleRuleSet;

      let childModulePath;
      if (modulePath === '') {
        childModulePath = recordType;
      } else {
        childModulePath = `${modulePath}/${recordType}`;
      }

      // if this is a role record, add it to the list, else continue to traverse
      if (childRuleSet.$role) {
        rolePaths.push(childModulePath);
      } else {
        ModulesConfigure.collectRolePaths(childModulePath, childRuleSet, rolePaths);
      }
    }

    return rolePaths;
  }

  /**
   * Validates the given rule set structure then recursively validates its nested child rule sets.
   */
  private static validateRuleSetRecursively(
    input: {
      ruleSet: ModuleRuleSet, ruleSetModulePath: string, recordTypes: string[],
      roles: string[], uses?: ModuleUses, types: ModuleTypes, rootStructure: { [key: string]: ModuleRuleSet },
      requireKeyAgreement: boolean
    }
  ): void {
    const { ruleSet, ruleSetModulePath, recordTypes, roles, uses, types, rootStructure, requireKeyAgreement } = input;
    const crossesAttachment = (path: string): boolean => rootStructure[path.split('/')[0]]?.$ref !== undefined;

    // Validate $ref constraints: $ref is only supported at root level (no `/` in module path),
    // and a $ref node is an attachment point with no record-policy overrides.
    if (ruleSet.$ref !== undefined) {
      ModulesConfigure.validateRefNode(ruleSet, modulePath, input.uses);
    }
    ModulesConfigure.validateSizeConstraint(ruleSet, modulePath);
    ModulesConfigure.validateRecordLimitConstraint(ruleSet, modulePath);
    ModulesConfigure.validateTagSchemas(ruleSet, modulePath);
    ModulesConfigure.validateActionRules(input);
    ModulesConfigure.validateEncryptedRecordRules(input);
    ModulesConfigure.warnConflictingDirectives(ruleSet, modulePath);

    for (const recordType in ruleSet) {
      if (recordType.startsWith('$')) {
        continue;
      }
      const childRuleSet = ruleSet[recordType] as ModuleRuleSet;
      // Reference names need not appear in the local types map.
      if (childRuleSet.$ref === undefined && !recordTypeNames.includes(recordType)) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRuleSetRecordType,
          `Rule set ${recordType} is not declared as an allowed type in the module definition.`
        );
      }
      const childPath = modulePath === '' ? recordType : `${modulePath}/${recordType}`;
      ModulesConfigure.validateRuleSetRecursively({ ...input, ruleSet: childRuleSet, modulePath: childPath });
    }
  }

  private static validateSizeConstraint(ruleSet: ModuleRuleSet, modulePath: string): void {
    if (ruleSet.$size !== undefined) {
      const { min = 0, max } = ruleSet.$size;

      if (max !== undefined && max < min) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidSize,
          `Invalid size range found: max limit ${max} less than min limit ${min} at module path '${modulePath}'`
        );
      }
    }
  }

  private static validateRecordLimitConstraint(ruleSet: ModuleRuleSet, modulePath: string): void {
    if (ruleSet.$recordLimit !== undefined) {
      const { max } = ruleSet.$recordLimit;

      if (!Number.isInteger(max) || max < 1) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRecordLimit,
          `Invalid $recordLimit.max value ${max} at module path '${modulePath}': must be an integer >= 1.`
        );
      }

      if (max > DwnConstant.maxRecordLimit) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRecordLimit,
          `Invalid $recordLimit.max value ${max} at module path '${modulePath}': must be <= ${DwnConstant.maxRecordLimit}.`
        );
      }

      if (ruleSet.$role === true) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRoleRecordLimit,
          `'$recordLimit' cannot be used on role path '${modulePath}'; ` +
          `hidden role assignments would remain authorization capabilities.`
        );
      }
    }
  }

  private static validateTagSchemas(ruleSet: ModuleRuleSet, modulePath: string): void {
    if (ruleSet.$tags !== undefined) {
      const { $allowUndefinedTags, $requiredTags, ...tagProperties } = ruleSet.$tags;

      // validate each tag's schema against the DWN-supported tag schema subset
      for (const tag in tagProperties) {
        const tagSchemaDefinition = tagProperties[tag];
        const schemaError = validateModuleTagSchemaDefinition(
          tagSchemaDefinition,
          `${modulePath}/$tags/${tag}`,
        );

        if (schemaError !== undefined) {
          throw new DwnError(DwnErrorCode.ModulesConfigureInvalidTagSchema, `tags schema validation error: ${schemaError}`);
        }
      }
    }
  }

  private static validateActionRules(input: RuleSetValidationInput): void {
    const { ruleSet, modulePath, rolePaths, uses } = input;
    const actionRules = ruleSet.$actions ?? [];
    ModulesConfigure.validateRoleRecordIssuance(ruleSet, modulePath);
    for (let index = 0; index < actionRules.length; index++) {
      const actionRule = actionRules[index];
      ModulesConfigure.validateActionRole(actionRule, modulePath, rolePaths, uses);
      ModulesConfigure.validateActionActor(actionRule, modulePath);
      ModulesConfigure.validateActionAncestor(actionRule, modulePath, uses);
      ModulesConfigure.validateAuthorActionPrerequisites(actionRule);
      ModulesConfigure.validateActionRuleUniqueness(actionRules, index);
    }
  }

    for (let i = 0; i < actionRules.length; i++) {
      const actionRule = actionRules[i];

      // Validate the `role` property of an `action` if exists.
      if (actionRule.role !== undefined) {
        if (isCrossModuleRef(actionRule.role)) {
          // Cross-module role reference: validate alias exists in `uses`
          ModulesConfigure.validateCrossModuleAlias(actionRule.role, uses, ruleSetModulePath, 'role');
        } else if (!crossesAttachment(ruleSetModulePath) && !crossesAttachment(actionRule.role)) {
          // Local role: make sure the role contains a valid module path to a role record
          if (!roles.includes(actionRule.role)) {
            throw new DwnError(
              DwnErrorCode.ModulesConfigureRoleDoesNotExistAtGivenPath,
              `Role in action ${JSON.stringify(actionRule)} for rule set ${ruleSetModulePath} does not exist.`
            );
          }

          ModulesConfigure.validateRoleParentContextDepth(actionRule.role, ruleSetModulePath, actionRule);
        }

        ModulesConfigure.validateRoleParentContextDepth(actionRule.role, modulePath, actionRule);
      }
    }
  }

  private static validateActionActor(actionRule: ModuleActionRule, modulePath: string): void {
    // Validate that if `who` is set to `anyone` then `of` is not set
    if (actionRule.who === 'anyone' && actionRule.of) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidActionOfNotAllowed,
        `'of' is not allowed at rule set module path (${modulePath})`
      );
    }

    // Without `of`, the actor is this record's recipient. Only co-update,
    // co-delete, and co-prune may act on a recipient already assigned to the record.
    if (actionRule.who === ModuleActor.Recipient && actionRule.of === undefined) {

      // throw if `can` contains a value that is not `co-update`, `co-delete`, or `co-prune`
      const hasDisallowedAction = actionRule.can.some(
        action => ![ModuleAction.CoUpdate, ModuleAction.CoDelete, ModuleAction.CoPrune].includes(action as ModuleAction)
      );
      if (hasDisallowedAction) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRecipientOfAction,
          'Rules for `recipient` without `of` property must have `can` containing only `co-update`, `co-delete`, and `co-prune`.'
        );
      }
    }

    // Validate that if `who` is set to `author` then `of` is set
    if (actionRule.who === ModuleActor.Author && !actionRule.of) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidActionMissingOf,
        `'of' is required when 'author' is specified as 'who'`
      );
    }
  }

  private static validateActionAncestor(actionRule: ModuleActionRule, modulePath: string, uses?: ModuleUses): void {
    // Validate that `of` points to the current module path or an ancestor of it.
    // At runtime, `checkActor()` searches the record chain for a matching `modulePath` equal to `actionRule.of`.
    // If `of` is not the current path or one of its ancestors, the action rule would silently never authorize anyone.
    if (actionRule.of !== undefined && modulePath !== '') {
      if (isCrossModuleRef(actionRule.of)) {
        // Cross-module `of` reference: validate alias exists in `uses`
        ModulesConfigure.validateCrossModuleAlias(actionRule.of, uses, modulePath, 'of');
      } else {
        // Local `of`: must be self or ancestor
        const isSelfOrAncestor = FilterUtility.matchesSubtree(actionRule.of, modulePath);
        if (!isSelfOrAncestor) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureInvalidRecipientOfAction,
            'Rules for `recipient` without `of` property must have `can` containing only `co-update`, `co-delete`, and `co-prune`.'
          );
        }
      }

      // Validate that if `who` is set to `author` then `of` is set
      if (actionRule.who === ModuleActor.Author && !actionRule.of) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidActionMissingOf,
          `'of' is required when 'author' is specified as 'who'`
        );
      }

      // Validate that `of` points to the current module path or an ancestor of it.
      // At runtime, `checkActor()` searches the record chain for a matching `modulePath` equal to `actionRule.of`.
      // If `of` is not the current path or one of its ancestors, the action rule would silently never authorize anyone.
      if (actionRule.of !== undefined && ruleSetModulePath !== '') {
        if (isCrossModuleRef(actionRule.of)) {
          // Cross-module `of` reference: validate alias exists in `uses`
          ModulesConfigure.validateCrossModuleAlias(actionRule.of, uses, ruleSetModulePath, 'of');
        } else if (!crossesAttachment(ruleSetModulePath) && !crossesAttachment(actionRule.of)) {
          // Local `of`: must be self or ancestor
          const isSelfOrAncestor = FilterUtility.matchesSubtree(actionRule.of, ruleSetModulePath);
          if (!isSelfOrAncestor) {
            throw new DwnError(
              DwnErrorCode.ModulesConfigureInvalidActionOfNotAnAncestor,
              `'of' value '${actionRule.of}' is not an ancestor of module path '${ruleSetModulePath}' ` +
              `in action rule ${JSON.stringify(actionRule)}.`
            );
          }
        }
      }

      // validate that if `can` contains `update`, `delete`, or `prune`, it must also contain `create`
      // because these are author-only actions, and you can only be the author if you can create
      if (actionRule.can !== undefined) {
        if (actionRule.can.includes(ModuleAction.Update) && !actionRule.can.includes(ModuleAction.Create)) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureInvalidActionUpdateWithoutCreate,
            `Action rule ${JSON.stringify(actionRule)} contains 'update' action but missing the required 'create' action.`
          );
        }

        if (actionRule.can.includes(ModuleAction.Delete) && !actionRule.can.includes(ModuleAction.Create)) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureInvalidActionDeleteWithoutCreate,
            `Action rule ${JSON.stringify(actionRule)} contains 'delete' action but missing the required 'create' action.`
          );
        }

        if (actionRule.can.includes(ModuleAction.Prune) && !actionRule.can.includes(ModuleAction.Create)) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureInvalidActionPruneWithoutCreate,
            `Action rule ${JSON.stringify(actionRule)} contains 'prune' action but missing the required 'create' action.`
          );
        }
      }

      // Validate that there are no duplicate actors or roles in the remaining action rules:
      // ie. no two action rules can have the same combination of `who` + `of` or `role`.
      // NOTE: we only need to check the remaining action rules that have yet to go through action rule validation loop, as a perf shortcut.
      for (let j = i + 1; j < actionRules.length; j++) {
        const otherActionRule = actionRules[j];

        if (actionRule.who === undefined) {
          // implicitly a role-based action rule

          if (actionRule.role === otherActionRule.role) {
            throw new DwnError(
              DwnErrorCode.ModulesConfigureDuplicateRoleInRuleSet,
              `More than one action rule per role ${actionRule.role} not allowed within a rule set: ${JSON.stringify(actionRule)}`
            );
          }
        } else if (actionRule.who === otherActionRule.who && actionRule.of === otherActionRule.of) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureDuplicateActorInRuleSet,
            `More than one action rule per actor ${actionRule.who} of ${actionRule.of} ` +
            `not allowed within a rule set: ${JSON.stringify(actionRule)}`
          );
        }
      }
    }
  }

    if (ruleSetModulePath !== '' && ruleSet.$ref === undefined) {
      const typeName = ruleSetModulePath.split('/').pop()!;
      const moduleType = types[typeName];
      if (moduleType?.encryptionRequired === true) {
        if (requireKeyAgreement && ruleSet.$keyAgreement === undefined) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureMissingEncryptedPathKeyAgreement,
            `Encrypted module path '${ruleSetModulePath}' has no $keyAgreement.`
          );
        }

        const anyoneCanRead = actionRules.some(
          (rule: ModuleActionRule): boolean => rule.who === ModuleActor.Anyone && rule.can.includes(ModuleAction.Read)
        );
      }

      if (actionRule.can.includes(ModuleAction.Delete) && !actionRule.can.includes(ModuleAction.Create)) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidActionDeleteWithoutCreate,
          `Action rule ${JSON.stringify(actionRule)} contains 'delete' action but missing the required 'create' action.`
        );
      }

          if (!requireKeyAgreement || isCrossModuleRef(actionRule.role) ||
              crossesAttachment(ruleSetModulePath) || crossesAttachment(actionRule.role)) {
            continue;
          }

          const roleRuleSet = getRuleSetAtPath(actionRule.role, rootStructure);
          if (roleRuleSet?.$keyAgreement === undefined) {
            throw new DwnError(
              DwnErrorCode.ModulesConfigureInvalidEncryptedRoleMissingKeyAgreement,
              `Encrypted module path '${ruleSetModulePath}' references role '${actionRule.role}' with no $keyAgreement.`
            );
          }
        }
      }
    }
  }

  private static validateActionRuleUniqueness(actionRules: ModuleActionRule[], index: number): void {
    const actionRule = actionRules[index];
    // Validate that there are no duplicate actors or roles in the remaining action rules:
    // ie. no two action rules can have the same combination of `who` + `of` or `role`.
    // NOTE: we only need to check the remaining action rules that have yet to go through action rule validation loop, as a perf shortcut.
    for (let j = index + 1; j < actionRules.length; j++) {
      const otherActionRule = actionRules[j];

      if (actionRule.who === undefined) {
        // implicitly a role-based action rule

        if (actionRule.role === otherActionRule.role) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureDuplicateRoleInRuleSet,
            `More than one action rule per role ${actionRule.role} not allowed within a rule set: ${JSON.stringify(actionRule)}`
          );
        }
      } else if (actionRule.who === otherActionRule.who && actionRule.of === otherActionRule.of) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureDuplicateActorInRuleSet,
          `More than one action rule per actor ${actionRule.who} of ${actionRule.of} ` +
          `not allowed within a rule set: ${JSON.stringify(actionRule)}`
        );
      }
    }
  }

  private static validateEncryptedRecordRules(input: RuleSetValidationInput): void {
    const { ruleSet, modulePath, types, rootStructure } = input;
    if (modulePath === '') {
      return;
    }
    const typeName = modulePath.split('/').pop()!;
    if (types[typeName]?.encryptionRequired !== true) {
      return;
    }
    if (ruleSet.$keyAgreement === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureMissingEncryptedPathKeyAgreement,
        `Encrypted module path '${modulePath}' has no $keyAgreement.`
      );
    }
    const actionRules = ruleSet.$actions ?? [];
    const anyoneCanRead = actionRules.some(
      (rule: ModuleActionRule): boolean => rule.who === ModuleActor.Anyone && rule.can.includes(ModuleAction.Read)
    );
    if (anyoneCanRead) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidEncryptedAnyoneRead,
        `Encrypted module path '${modulePath}' allows { who: 'anyone', can: ['read'] }.`
      );
    }
    ModulesConfigure.validateEncryptedReadRoles(actionRules, modulePath, rootStructure);
  }

  private static validateEncryptedReadRoles(
    actionRules: ModuleActionRule[], modulePath: string, rootStructure: ModuleDefinition['structure'],
  ): void {
    for (const actionRule of actionRules) {
      if (actionRule.role === undefined || !actionRule.can.includes(ModuleAction.Read)) {
        continue;
      }

      if (isCrossModuleRef(actionRule.role)) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidEncryptedCrossModuleRole,
          `Encrypted module path '${modulePath}' references cross-module read role '${actionRule.role}'.`
        );
      }

      const roleRuleSet = getRuleSetAtPath(actionRule.role, rootStructure);
      if (roleRuleSet?.$keyAgreement === undefined) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidEncryptedRoleMissingKeyAgreement,
          `Encrypted module path '${modulePath}' references role '${actionRule.role}' with no $keyAgreement.`
        );
      }
    }
  }

  private static warnConflictingDirectives(ruleSet: ModuleRuleSet, modulePath: string): void {
    const actionRules = ruleSet.$actions ?? [];
    // Warn when `$delivery` is set without `$actions`.
    // Delivery targets are determined from `$actions` role records and actor rules.
    // Without `$actions`, the server cannot determine who to deliver records to.
    if (ruleSet.$delivery !== undefined && (ruleSet.$actions === undefined || ruleSet.$actions.length === 0)) {
      console.warn(
        `ModulesConfigure: module path '${modulePath}' has $delivery: '${ruleSet.$delivery}' ` +
        `but no $actions rules. The server uses $actions to determine delivery targets — ` +
        `without $actions, no participants can be resolved for delivery.`
      );
    }

    // Warn when `$immutable: true` is combined with `$actions` that include `update` or `co-update`.
    // The `$immutable` directive overrides any update permission — updates are always rejected.
    if (ruleSet.$immutable === true && actionRules.length > 0) {
      const hasUpdateAction = actionRules.some(
        (rule: ModuleActionRule): boolean =>
          rule.can.includes(ModuleAction.Update) || rule.can.includes(ModuleAction.CoUpdate)
      );
      if (hasUpdateAction) {
        console.warn(
          `ModulesConfigure: module path '${modulePath}' has $immutable: true ` +
          `but $actions include 'update' or 'co-update'. The $immutable directive takes ` +
          `precedence — updates will always be rejected regardless of action rules.`
        );
      }
    }

    // Validate nested rule sets
    for (const recordType in ruleSet) {
      if (recordType.startsWith('$')) {
        continue;
      }

      const childRuleSet = ruleSet[recordType] as ModuleRuleSet;

      // A structure key whose rule set has `$ref` does not need to be in the local `types` map —
      // the type comes from the referenced module. All other keys must be in `types`.
      if (childRuleSet.$ref === undefined && !recordTypes.includes(recordType)) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRuleSetRecordType,
          `Rule set ${recordType} is not declared as an allowed type in the module definition.`
        );
      }

      let childRuleSetModulePath;
      if (ruleSetModulePath === '') {
        childRuleSetModulePath = recordType; // case of initial definition structure
      } else {
        childRuleSetModulePath = `${ruleSetModulePath}/${recordType}`;
      }

      ModulesConfigure.validateRuleSetRecursively({
        ruleSet           : childRuleSet,
        ruleSetModulePath : childRuleSetModulePath,
        recordTypes,
        roles,
        uses,
        types,
        rootStructure,
        requireKeyAgreement,
      });
    }
  }

  /** Rejects role paths that let any unrestricted caller issue a role. */
  private static validateRoleRecordIssuance(ruleSet: ModuleRuleSet, modulePath: string): void {
    if (ruleSet.$role !== true) {
      return;
    }

    const anyoneCanIssueRole = ruleSet.$actions?.some(
      (actionRule: ModuleActionRule): boolean =>
        actionRule.who === ModuleActor.Anyone &&
        (actionRule.can.includes(ModuleAction.Create) || actionRule.can.includes(ModuleAction.Squash))
    ) ?? false;
    if (!anyoneCanIssueRole) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.ModulesConfigureInvalidRoleIssuance,
      `role assignments at module path '${modulePath}' require an authorized issuer; ` +
      `'anyone' cannot create or squash an initial role record.`
    );
  }

  /**
   * Validates that a `$ref` node is a pure attachment point: it must NOT have
   * record policy directives such as `$role`, `$size`, `$tags`, or `$keyAgreement`.
   * Explicit `$actions` are syntactically allowed but do not create a local record
   * or grant authority over the referenced module's record.
   * Also validates that the `$ref` alias exists in the `uses` map.
   */
  private static validateRefNode(ruleSet: ModuleRuleSet, modulePath: string, uses: ModuleUses | undefined): void {
    if (modulePath.includes('/')) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidRefNotAtRoot,
        `'$ref' at module path '${modulePath}' is not allowed: '$ref' nodes are only supported at the root level of the structure.`
      );
    }

    const ref = ruleSet.$ref!;
    const parsed = parseCrossModuleRef(ref);

    if (parsed === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidRefAlias,
        `'$ref' value '${ref}' at module path '${modulePath}' must be in 'alias:typePath' format.`
      );
    }

    // validate alias exists in `uses`
    if (uses?.[parsed.alias] === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidRefAlias,
        `'$ref' alias '${parsed.alias}' at module path '${modulePath}' does not exist in the 'uses' map.`
      );
    }

    // validate that `$ref` nodes do not have other directives
    const forbiddenDirectives = ['$role', '$size', '$tags', '$keyAgreement', '$encryption', '$recordLimit', '$immutable', '$delivery', '$squash'] as const;
    for (const directive of forbiddenDirectives) {
      if (ruleSet[directive] !== undefined) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRefNodeHasDirectives,
          `'$ref' node at module path '${modulePath}' must not have '${directive}'. ` +
          `$ref nodes are pure attachment points — directives belong on child rule sets.`
        );
      }
    }
    if (!Object.keys(ruleSet).some(name => !name.startsWith('$'))) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidRefWithoutChildren,
        `attachment '${ruleSetModulePath}' requires at least one local child record`
      );
    }
  }

  /**
   * Validates that a role rule only references a role whose parent context can be found
   * from records at the rule set's module path.
   */
  private static validateRoleParentContextDepth(rolePath: string, modulePath: string, actionRule: ModuleActionRule): void {
    const syntheticContextId = ModulesConfigure.getSyntheticContextIdForModulePath(modulePath);

    // This check is only called for entirely local paths; attached paths defer to graph resolution.
    const localRole = { parentPhysicalDepth: rolePath.split('/').length - 1 };
    if (getRoleAudienceContextId(localRole, syntheticContextId) === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureRoleParentContextDepthExceeded,
        `role '${rolePath}' in action ${JSON.stringify(actionRule)} at module path '${modulePath}' ` +
        `requires a context that records at the rule path cannot provide.`
      );
    }
  }

  private static getSyntheticContextIdForModulePath(modulePath: string): string | undefined {
    if (modulePath === '') {
      return undefined;
    }

    return modulePath
      .split('/')
      .map((_segment, index): string => `context-${index}`)
      .join('/');
  }

  /**
   * Validates that a cross-module reference (in `alias:path` format) has a valid alias
   * that exists in the `uses` map.
   * @param ref - The cross-module reference string (e.g., "threads:thread/participant")
   * @param uses - The module definition's `uses` map
   * @param modulePath - The current module path (for error messages)
   * @param fieldName - The field name ('role' or 'of') for error messages
   */
  private static validateCrossModuleAlias(
    ref: string, uses: ModuleUses | undefined, modulePath: string, fieldName: string
  ): CrossModuleRef {
    const parsed = parseCrossModuleRef(ref);

    if (parsed === undefined) {
      // should not happen if isCrossModuleRef() returned true, but guard defensively
      const errorCode = fieldName === 'role'
        ? DwnErrorCode.ModulesConfigureInvalidCrossModuleRole
        : DwnErrorCode.ModulesConfigureInvalidCrossModuleOf;

      throw new DwnError(
        errorCode,
        `cross-module '${fieldName}' reference '${ref}' at module path '${modulePath}' ` +
        `could not be parsed as a valid 'alias:path' format.`
      );
    }

    if (uses?.[parsed.alias] === undefined) {
      const errorCode = fieldName === 'role'
        ? DwnErrorCode.ModulesConfigureInvalidCrossModuleRole
        : DwnErrorCode.ModulesConfigureInvalidCrossModuleOf;

      throw new DwnError(
        errorCode,
        `cross-module '${fieldName}' alias '${parsed.alias}' in '${ref}' at module path '${modulePath}' ` +
        `does not exist in the 'uses' map.`
      );
    }

    return parsed;
  }

  private static normalizeDefinition(definition: ModuleDefinition): ModuleDefinition {
    // Deep clone types to avoid mutating the caller's nested objects
    const typesCopy: ModuleDefinition['types'] = {};
    for (const typeName in definition.types) {
      typesCopy[typeName] = { ...definition.types[typeName] };
    }

    // Normalize schema url
    for (const typeName in typesCopy) {
      const schema = typesCopy[typeName].schema;
      if (schema !== undefined) {
        typesCopy[typeName].schema = normalizeSchemaUrl(schema);
      }
    }

    // Normalize `uses` module URLs (skip invalid URLs — they will be caught by validateUses)
    let usesCopy: ModuleDefinition['uses'];
    if (definition.uses !== undefined) {
      usesCopy = {};
      for (const alias in definition.uses) {
        try {
          usesCopy[alias] = normalizeModuleUrl(definition.uses[alias]);
        } catch {
          usesCopy[alias] = definition.uses[alias];
        }
      }
    }

    return {
      ...definition,
      module : normalizeModuleUrl(definition.module),
      types  : typesCopy,
      ...(usesCopy !== undefined && { uses: usesCopy }),
    };
  }
}
