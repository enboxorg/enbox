import type { ModuleActionRule } from '../types/modules-types.js';
import type { RecordsCount } from '../interfaces/records-count.js';
import type { RecordsDelete } from '../interfaces/records-delete.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsRead } from '../interfaces/records-read.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ResolvedModuleAction, ResolvedModuleGraph, ResolvedModuleNode } from './module-graph.js';

import { DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRoleContextPrefix } from './module-role-records.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { ModuleAction, ModuleActor } from '../types/modules-types.js';

/**
 * A DWN message subject to module action-rule authorization checks.
 */
type ModuleAuthorizableMessage = RecordsCount | RecordsDelete | RecordsQuery | RecordsRead | RecordsSubscribe | RecordsWrite;

/** The indexed role-record lookup proven by module authorization. */
export type ResolvedModuleRole = {
  contextIdPrefix?: string;
  module: string;
  modulePath: string;
  /** Concrete active role assignment, when latest state is locally available. */
  roleRecordId?: string;
};

/**
 * Check if the incoming message is invoking a role. If so, validate the invoked role.
 * For cross-module role invocation, the role record may live in a different module
 * (resolved via the composing module's `uses` map).
 */
export async function verifyInvokedRole(
  tenant: string,
  incomingMessage: ModuleAuthorizableMessage,
  contextId: string | undefined,
  graph: ResolvedModuleGraph,
  validationStateReader: ValidationStateReader,
): Promise<ResolvedModuleRole | undefined> {
  const moduleRole = incomingMessage.signaturePayload?.moduleRole;
  if (moduleRole === undefined) {
    return undefined;
  }
  let role;
  try {
    role = graph.resolveInvokedRole(moduleRole);
  } catch (error) {
    if (error instanceof DwnError && [
      DwnErrorCode.ModulesConfigureInvalidRefAlias,
      DwnErrorCode.ModulesConfigureInvalidRefModulePath,
      DwnErrorCode.ModulesConfigureRoleDoesNotExistAtGivenPath,
    ].includes(error.code as DwnErrorCode)) {
      throw new DwnError(DwnErrorCode.ModuleAuthorizationNotARole, `module role '${moduleRole}' does not identify a role record.`);
    }
    throw error;
  }
  const contextIdPrefix = getRoleContextPrefix(role, contextId);
  if (role.parentPhysicalDepth > 0 && contextIdPrefix === undefined) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationMissingContextId,
      `could not verify contextual role '${moduleRole}' without its complete parent context.`);
  }
  const resolvedRole: ResolvedModuleRole = {
    contextIdPrefix,
    module     : role.owningModuleUri,
    modulePath : role.owningModulePath,
  };
  resolvedRole.roleRecordId = await verifyModuleRoleRecord(tenant, incomingMessage.author!, resolvedRole, validationStateReader);
  return resolvedRole;
}

/** Verifies that the current role record still assigns a resolved module role to its recipient. */
export async function verifyModuleRoleRecord(
  tenant: string,
  recipient: string,
  resolvedRole: ResolvedModuleRole,
  validationStateReader: ValidationStateReader,
): Promise<string | undefined> {
  const selector = {
    tenant,
    module          : resolvedRole.module,
    modulePath      : resolvedRole.modulePath,
    recipient,
    contextIdPrefix : resolvedRole.contextIdPrefix,
  };
  const latestRoleRecords = await validationStateReader.queryLatestRoleRecords(selector);
  const expectedRoleRecordId = resolvedRole.roleRecordId;
  if (expectedRoleRecordId !== undefined) {
    if (latestRoleRecords.some(record => record.recordId === expectedRoleRecordId)) {
      return expectedRoleRecordId;
    }
    if (latestRoleRecords.length > 0) {
      throw roleRecordNotFound(resolvedRole);
    }
  } else if (latestRoleRecords[0] !== undefined) {
    return latestRoleRecords[0].recordId;
  }

  // A locally replicated ancestry-only copy can establish membership without
  // exposing a latest-state role record. Preserve that existing behavior.
  const matchingRoleRecordExists = await validationStateReader.hasMatchingRoleRecord(selector);

  if (!matchingRoleRecordExists) {
    throw roleRecordNotFound(resolvedRole);
  }

  return expectedRoleRecordId;
}

function roleRecordNotFound(resolvedRole: ResolvedModuleRole): DwnError {
  return new DwnError(
    DwnErrorCode.ModuleAuthorizationMatchingRoleRecordNotFound,
    `No matching role record found for module path ${resolvedRole.modulePath}`,
  );
}

/**
 * Returns the actions that can authorize the operation, before matching its current rules.
 * Initial writes require create or squash permission. Updates by the original author
 * can use update or co-update; another author needs co-update. Creation permission
 * does not imply that an author still has permission when a later update arrives.
 */
