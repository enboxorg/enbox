import type { DataEncodedRecordsWriteMessage } from '../types/records-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { MessageStore } from '../types/message-store.js';
import type {
  ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureDescriptor,
  ProtocolsConfigureMessage, ProtocolTypes, ProtocolUses
} from '../types/protocols-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import Ajv from 'ajv/dist/2020.js';
import { Message } from '../core/message.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { ProtocolsGrantAuthorization } from '../core/protocols-grant-authorization.js';
import { Time } from '../utils/time.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { isCrossProtocolRef, parseCrossProtocolRef } from '../utils/protocols.js';
import { normalizeProtocolUrl, normalizeSchemaUrl, validateProtocolUrlNormalized, validateSchemaUrlNormalized } from '../utils/url.js';
import { ProtocolAction, ProtocolActor, ProtocolRecordLimitStrategy } from '../types/protocols-types.js';

export type ProtocolsConfigureOptions = {
  messageTimestamp?: string;
  definition: ProtocolDefinition;
  signer: MessageSigner;
  /**
   * The delegated grant invoked to sign on behalf of the logical author, which is the grantor of the delegated grant.
   */
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  permissionGrantId?: string;
};

export class ProtocolsConfigure extends AbstractMessage<ProtocolsConfigureMessage> {
  public static async parse(message: ProtocolsConfigureMessage): Promise<ProtocolsConfigure> {
    Message.validateJsonSchema(message);
    ProtocolsConfigure.validateProtocolDefinition(message.descriptor.definition);
    await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);
    Time.validateTimestamp(message.descriptor.messageTimestamp);

