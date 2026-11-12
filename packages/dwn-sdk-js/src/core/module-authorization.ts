import type { RecordsCount } from '../interfaces/records-count.js';
import type { RecordsDelete } from '../interfaces/records-delete.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsRead } from '../interfaces/records-read.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ResolvedModuleRole } from './module-authorization-action.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ModuleAction, ModuleActionRule, ModuleRuleSet } from '../types/modules-types.js';
import type { ResolvedModuleGraph, ResolvedModuleNode, ResolvedRoleReference } from './module-graph.js';

import { EncryptionControl } from './encryption-control.js';
import { isEncryptionControlPath } from './constants.js';
import { loadModuleGraph } from './module-graph-loader.js';
import { ModuleActor } from '../types/modules-types.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

import {
  authorizeAgainstAllowedActions,
  getInitialWriteActionsSeekingARuleMatch,
  verifyInvokedRole,
} from './module-authorization-action.js';
import {
  verifyAsRoleRecordIfNeeded,
  verifyImmutability,
  verifyModulePathAndContextId,
  verifyModulePathEncryptionIfNeeded,
  verifySizeLimit,
  verifySquashEligibility,
  verifyTagsIfNeeded,
  verifyType,
} from './module-authorization-validation.js';

export class ModuleAuthorization {

  /**
   * Performs validation on the structure of RecordsWrite messages that use a module.
   * @throws {Error} if validation fails.
   */
  public static async validateReferentialIntegrity(
    tenant: string,
    incomingMessage: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<ModuleRuleSet> {
    if (isEncryptionControlPath(incomingMessage.message.descriptor.modulePath)) {
      await EncryptionControl.validateReferentialIntegrity(tenant, incomingMessage, validationStateReader);
      return {};
    }

    const moduleDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the module definition active at the incoming message timestamp
    const resolvedGraph = await loadModuleGraph(
      tenant, incomingMessage.message.descriptor.module, validationStateReader, moduleDefinitionTimestamp,
    );
    const moduleDefinition = resolvedGraph.definitionsByUri.get(resolvedGraph.rootModuleUri)!;

    const resolvedNode = ModuleAuthorization.getRecordNode(incomingMessage.message.descriptor.modulePath, resolvedGraph, true);
    const ruleSet = resolvedNode.ruleSet;
    const moduleType = verifyType(incomingMessage.message, moduleDefinition.types);
    await verifyModulePathEncryptionIfNeeded(
      tenant, incomingMessage.message, moduleDefinition, resolvedNode, moduleType, validationStateReader,
    );
    await verifyModulePathAndContextId(tenant, incomingMessage, validationStateReader, resolvedNode);

    // Validate as a role record if the incoming message is writing a role record
    await verifyAsRoleRecordIfNeeded(
      tenant,
      incomingMessage,
      resolvedNode,
      validationStateReader,
    );

    // Verify size limit
    verifySizeLimit(incomingMessage, ruleSet);

    // Verify module tags
    verifyTagsIfNeeded(incomingMessage, ruleSet);

    // Verify immutability — reject updates to write-once records
    await verifyImmutability(incomingMessage, ruleSet);

    // Verify squash eligibility — ensure squash writes are at $squash: true paths and are initial writes
    await verifySquashEligibility(incomingMessage, ruleSet);

    return ruleSet;
  }

  /**
   * Revalidates a stored initial write against the module definition that governed its creation timestamp.
   *
   * This is used only for destructive config-history repair, so it deliberately validates config-owned
   * structure and avoids live dependency checks. Missing grant, role, or parent records must not cause
   * an already-admitted record to be hard-purged.
   */
  public static async validateStoredInitialWrite(
    tenant: string,
    incomingMessage: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    await ModuleAuthorization.verifyStoredInitialWrite(incomingMessage);

    // Encryption control records live at reserved virtual paths and are admitted through
    // `EncryptionControl` validation (see `validateReferentialIntegrity()`), never against the
    // app definition's structure. Revalidate their config-owned admission invariants against
    // the role rule set that governed the record timestamp, then apply the same conservative
    // static-create authorization replay used for ordinary records.
    if (isEncryptionControlPath(incomingMessage.message.descriptor.modulePath)) {
      const governingRuleSet = await EncryptionControl.validateStoredControlRecord(
        tenant, incomingMessage, validationStateReader
      );
      const controlGraph = await loadModuleGraph(
        tenant, incomingMessage.message.descriptor.module, validationStateReader, incomingMessage.message.descriptor.messageTimestamp,
      );
      ModuleAuthorization.verifyStoredInitialWriteCreateAction(tenant, incomingMessage, governingRuleSet, controlGraph);
      return;
    }

    const moduleDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;
    const resolvedGraph = await loadModuleGraph(
      tenant, incomingMessage.message.descriptor.module, validationStateReader, moduleDefinitionTimestamp,
    );
    const moduleDefinition = resolvedGraph.definitionsByUri.get(resolvedGraph.rootModuleUri)!;

    const resolvedNode = ModuleAuthorization.getRecordNode(incomingMessage.message.descriptor.modulePath, resolvedGraph, true);
    const ruleSet = resolvedNode.ruleSet;
    const moduleType = verifyType(incomingMessage.message, moduleDefinition.types);
    await verifyModulePathEncryptionIfNeeded(
      tenant, incomingMessage.message, moduleDefinition, resolvedNode, moduleType, validationStateReader,
    );

    ModuleAuthorization.verifyStoredInitialWriteRoleRecipientIfNeeded(incomingMessage, ruleSet);
    verifySizeLimit(incomingMessage, ruleSet);
    verifyTagsIfNeeded(incomingMessage, ruleSet);
    await verifySquashEligibility(incomingMessage, ruleSet);
    ModuleAuthorization.verifyStoredInitialWriteCreateAction(tenant, incomingMessage, ruleSet, resolvedGraph);
  }

  /**
   * Performs module-based authorization against the incoming RecordsWrite message.
   * @throws {Error} if authorization fails.
   */
  public static async authorizeWrite(
    tenant: string,
    incomingMessage: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    const existingInitialWrite = await validationStateReader.fetchInitialWrite(tenant, incomingMessage.message.recordId);

    let recordChain;
    if (existingInitialWrite === undefined) {
      // NOTE: we can assume this message is an initial write because an existing initial write does not exist.
      // Additionally, we check further down in the `RecordsWriteHandler` if the incoming message is an initialWrite,
      // so we don't check explicitly here to avoid an unnecessary duplicate check.
      recordChain = await validationStateReader.constructRecordChain(tenant, incomingMessage.message.descriptor.parentId);
    } else {
      recordChain = await validationStateReader.constructRecordChain(tenant, incomingMessage.message.recordId);
    }

    const moduleDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the module definition active at the incoming message timestamp
    const resolvedGraph = await loadModuleGraph(
      tenant, incomingMessage.message.descriptor.module, validationStateReader, moduleDefinitionTimestamp,
    );

    // get the rule set for the inbound message
    const resolvedNode = ModuleAuthorization.getRecordNode(
      incomingMessage.message.descriptor.modulePath,
      resolvedGraph,
      true,
    );

    // If the incoming message has `moduleRole` in the descriptor, validate the invoked role
    const resolvedRole = await verifyInvokedRole(
      tenant, incomingMessage, incomingMessage.message.contextId, resolvedGraph, validationStateReader,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      resolvedNode,
      recordChain,
      validationStateReader,
      resolvedRole,
    );
  }

  /**
   * Performs module-based authorization against the incoming `RecordsRead` message.
   * @param newestRecordsWrite The latest RecordsWrite associated with the recordId being read.
   * @throws {Error} if authorization fails.
   */
  public static async authorizeRead(
    tenant: string,
    incomingMessage: RecordsRead,
    newestRecordsWrite: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<ResolvedModuleRole | undefined> {
    // fetch record chain
    const recordChain: RecordsWriteMessage[] =
      await validationStateReader.constructRecordChain(tenant, newestRecordsWrite.message.recordId);

    const moduleDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the module definition active at the incoming message timestamp
    const resolvedGraph = await loadModuleGraph(
      tenant, newestRecordsWrite.message.descriptor.module, validationStateReader, moduleDefinitionTimestamp,
    );

    // get the rule set for the inbound message
    const resolvedNode = ModuleAuthorization.getRecordNode(
      newestRecordsWrite.message.descriptor.modulePath,
      resolvedGraph,
    );

    // If the incoming message has `moduleRole` in the descriptor, validate the invoked role
    const resolvedRole = await verifyInvokedRole(
      tenant, incomingMessage, newestRecordsWrite.message.contextId, resolvedGraph, validationStateReader,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      resolvedNode,
      recordChain,
      validationStateReader,
      resolvedRole,
    );

    return resolvedRole;
  }

  public static async authorizeQueryOrSubscribe(
    tenant: string,
    incomingMessage: RecordsCount | RecordsQuery | RecordsSubscribe,
    validationStateReader: ValidationStateReader,
  ): Promise<ResolvedModuleRole | undefined> {
    const { module, modulePath, contextId } = incomingMessage.message.descriptor.filter;
    const moduleDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the module definition
    const resolvedGraph = await loadModuleGraph(tenant, module!, validationStateReader, moduleDefinitionTimestamp);

    // get the rule set for the inbound message
    const resolvedNode = ModuleAuthorization.getRecordNode(
      modulePath!, // presence of `modulePath` is verified in `parse()`
      resolvedGraph,
    );

    // If the incoming message has `moduleRole` in the descriptor, validate the invoked role
    const resolvedRole = await verifyInvokedRole(tenant, incomingMessage, contextId, resolvedGraph, validationStateReader);

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      resolvedNode,
      [], // record chain is not relevant to queries or subscriptions
      validationStateReader,
      resolvedRole,
    );

    return resolvedRole;
  }

  /**
   * Performs module-based authorization against the incoming `RecordsDelete` message.
   * @param recordsWrite A `RecordsWrite` of the record being deleted.
   */
  public static async authorizeDelete(
    tenant: string,
    incomingMessage: RecordsDelete,
    recordsWrite: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {

    // fetch record chain
    const recordChain: RecordsWriteMessage[] =
      await validationStateReader.constructRecordChain(tenant, incomingMessage.message.descriptor.recordId);

    const moduleDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the module definition active at the incoming message timestamp
    const resolvedGraph = await loadModuleGraph(
      tenant, recordsWrite.message.descriptor.module, validationStateReader, moduleDefinitionTimestamp,
    );

    // get the rule set for the inbound message
    const resolvedNode = ModuleAuthorization.getRecordNode(
      recordsWrite.message.descriptor.modulePath,
      resolvedGraph,
    );

    // If the incoming message has `moduleRole` in the descriptor, validate the invoked role
    const resolvedRole = await verifyInvokedRole(
      tenant, incomingMessage, recordsWrite.message.contextId, resolvedGraph, validationStateReader,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      resolvedNode,
      recordChain,
      validationStateReader,
      resolvedRole,
    );
  }

  /**
   * Gets the rule set corresponding to the given modulePath.
   */
  private static getRecordNode(modulePath: string, graph: ResolvedModuleGraph, forWrite = false): ResolvedModuleNode {
    const node = graph.nodesByDeclaredPath.get(modulePath);
    if (node === undefined) {
      const code = forWrite ? DwnErrorCode.ModuleAuthorizationInvalidType : DwnErrorCode.ModuleAuthorizationMissingRuleSet;
      throw new DwnError(code, `no local record type defined for modulePath ${modulePath}`);
    }
    if (node.kind === 'ref') {
      const code = forWrite ? DwnErrorCode.ModuleAuthorizationRefNodeWriteNotAllowed : DwnErrorCode.ModuleAuthorizationMissingRuleSet;
      throw new DwnError(code, `modulePath '${modulePath}' is a virtual reference, not a local record.`);
    }
    return node;
  }

  private static async verifyStoredInitialWrite(incomingMessage: RecordsWrite): Promise<void> {
    if (await incomingMessage.isInitialWrite()) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationInitialWriteRevalidationNotInitial,
      'stored write revalidation only supports initial RecordsWrite messages'
    );
  }

  private static verifyStoredInitialWriteRoleRecipientIfNeeded(
    incomingMessage: RecordsWrite,
    ruleSet: ModuleRuleSet,
  ): void {
    if (ruleSet.$role !== true || incomingMessage.message.descriptor.recipient !== undefined) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationStoredInitialWriteRoleMissingRecipient,
      'role records must have a recipient'
    );
  }