export async function getActionsSeekingARuleMatch(
  tenant: string,
  incomingMessage: ModuleAuthorizableMessage,
  validationStateReader: ValidationStateReader,
  actionRules?: ModuleActionRule[],
): Promise<ModuleAction[]> {

  switch (incomingMessage.message.descriptor.method) {
  case DwnMethodName.Delete:
    return getDeleteActionsSeekingARuleMatch(tenant, incomingMessage, validationStateReader);

  case DwnMethodName.Count:
    return [ModuleAction.Read];

  case DwnMethodName.Query:
    return [ModuleAction.Read];

  case DwnMethodName.Read:
    return [ModuleAction.Read];

  case DwnMethodName.Subscribe:
    return [ModuleAction.Read];

  case DwnMethodName.Write:
    return getWriteActionsSeekingARuleMatch(tenant, incomingMessage, validationStateReader, actionRules);
  }

  // purely defensive programming: should not be reachable
  // setting to empty array will prevent any message from being authorized
  return [];
}

/**
 * Handles the `RecordsDelete` case of `getActionsSeekingARuleMatch()`.
 */
async function getDeleteActionsSeekingARuleMatch(
  tenant: string,
  incomingMessage: ModuleAuthorizableMessage,
  validationStateReader: ValidationStateReader,
): Promise<ModuleAction[]> {
  const recordsDelete = incomingMessage as RecordsDelete;
  const recordId = recordsDelete.message.descriptor.recordId;
  const initialWrite = await validationStateReader.fetchInitialRecordsWrite(tenant, recordId);

  // if there is no initial write, then no action rule can authorize the incoming message, because we won't know who the original author is
  // NOTE: purely defensive programming: currently not reachable
  // because RecordsDelete handler already have an existence check prior to this method being called.
  if (initialWrite === undefined) {
    return [];
  }

  const actionsThatWouldAuthorizeDelete: ModuleAction[] = [];
  const prune = recordsDelete.message.descriptor.prune;
  if (prune) {
    actionsThatWouldAuthorizeDelete.push(ModuleAction.CoPrune);

    // A prune by the original record author can also be authorized by a 'prune' rule.
    if (incomingMessage.author === initialWrite.author) {
      actionsThatWouldAuthorizeDelete.push(ModuleAction.Prune);
    }
  } else {
    actionsThatWouldAuthorizeDelete.push(ModuleAction.CoDelete);

    // A delete by the original record author can also be authorized by a 'delete' rule.
    if (incomingMessage.author === initialWrite.author) {
      actionsThatWouldAuthorizeDelete.push(ModuleAction.Delete);
    }
  }

  return actionsThatWouldAuthorizeDelete;
}

/**
 * Handles the `RecordsWrite` case of `getActionsSeekingARuleMatch()`.
 */
async function getWriteActionsSeekingARuleMatch(
  tenant: string,
  incomingMessage: ModuleAuthorizableMessage,
  validationStateReader: ValidationStateReader,
  actionRules?: ModuleActionRule[],
): Promise<ModuleAction[]> {
  const incomingRecordsWrite = incomingMessage as RecordsWrite;

  if (await incomingRecordsWrite.isInitialWrite()) {
    if (actionRules === undefined) {
      throw new DwnError(
        DwnErrorCode.ModuleAuthorizationActionRulesNotFound,
        'action rules are required when determining authorization actions for an initial RecordsWrite'
      );
    }
    return getInitialWriteActionsSeekingARuleMatch(incomingRecordsWrite, actionRules);
  } else {
    // else incoming RecordsWrite not an initial write

    const recordId = (incomingMessage as RecordsWrite).message.recordId;
    const initialWrite = await validationStateReader.fetchInitialRecordsWrite(tenant, recordId);

    // if there is no initial write to update from, then no action rule can authorize the incoming message
    if (initialWrite === undefined) {
      return [];
    }

    if (incomingMessage.author === initialWrite.author) {
    // 'update' or 'co-update' action authorizes the incoming message
      return [ModuleAction.CoUpdate, ModuleAction.Update];
    } else {
      // An update by someone who is not the record author can only be authorized by a 'co-update' rule.
      return [ModuleAction.CoUpdate];
    }
  }
}

/**
 * Returns the actions that can authorize an initial write. An explicit `squash`
 * rule makes squash authorization exclusive; `create` remains a compatibility
 * fallback only when the rule set has no explicit squash action.
 */
export function getInitialWriteActionsSeekingARuleMatch(
  incomingRecordsWrite: RecordsWrite,
  actionRules: ModuleActionRule[],
): ModuleAction[] {
  if (incomingRecordsWrite.message.descriptor.squash !== true) {
    return [ModuleAction.Create];
  }

  const hasExplicitSquashRule = actionRules.some(
    (actionRule: ModuleActionRule): boolean => actionRule.can.includes(ModuleAction.Squash)
  );

  return hasExplicitSquashRule
    ? [ModuleAction.Squash]
    : [ModuleAction.Squash, ModuleAction.Create];
}

/**
 * Verifies the given message is authorized by one of the action rules in the given module rule set.
 * @param node The resolved local node and its canonical role and actor bindings.
 * @throws {Error} if action not allowed.
 */
