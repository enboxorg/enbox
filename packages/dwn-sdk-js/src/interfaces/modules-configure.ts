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
import { Message } from '../core/message.js';
import { ModulesGrantAuthorization } from '../core/modules-grant-authorization.js';
import { PermissionGrant } from '../modules/permission-grant.js';
import { Time } from '../utils/time.js';
import { validateModuleTagSchemaDefinition } from '../utils/module-tags.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRoleAudienceContextId, getRuleSetAtPath, isCrossModuleRef, parseCrossModuleRef } from '../utils/modules.js';
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

export class ModulesConfigure extends AbstractMessage<ModulesConfigureMessage> {
  private static readonly maxRecordNestingDepth = 10;

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
  private static validateModuleDefinition(definition: ModuleDefinition): void {
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
    ModulesConfigure.validateStructure(definition);
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
    }
  }

  private static validateStructure(definition: ModuleDefinition): void {
    const { uses } = definition;

    // gather all declared record types
    const recordTypes = Object.keys(definition.types);

    const hasEncryptedTypes = Object.values(definition.types).some((type): boolean => type.encryptionRequired === true);
    if (hasEncryptedTypes && definition.$keyAgreement === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureMissingTopLevelKeyAgreement,
        `Module '${definition.module}' declares encrypted types but has no top-level $keyAgreement.`
      );
    }

    // gather all roles (local roles only — cross-module roles are validated by alias existence)
    const roles = ModulesConfigure.fetchAllRolePathsRecursively('', definition.structure as ModuleRuleSet, []);

    // validate the entire rule set structure recursively
    ModulesConfigure.validateRuleSetRecursively({
      ruleSet           : definition.structure as ModuleRuleSet,
      ruleSetModulePath : '',
      recordTypes,
      roles,
      uses,
      types             : definition.types,
      rootStructure     : definition.structure,
    });
  }

  /**
   * Parses the given rule set hierarchy to get all the role module paths.
   */
  private static fetchAllRolePathsRecursively(ruleSetModulePath: string, ruleSet: ModuleRuleSet, roles: string[]): string[] {
    for (const recordType in ruleSet) {
      // ignore non-nested-record properties
      if (recordType.startsWith('$')) {
        continue;
      }

      const childRuleSet = ruleSet[recordType] as ModuleRuleSet;

      let childRuleSetModulePath;
      if (ruleSetModulePath === '') {
        childRuleSetModulePath = recordType;
      } else {
        childRuleSetModulePath = `${ruleSetModulePath}/${recordType}`;
      }

      // if this is a role record, add it to the list, else continue to traverse
      if (childRuleSet.$role) {
        roles.push(childRuleSetModulePath);
      } else {
        ModulesConfigure.fetchAllRolePathsRecursively(childRuleSetModulePath, childRuleSet, roles);
      }
    }

    return roles;
  }

  /**
   * Validates the given rule set structure then recursively validates its nested child rule sets.
   */
  private static validateRuleSetRecursively(
    input: {
      ruleSet: ModuleRuleSet, ruleSetModulePath: string, recordTypes: string[],
      roles: string[], uses?: ModuleUses, types: ModuleTypes, rootStructure: { [key: string]: ModuleRuleSet }
    }
  ): void {
    const { ruleSet, ruleSetModulePath, recordTypes, roles, uses, types, rootStructure } = input;

    // Validate $ref constraints: $ref is only supported at root level (no `/` in module path),
    // and a $ref node is a pure attachment point with no other directives.
    if (ruleSet.$ref !== undefined) {
      if (ruleSetModulePath.includes('/')) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRefNotAtRoot,
          `'$ref' at module path '${ruleSetModulePath}' is not allowed: '$ref' nodes are only supported at the root level of the structure.`
        );
      }

      ModulesConfigure.validateRefNode(ruleSet, ruleSetModulePath, uses);
    }

    // Validate $size
    if (ruleSet.$size !== undefined) {
      const { min = 0, max } = ruleSet.$size;

      if (max !== undefined && max < min) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidSize,
          `Invalid size range found: max limit ${max} less than min limit ${min} at module path '${ruleSetModulePath}'`
        );
      }
    }

    // Validate $recordLimit
    if (ruleSet.$recordLimit !== undefined) {
      const { max } = ruleSet.$recordLimit;

      if (!Number.isInteger(max) || max < 1) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRecordLimit,
          `Invalid $recordLimit.max value ${max} at module path '${ruleSetModulePath}': must be an integer >= 1.`
        );
      }

      if (max > DwnConstant.maxRecordLimit) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRecordLimit,
          `Invalid $recordLimit.max value ${max} at module path '${ruleSetModulePath}': must be <= ${DwnConstant.maxRecordLimit}.`
        );
      }

      if (ruleSet.$role === true) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRoleRecordLimit,
          `'$recordLimit' cannot be used on role path '${ruleSetModulePath}'; ` +
          `hidden role assignments would remain authorization capabilities.`
        );
      }
    }

    if (ruleSet.$tags !== undefined) {
      const { $allowUndefinedTags, $requiredTags, ...tagProperties } = ruleSet.$tags;

      // validate each tag's schema against the DWN-supported tag schema subset
      for (const tag in tagProperties) {
        const tagSchemaDefinition = tagProperties[tag];
        const schemaError = validateModuleTagSchemaDefinition(
          tagSchemaDefinition,
          `${ruleSetModulePath}/$tags/${tag}`,
        );

        if (schemaError !== undefined) {
          throw new DwnError(DwnErrorCode.ModulesConfigureInvalidTagSchema, `tags schema validation error: ${schemaError}`);
        }
      }
    }

    // validate each action rule
    const actionRules = ruleSet.$actions ?? [];
    ModulesConfigure.validateRoleRecordIssuance(ruleSet, ruleSetModulePath);

    for (let i = 0; i < actionRules.length; i++) {
      const actionRule = actionRules[i];

      // Validate the `role` property of an `action` if exists.
      if (actionRule.role !== undefined) {
        if (isCrossModuleRef(actionRule.role)) {
          // Cross-module role reference: validate alias exists in `uses`
          const parsedRole = ModulesConfigure.validateCrossModuleAlias(actionRule.role, uses, ruleSetModulePath, 'role');
          ModulesConfigure.validateRoleParentContextDepth(parsedRole.modulePath, ruleSetModulePath, actionRule);
        } else {
          // Local role: make sure the role contains a valid module path to a role record
          if (!roles.includes(actionRule.role)) {
            throw new DwnError(
              DwnErrorCode.ModulesConfigureRoleDoesNotExistAtGivenPath,
              `Role in action ${JSON.stringify(actionRule)} for rule set ${ruleSetModulePath} does not exist.`
            );
          }

          ModulesConfigure.validateRoleParentContextDepth(actionRule.role, ruleSetModulePath, actionRule);
        }
      }

      // Validate that if `who` is set to `anyone` then `of` is not set
      if (actionRule.who === 'anyone' && actionRule.of) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidActionOfNotAllowed,
          `'of' is not allowed at rule set module path (${ruleSetModulePath})`
        );
      }

      // Validate that if `who === recipient` and `of === undefined`, then `can` can only contain `co-update`, `co-delete`, and `co-prune`.
      // We do not allow `read` or `write` in the `can` array because:
      // - `read` - Recipients are always allowed to read.
      // - `write` - Entails ability to create and update.
      //             Since `of` is undefined, it implies the recipient of THIS record,
      //             there is no 'recipient' until this record has been created, so it makes no sense to allow recipient to write this record.
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

      // Validate that `of` points to the current module path or an ancestor of it.
      // At runtime, `checkActor()` searches the record chain for a matching `modulePath` equal to `actionRule.of`.
      // If `of` is not the current path or one of its ancestors, the action rule would silently never authorize anyone.
      if (actionRule.of !== undefined && ruleSetModulePath !== '') {
        if (isCrossModuleRef(actionRule.of)) {
          // Cross-module `of` reference: validate alias exists in `uses`
          ModulesConfigure.validateCrossModuleAlias(actionRule.of, uses, ruleSetModulePath, 'of');
        } else {
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

    if (ruleSetModulePath !== '') {
      const typeName = ruleSetModulePath.split('/').pop()!;
      const moduleType = types[typeName];
      if (moduleType?.encryptionRequired === true) {
        if (ruleSet.$keyAgreement === undefined) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureMissingEncryptedPathKeyAgreement,
            `Encrypted module path '${ruleSetModulePath}' has no $keyAgreement.`
          );
        }

        const anyoneCanRead = actionRules.some(
          (rule: ModuleActionRule): boolean => rule.who === ModuleActor.Anyone && rule.can.includes(ModuleAction.Read)
        );
        if (anyoneCanRead) {
          throw new DwnError(
            DwnErrorCode.ModulesConfigureInvalidEncryptedAnyoneRead,
            `Encrypted module path '${ruleSetModulePath}' allows { who: 'anyone', can: ['read'] }.`
          );
        }

        for (const actionRule of actionRules) {
          if (actionRule.role === undefined || !actionRule.can.includes(ModuleAction.Read)) {
            continue;
          }

          if (isCrossModuleRef(actionRule.role)) {
            throw new DwnError(
              DwnErrorCode.ModulesConfigureInvalidEncryptedCrossModuleRole,
              `Encrypted module path '${ruleSetModulePath}' references cross-module read role '${actionRule.role}'.`
            );
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

    // Warn when `$delivery` is set without `$actions`.
    // Delivery targets are determined from `$actions` role records and actor rules.
    // Without `$actions`, the server cannot determine who to deliver records to.
    if (ruleSet.$delivery !== undefined && (ruleSet.$actions === undefined || ruleSet.$actions.length === 0)) {
      console.warn(
        `ModulesConfigure: module path '${ruleSetModulePath}' has $delivery: '${ruleSet.$delivery}' ` +
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
          `ModulesConfigure: module path '${ruleSetModulePath}' has $immutable: true ` +
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
   * `$actions`, `$role`, `$size`, `$tags`, or `$keyAgreement`.
   * Also validates that the `$ref` alias exists in the `uses` map.
   */
  private static validateRefNode(ruleSet: ModuleRuleSet, ruleSetModulePath: string, uses: ModuleUses | undefined): void {
    const ref = ruleSet.$ref!;
    const parsed = parseCrossModuleRef(ref);

    if (parsed === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidRefAlias,
        `'$ref' value '${ref}' at module path '${ruleSetModulePath}' must be in 'alias:typePath' format.`
      );
    }

    // validate alias exists in `uses`
    if (uses?.[parsed.alias] === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidRefAlias,
        `'$ref' alias '${parsed.alias}' at module path '${ruleSetModulePath}' does not exist in the 'uses' map.`
      );
    }

    // validate that `$ref` nodes do not have other directives
    const forbiddenDirectives = ['$actions', '$role', '$size', '$tags', '$keyAgreement', '$encryption', '$recordLimit', '$immutable', '$delivery', '$squash'] as const;
    for (const directive of forbiddenDirectives) {
      if (ruleSet[directive] !== undefined) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRefNodeHasDirectives,
          `'$ref' node at module path '${ruleSetModulePath}' must not have '${directive}'. ` +
          `$ref nodes are pure attachment points — directives belong on child rule sets.`
        );
      }
    }
  }

  /**
   * Validates that a role rule only references a role whose parent context can be found
   * from records at the rule set's module path.
   */
  private static validateRoleParentContextDepth(rolePath: string, ruleSetModulePath: string, actionRule: ModuleActionRule): void {
    const syntheticContextId = ModulesConfigure.getSyntheticContextIdForModulePath(ruleSetModulePath);

    if (getRoleAudienceContextId(rolePath, syntheticContextId) === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureRoleParentContextDepthExceeded,
        `role '${rolePath}' in action ${JSON.stringify(actionRule)} at module path '${ruleSetModulePath}' ` +
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
   * @param ruleSetModulePath - The current module path (for error messages)
   * @param fieldName - The field name ('role' or 'of') for error messages
   */
  private static validateCrossModuleAlias(
    ref: string, uses: ModuleUses | undefined, ruleSetModulePath: string, fieldName: string
  ): CrossModuleRef {
    const parsed = parseCrossModuleRef(ref);

    if (parsed === undefined) {
      // should not happen if isCrossModuleRef() returned true, but guard defensively
      const errorCode = fieldName === 'role'
        ? DwnErrorCode.ModulesConfigureInvalidCrossModuleRole
        : DwnErrorCode.ModulesConfigureInvalidCrossModuleOf;

      throw new DwnError(
        errorCode,
        `cross-module '${fieldName}' reference '${ref}' at module path '${ruleSetModulePath}' ` +
        `could not be parsed as a valid 'alias:path' format.`
      );
    }

    if (uses?.[parsed.alias] === undefined) {
      const errorCode = fieldName === 'role'
        ? DwnErrorCode.ModulesConfigureInvalidCrossModuleRole
        : DwnErrorCode.ModulesConfigureInvalidCrossModuleOf;

      throw new DwnError(
        errorCode,
        `cross-module '${fieldName}' alias '${parsed.alias}' in '${ref}' at module path '${ruleSetModulePath}' ` +
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