    return new ProtocolsConfigure(message);
  }

  public static async create(options: ProtocolsConfigureOptions): Promise<ProtocolsConfigure> {
    const descriptor: ProtocolsConfigureDescriptor = {
      interface        : DwnInterfaceName.Protocols,
      method           : DwnMethodName.Configure,
      messageTimestamp : options.messageTimestamp ?? Time.getCurrentTimestamp(),
      definition       : ProtocolsConfigure.normalizeDefinition(options.definition),
      ...(options.permissionGrantId !== undefined && { permissionGrantId: options.permissionGrantId }),
    };

    const authorization = await Message.createAuthorization({
      descriptor,
      signer            : options.signer,
      delegatedGrant    : options.delegatedGrant,
      permissionGrantId : options.permissionGrantId
    });
    const message = { descriptor, authorization };

    Message.validateJsonSchema(message);
    ProtocolsConfigure.validateProtocolDefinition(message.descriptor.definition);

    const protocolsConfigure = new ProtocolsConfigure(message);
    return protocolsConfigure;
  }

  /**
   * Authorizes the author-delegate who signed this message.
   * @param messageStore Used to check if the grant has been revoked.
   */
  public async authorizeAuthorDelegate(messageStore: MessageStore): Promise<void> {
    const delegatedGrant = PermissionGrant.parse(this.message.authorization.authorDelegatedGrant!);
    await ProtocolsGrantAuthorization.authorizeConfigure({
      protocolsConfigureMessage : this.message,
      expectedGrantor           : this.author!,
      expectedGrantee           : this.signer!,
      permissionGrant           : delegatedGrant,
      messageStore
    });
  }

  /**
   * Performs validation on the given protocol definition that are not easy to do using a JSON schema.
   */
  private static validateProtocolDefinition(definition: ProtocolDefinition): void {
    const { protocol, types, uses } = definition;

    // validate protocol url
    validateProtocolUrlNormalized(protocol);

    // validate schema url normalized
    for (const typeName in types) {
      const schema = types[typeName].schema;
      if (schema !== undefined) {
        validateSchemaUrlNormalized(schema);
      }
    }

    // validate `uses` — alias names must be simple identifiers, values must be normalized URLs, and no self-references
    if (uses !== undefined) {
      ProtocolsConfigure.validateUses(uses, protocol);
    }

    // validate `structure`
    ProtocolsConfigure.validateStructure(definition);
  }

  /**
   * Validates the `uses` map: alias names must match `^[a-zA-Z][a-zA-Z0-9_-]*$`,
   * values must be normalized protocol URLs, and no alias may reference the protocol itself.
   */
  private static validateUses(uses: ProtocolUses, ownProtocolUri: string): void {
    const aliasPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

    for (const alias in uses) {
      if (!aliasPattern.test(alias)) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidUsesAlias,
          `invalid 'uses' alias '${alias}': must match pattern ${aliasPattern.toString()}.`
        );
      }

      try {
        validateProtocolUrlNormalized(uses[alias]);
      } catch {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidUsesProtocolUrl,
          `invalid 'uses' protocol URL for alias '${alias}': '${uses[alias]}' is not a valid normalized protocol URL.`
        );
      }

      // reject self-references: a protocol cannot compose itself
      if (uses[alias] === ownProtocolUri) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidUsesSelfReference,
          `'uses' alias '${alias}' references the protocol's own URI '${ownProtocolUri}'. ` +
          `a protocol cannot compose itself.`
        );
      }
    }
  }

  private static validateStructure(definition: ProtocolDefinition): void {
    const { uses } = definition;

    // gather all declared record types
    const recordTypes = Object.keys(definition.types);

    // gather all roles (local roles only — cross-protocol roles are validated by alias existence)
    const roles = ProtocolsConfigure.fetchAllRolePathsRecursively('', definition.structure as ProtocolRuleSet, []);

    // validate the entire rule set structure recursively
    ProtocolsConfigure.validateRuleSetRecursively({
      ruleSet             : definition.structure as ProtocolRuleSet,
      ruleSetProtocolPath : '',
      recordTypes,
      roles,
      uses,
      types               : definition.types,
    });
  }

  /**
   * Parses the given rule set hierarchy to get all the role protocol paths.
   * @throws DwnError if the hierarchy depth goes beyond 10 levels.
   */
  private static fetchAllRolePathsRecursively(ruleSetProtocolPath: string, ruleSet: ProtocolRuleSet, roles: string[]): string[] {
    // Limit the depth of the record hierarchy to 10 levels
    // There is opportunity to optimize here to avoid repeated string splitting
    if (ruleSetProtocolPath.split('/').length > 10) {
      throw new DwnError(DwnErrorCode.ProtocolsConfigureRecordNestingDepthExceeded, 'Record nesting depth exceeded 10 levels.');
    }

    for (const recordType in ruleSet) {
      // ignore non-nested-record properties
      if (recordType.startsWith('$')) {
        continue;
      }

      const childRuleSet = ruleSet[recordType] as ProtocolRuleSet;

      let childRuleSetProtocolPath;
      if (ruleSetProtocolPath === '') {
        childRuleSetProtocolPath = recordType;
      } else {
        childRuleSetProtocolPath = `${ruleSetProtocolPath}/${recordType}`;
      }

      // if this is a role record, add it to the list, else continue to traverse
      if (childRuleSet.$role) {
        roles.push(childRuleSetProtocolPath);
      } else {
        ProtocolsConfigure.fetchAllRolePathsRecursively(childRuleSetProtocolPath, childRuleSet, roles);
      }
    }

    return roles;
  }

  /**
   * Validates the given rule set structure then recursively validates its nested child rule sets.
   */
  private static validateRuleSetRecursively(
    input: {
      ruleSet: ProtocolRuleSet, ruleSetProtocolPath: string, recordTypes: string[],
      roles: string[], uses?: ProtocolUses, types: ProtocolTypes
    }
  ): void {
    const { ruleSet, ruleSetProtocolPath, recordTypes, roles, uses, types } = input;

    // Validate $ref constraints: $ref is only supported at root level (no `/` in protocol path),
    // and a $ref node is a pure attachment point with no other directives.
    if (ruleSet.$ref !== undefined) {
      if (ruleSetProtocolPath.includes('/')) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidRefNotAtRoot,
          `'$ref' at protocol path '${ruleSetProtocolPath}' is not allowed: '$ref' nodes are only supported at the root level of the structure.`
        );
      }

      ProtocolsConfigure.validateRefNode(ruleSet, ruleSetProtocolPath, uses);
    }

    // Validate $size
    if (ruleSet.$size !== undefined) {
      const { min = 0, max } = ruleSet.$size;

      if (max !== undefined && max < min) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidSize,
          `Invalid size range found: max limit ${max} less than min limit ${min} at protocol path '${ruleSetProtocolPath}'`
        );
      }
    }

    // Validate $recordLimit
    if (ruleSet.$recordLimit !== undefined) {
      const { max, strategy } = ruleSet.$recordLimit;

      if (!Number.isInteger(max) || max < 1) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidRecordLimit,
          `Invalid $recordLimit.max value ${max} at protocol path '${ruleSetProtocolPath}': must be an integer >= 1.`
        );
      }

      const validStrategies = Object.values(ProtocolRecordLimitStrategy) as string[];
      if (!validStrategies.includes(strategy as string)) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidRecordLimit,
          `Invalid $recordLimit.strategy '${strategy}' at protocol path '${ruleSetProtocolPath}': ` +
          `must be one of ${validStrategies.join(', ')}.`
        );
      }
    }

    if (ruleSet.$tags) {
      const ajv = new Ajv.default();
      const { $allowUndefinedTags, $requiredTags, ...tagProperties } = ruleSet.$tags;

      // we validate each tag's expected schema to ensure it is a valid JSON schema
      for (const tag in tagProperties) {
        const tagSchemaDefinition = tagProperties[tag];

        if (!ajv.validateSchema(tagSchemaDefinition as Record<string, unknown>)) {
          const schemaError = ajv.errorsText(ajv.errors, { dataVar: `${ruleSetProtocolPath}/$tags/${tag}` });
          throw new DwnError(DwnErrorCode.ProtocolsConfigureInvalidTagSchema, `tags schema validation error: ${schemaError}`);
        }
      }
    }

    // validate each action rule
    const actionRules = ruleSet.$actions ?? [];
    for (let i = 0; i < actionRules.length; i++) {
      const actionRule = actionRules[i];

      // Validate the `role` property of an `action` if exists.
      if (actionRule.role !== undefined) {
        if (isCrossProtocolRef(actionRule.role)) {
          // Cross-protocol role reference: validate alias exists in `uses`
          ProtocolsConfigure.validateCrossProtocolAlias(actionRule.role, uses, ruleSetProtocolPath, 'role');
        } else {
          // Local role: make sure the role contains a valid protocol path to a role record
          if (!roles.includes(actionRule.role)) {
            throw new DwnError(
              DwnErrorCode.ProtocolsConfigureRoleDoesNotExistAtGivenPath,
              `Role in action ${JSON.stringify(actionRule)} for rule set ${ruleSetProtocolPath} does not exist.`
            );
          }
        }
      }

      // Validate that if `who` is set to `anyone` then `of` is not set
      if (actionRule.who === 'anyone' && actionRule.of) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidActionOfNotAllowed,
          `'of' is not allowed at rule set protocol path (${ruleSetProtocolPath})`
        );
      }

      // Validate that if `who === recipient` and `of === undefined`, then `can` can only contain `co-update`, `co-delete`, and `co-prune`.
      // We do not allow `read` or `write` in the `can` array because:
      // - `read` - Recipients are always allowed to read.
      // - `write` - Entails ability to create and update.
      //             Since `of` is undefined, it implies the recipient of THIS record,
      //             there is no 'recipient' until this record has been created, so it makes no sense to allow recipient to write this record.
      if (actionRule.who === ProtocolActor.Recipient && actionRule.of === undefined) {

        // throw if `can` contains a value that is not `co-update`, `co-delete`, or `co-prune`
        const hasDisallowedAction = actionRule.can.some(
          action => ![ProtocolAction.CoUpdate, ProtocolAction.CoDelete, ProtocolAction.CoPrune].includes(action as ProtocolAction)
        );
        if (hasDisallowedAction) {
          throw new DwnError(
            DwnErrorCode.ProtocolsConfigureInvalidRecipientOfAction,
            'Rules for `recipient` without `of` property must have `can` containing only `co-update`, `co-delete`, and `co-prune`.'
          );
        }
      }

      // Validate that if `who` is set to `author` then `of` is set
      if (actionRule.who === ProtocolActor.Author && !actionRule.of) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidActionMissingOf,
          `'of' is required when 'author' is specified as 'who'`
        );
      }

      // Validate that `of` points to the current protocol path or an ancestor of it.
      // At runtime, `checkActor()` searches the record chain for a matching `protocolPath` equal to `actionRule.of`.
      // If `of` is not the current path or one of its ancestors, the action rule would silently never authorize anyone.
      if (actionRule.of !== undefined && ruleSetProtocolPath !== '') {
        if (isCrossProtocolRef(actionRule.of)) {
          // Cross-protocol `of` reference: validate alias exists in `uses`
          ProtocolsConfigure.validateCrossProtocolAlias(actionRule.of, uses, ruleSetProtocolPath, 'of');
        } else {
          // Local `of`: must be self or ancestor
          const isSelfOrAncestor = ruleSetProtocolPath === actionRule.of
            || ruleSetProtocolPath.startsWith(actionRule.of + '/');
          if (!isSelfOrAncestor) {
            throw new DwnError(
              DwnErrorCode.ProtocolsConfigureInvalidActionOfNotAnAncestor,
              `'of' value '${actionRule.of}' is not an ancestor of protocol path '${ruleSetProtocolPath}' ` +
              `in action rule ${JSON.stringify(actionRule)}.`
            );
          }
        }
      }

      // validate that if `can` contains `update`, `delete`, or `prune`, it must also contain `create`
      // because these are author-only actions, and you can only be the author if you can create
      if (actionRule.can !== undefined) {
        if (actionRule.can.includes(ProtocolAction.Update) && !actionRule.can.includes(ProtocolAction.Create)) {
          throw new DwnError(
            DwnErrorCode.ProtocolsConfigureInvalidActionUpdateWithoutCreate,
            `Action rule ${JSON.stringify(actionRule)} contains 'update' action but missing the required 'create' action.`
          );
        }

        if (actionRule.can.includes(ProtocolAction.Delete) && !actionRule.can.includes(ProtocolAction.Create)) {
          throw new DwnError(
            DwnErrorCode.ProtocolsConfigureInvalidActionDeleteWithoutCreate,
            `Action rule ${JSON.stringify(actionRule)} contains 'delete' action but missing the required 'create' action.`
          );
        }

        if (actionRule.can.includes(ProtocolAction.Prune) && !actionRule.can.includes(ProtocolAction.Create)) {
          throw new DwnError(
            DwnErrorCode.ProtocolsConfigureInvalidActionPruneWithoutCreate,
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
              DwnErrorCode.ProtocolsConfigureDuplicateRoleInRuleSet,
              `More than one action rule per role ${actionRule.role} not allowed within a rule set: ${JSON.stringify(actionRule)}`
            );
          }
        } else {
          if (actionRule.who === otherActionRule.who && actionRule.of === otherActionRule.of) {
            throw new DwnError(
              DwnErrorCode.ProtocolsConfigureDuplicateActorInRuleSet,
              `More than one action rule per actor ${actionRule.who} of ${actionRule.of} ` +
              `not allowed within a rule set: ${JSON.stringify(actionRule)}`
            );
          }
        }
      }
    }

    // Warn when `encryptionRequired: true` is combined with `{ who: 'anyone', can: ['read'] }`.
    // Authorization allows anyone to read the record, but encryption prevents them from
    // decrypting the data — almost certainly unintentional. (issue #115)
    if (ruleSetProtocolPath !== '') {
      const typeName = ruleSetProtocolPath.split('/').pop()!;
      const protocolType = types[typeName];
      if (protocolType?.encryptionRequired === true) {
        const anyoneCanRead = actionRules.some(
          (rule: ProtocolActionRule): boolean => rule.who === ProtocolActor.Anyone && rule.can.includes(ProtocolAction.Read)
        );
        if (anyoneCanRead) {
          console.warn(
            `ProtocolsConfigure: type '${typeName}' at path '${ruleSetProtocolPath}' has ` +
            `encryptionRequired: true but allows { who: 'anyone', can: ['read'] }. ` +
            `Anyone can read the record but no one outside the key holders can decrypt it.`
          );
        }
      }
    }

    // Warn when `$delivery` is set without `$actions`.
    // Delivery targets are determined from `$actions` role records and actor rules.
    // Without `$actions`, the server cannot determine who to deliver records to.
    if (ruleSet.$delivery !== undefined && (ruleSet.$actions === undefined || ruleSet.$actions.length === 0)) {
      console.warn(
        `ProtocolsConfigure: protocol path '${ruleSetProtocolPath}' has $delivery: '${ruleSet.$delivery}' ` +
        `but no $actions rules. The server uses $actions to determine delivery targets — ` +
        `without $actions, no participants can be resolved for delivery.`
      );
    }

    // Warn when `$immutable: true` is combined with `$actions` that include `update` or `co-update`.
    // The `$immutable` directive overrides any update permission — updates are always rejected.
    if (ruleSet.$immutable === true && actionRules.length > 0) {
      const hasUpdateAction = actionRules.some(
        (rule: ProtocolActionRule): boolean =>
          rule.can.includes(ProtocolAction.Update) || rule.can.includes(ProtocolAction.CoUpdate)
      );
      if (hasUpdateAction) {
        console.warn(
          `ProtocolsConfigure: protocol path '${ruleSetProtocolPath}' has $immutable: true ` +
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

      const childRuleSet = ruleSet[recordType] as ProtocolRuleSet;

      // A structure key whose rule set has `$ref` does not need to be in the local `types` map —
      // the type comes from the referenced protocol. All other keys must be in `types`.
      if (childRuleSet.$ref === undefined && !recordTypes.includes(recordType)) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidRuleSetRecordType,
          `Rule set ${recordType} is not declared as an allowed type in the protocol definition.`
        );
      }

      let childRuleSetProtocolPath;
      if (ruleSetProtocolPath === '') {
        childRuleSetProtocolPath = recordType; // case of initial definition structure
      } else {
        childRuleSetProtocolPath = `${ruleSetProtocolPath}/${recordType}`;
      }

      ProtocolsConfigure.validateRuleSetRecursively({
        ruleSet             : childRuleSet,
        ruleSetProtocolPath : childRuleSetProtocolPath,
        recordTypes,
        roles,
        uses,
        types,
      });
    }
  }

  /**
   * Validates that a `$ref` node is a pure attachment point: it must NOT have
   * `$actions`, `$role`, `$size`, `$tags`, or `$encryption`.
   * Also validates that the `$ref` alias exists in the `uses` map.
   */
  private static validateRefNode(ruleSet: ProtocolRuleSet, ruleSetProtocolPath: string, uses: ProtocolUses | undefined): void {
    const ref = ruleSet.$ref!;
    const parsed = parseCrossProtocolRef(ref);

    if (parsed === undefined) {
      throw new DwnError(
        DwnErrorCode.ProtocolsConfigureInvalidRefAlias,
        `'$ref' value '${ref}' at protocol path '${ruleSetProtocolPath}' must be in 'alias:typePath' format.`
      );
    }

    // validate alias exists in `uses`
    if (uses?.[parsed.alias] === undefined) {
      throw new DwnError(
        DwnErrorCode.ProtocolsConfigureInvalidRefAlias,
        `'$ref' alias '${parsed.alias}' at protocol path '${ruleSetProtocolPath}' does not exist in the 'uses' map.`
      );
    }

    // validate that `$ref` nodes do not have other directives
    const forbiddenDirectives = ['$actions', '$role', '$size', '$tags', '$encryption', '$recordLimit', '$immutable', '$delivery', '$squash'] as const;
    for (const directive of forbiddenDirectives) {
      if (ruleSet[directive] !== undefined) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureInvalidRefNodeHasDirectives,
          `'$ref' node at protocol path '${ruleSetProtocolPath}' must not have '${directive}'. ` +
          `$ref nodes are pure attachment points — directives belong on child rule sets.`
        );
      }
    }
  }

  /**
   * Validates that a cross-protocol reference (in `alias:path` format) has a valid alias
   * that exists in the `uses` map.
   * @param ref - The cross-protocol reference string (e.g., "threads:thread/participant")
   * @param uses - The protocol definition's `uses` map
   * @param ruleSetProtocolPath - The current protocol path (for error messages)
   * @param fieldName - The field name ('role' or 'of') for error messages
   */
  private static validateCrossProtocolAlias(
    ref: string, uses: ProtocolUses | undefined, ruleSetProtocolPath: string, fieldName: string
  ): void {
    const parsed = parseCrossProtocolRef(ref);

    if (parsed === undefined) {
      // should not happen if isCrossProtocolRef() returned true, but guard defensively
      const errorCode = fieldName === 'role'
        ? DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole
        : DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolOf;

      throw new DwnError(
        errorCode,
        `cross-protocol '${fieldName}' reference '${ref}' at protocol path '${ruleSetProtocolPath}' ` +
        `could not be parsed as a valid 'alias:path' format.`
      );
    }

    if (uses?.[parsed.alias] === undefined) {
      const errorCode = fieldName === 'role'
        ? DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole
        : DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolOf;

      throw new DwnError(
        errorCode,
        `cross-protocol '${fieldName}' alias '${parsed.alias}' in '${ref}' at protocol path '${ruleSetProtocolPath}' ` +
        `does not exist in the 'uses' map.`
      );
    }
  }

  private static normalizeDefinition(definition: ProtocolDefinition): ProtocolDefinition {
    // Deep clone types to avoid mutating the caller's nested objects
    const typesCopy: ProtocolDefinition['types'] = {};
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

    // Normalize `uses` protocol URLs (skip invalid URLs — they will be caught by validateUses)
    let usesCopy: ProtocolDefinition['uses'];
    if (definition.uses !== undefined) {
      usesCopy = {};
      for (const alias in definition.uses) {
        try {
          usesCopy[alias] = normalizeProtocolUrl(definition.uses[alias]);
        } catch {
          usesCopy[alias] = definition.uses[alias];
        }
      }
    }

    return {
      ...definition,
      protocol : normalizeProtocolUrl(definition.protocol),
      types    : typesCopy,
      ...(usesCopy !== undefined && { uses: usesCopy }),
    };
  }
}