export async function authorizeAgainstAllowedActions(
  tenant: string,
  incomingMessage: ModuleAuthorizableMessage,
  node: ResolvedModuleNode,
  recordChain: RecordsWriteMessage[],
  validationStateReader: ValidationStateReader,
  invokedRole?: ResolvedModuleRole,
): Promise<void> {
  const incomingMessageMethod = incomingMessage.message.descriptor.method;
  const author = incomingMessage.author;
  const actionRules = node.declaredRuleSet.$actions;

  // NOTE: We have already checked that the message is not from tenant, owner, or permission grant authorized prior to this method being called.

  if (actionRules === undefined) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationActionRulesNotFound,
      `no action rule defined for Records${incomingMessageMethod}, ${author} is unauthorized`
    );
  }

  const actionsSeekingARuleMatch = await getActionsSeekingARuleMatch(
    tenant, incomingMessage, validationStateReader, actionRules
  );

  // Iterate through the action rules to find a rule that authorizes the incoming message.
  for (const action of node.actions) {
    const actionRuleAuthorizes = await actionRuleAuthorizesMessage(
      action, actionsSeekingARuleMatch, author, invokedRole, incomingMessage, recordChain
    );
    if (actionRuleAuthorizes) {
      return;
    }
  }

  // No action rules were satisfied, message is not authorized
  throw new DwnError(
    DwnErrorCode.ModuleAuthorizationActionNotAllowed,
    `Inbound message action Records${incomingMessageMethod} by author ${incomingMessage.author} not allowed.`
  );
}

/**
 * Evaluates whether a single action rule authorizes the incoming message, mirroring the
 * original per-rule evaluation performed inline in the `authorizeAgainstAllowedActions()` loop.
 * Returns `true` when the rule authorizes the message (the caller should stop and authorize);
 * `false` when the rule does not match and the caller should move on to the next rule.
 */
async function actionRuleAuthorizesMessage(
  action: ResolvedModuleAction,
  actionsSeekingARuleMatch: ModuleAction[],
  author: string | undefined,
  invokedRole: ResolvedModuleRole | undefined,
  incomingMessage: ModuleAuthorizableMessage,
  recordChain: RecordsWriteMessage[],
): Promise<boolean> {
  const actionRule = action.rule;
  // If the action rule does not have an allowed action that matches an action that can authorize the message, skip to evaluate next action rule.
  const ruleHasAMatchingAllowedAction = actionRule.can.some(
    (allowedAction: string): boolean => actionsSeekingARuleMatch.includes(allowedAction as ModuleAction)
  );
  if (!ruleHasAMatchingAllowedAction) {
    return false;
  }

  // If the action rule allows `anyone`, then no further checks are needed.
  if (actionRule.who === ModuleActor.Anyone) {
    return true;
  }

  // Since not `anyone` is allowed in this action rule, we will need to check the author of the incoming message,
  // if the author of incoming message is not defined, this action rule cannot authorize the incoming message.
  if (author === undefined) {
    return false;
  }

  // go through role validation path if a role is invoked by the incoming message
  if (invokedRole !== undefined) {
    // When a module role is being invoked, we require that there is a matching `role` rule.
    return action.resolvedRole?.owningModuleUri === invokedRole.module &&
      action.resolvedRole.owningModulePath === invokedRole.modulePath;
  }

  // Configuration validation permits a recipient without `of` only for co-update,
  // co-delete, and co-prune. Those actions concern this record's recipient.
  if (actionRule.who === ModuleActor.Recipient && actionRule.of === undefined) {
    let recordsWriteMessage: RecordsWriteMessage;
    if (incomingMessage.message.descriptor.method === DwnMethodName.Write) {
      recordsWriteMessage = incomingMessage.message as RecordsWriteMessage;
    } else {
      // Deletes and prunes use the last write in the record's ancestor chain.
      recordsWriteMessage = recordChain.at(-1)!;
    }

    return recordsWriteMessage.descriptor.recipient === author;
  }

  // validate the actor is allowed by the current action rule
  return checkActor(author, action, recordChain);
}

/**
 * Checks if the `who: 'author' | 'recipient'` action rule has a matching record in the record chain.
 * For cross-module `of` references (e.g., `"threads:thread"`), matches against both the module URI
 * and the module path of the ancestor record.
 * @returns `true` if the action rule is satisfied; `false` otherwise.
 */
export async function checkActor(
  author: string,
  action: ResolvedModuleAction,
  recordChain: RecordsWriteMessage[],
): Promise<boolean> {
  const target = action.resolvedActor;
  if (target === undefined) {
    return false;
  }
  const ancestor = recordChain.find(message =>
    message.descriptor.module === target.owningModuleUri && message.descriptor.modulePath === target.owningModulePath
  );
  if (ancestor === undefined) {
    return false;
  }
  if (target.who === ModuleActor.Recipient) {
    return author === ancestor.descriptor.recipient;
  }
  return author === (await RecordsWrite.parse(ancestor)).author;
}