  private static verifyStoredInitialWriteCreateAction(
    tenant: string,
    incomingMessage: RecordsWrite,
    ruleSet: ModuleRuleSet,
    graph: ResolvedModuleGraph,
  ): void {
    if (ModuleAuthorization.isStoredInitialWriteDirectlyAuthorized(tenant, incomingMessage)) {
      return;
    }

    const actionRules = ruleSet.$actions;
    if (actionRules === undefined) {
      throw new DwnError(
        DwnErrorCode.ModuleAuthorizationStoredInitialWriteActionRulesNotFound,
        `no create action rule defined for stored RecordsWrite by author ${incomingMessage.author}`
      );
    }
    const actions = getInitialWriteActionsSeekingARuleMatch(incomingMessage);

    const invokedRole = ModuleAuthorization.resolveStoredInitialWriteRole(incomingMessage, graph);
    if (actionRules.some(rule => ModuleAuthorization.storedCreateRuleAllowsRecord(rule, actions, invokedRole, graph))) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationStoredInitialWriteActionNotAllowed,
      `stored RecordsWrite by author ${incomingMessage.author} is not allowed by the resolved module config`
    );
  }

  /** Only conclusive governing-configuration failures prove that the signed role is invalid. */
  private static resolveStoredInitialWriteRole(
    incomingMessage: RecordsWrite,
    graph: ResolvedModuleGraph,
  ): ResolvedRoleReference | undefined {
    const rawInvokedRole = incomingMessage.signaturePayload?.moduleRole;
    if (rawInvokedRole === undefined) {
      return undefined;
    }
    try {
      return graph.resolveInvokedRole(rawInvokedRole);
    } catch (error) {
      // The complete governing graph is already loaded. Other errors can still
      // reflect unavailable dependencies, so preserve their conservative classification.
      if (error instanceof DwnError && [
        DwnErrorCode.ModulesConfigureInvalidRefAlias,
        DwnErrorCode.ModulesConfigureInvalidRefModulePath,
        DwnErrorCode.ModulesConfigureRoleDoesNotExistAtGivenPath,
      ].includes(error.code as DwnErrorCode)) {
        throw new DwnError(
          DwnErrorCode.ModuleAuthorizationStoredInitialWriteActionNotAllowed,
          `stored RecordsWrite invokes role '${rawInvokedRole}' which is invalid under the governing module config`
        );
      }
      throw error;
    }
  }

  /** Match immutable role identity while leaving parent-dependent actor rules to live authorization. */
  private static storedCreateRuleAllowsRecord(
    rule: ModuleActionRule,
    actions: readonly ModuleAction[],
    invokedRole: ResolvedRoleReference | undefined,
    graph: ResolvedModuleGraph,
  ): boolean {
    if (!rule.can.some((allowedAction: string): boolean => actions.includes(allowedAction as ModuleAction))) {
      return false;
    }
    if (invokedRole !== undefined) {
      if (rule.role === undefined) {
        return false;
      }
      const expected = graph.resolveInvokedRole(rule.role);
      return expected.owningModuleUri === invokedRole.owningModuleUri && expected.owningModulePath === invokedRole.owningModulePath;
    }
    // Author/recipient rules depend on mutable parent records. Reconciliation
    // must not hard-purge a record whose validity needs that live evidence.
    return rule.who === ModuleActor.Anyone || rule.who === ModuleActor.Author || rule.who === ModuleActor.Recipient;
  }

  private static isStoredInitialWriteDirectlyAuthorized(tenant: string, incomingMessage: RecordsWrite): boolean {
    return incomingMessage.owner !== undefined ||
      incomingMessage.author === tenant ||
      incomingMessage.isSignedByAuthorDelegate ||
      incomingMessage.isSignedByOwnerDelegate ||
      incomingMessage.signaturePayload?.permissionGrantId !== undefined;
  }

}
