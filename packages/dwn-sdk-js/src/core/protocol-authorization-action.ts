import type { RecordsCount } from '../interfaces/records-count.js';
import type { RecordsDelete } from '../interfaces/records-delete.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsRead } from '../interfaces/records-read.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';
import type { ValidationMode, ValidationStateReader } from '../types/validation-state-reader.js';

import { DwnMethodName } from '../enums/dwn-interface-method.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { getRuleSetAtPath, isCrossProtocolRef, parseCrossProtocolRef } from '../utils/protocols.js';
import { ProtocolAction, ProtocolActor } from '../types/protocols-types.js';

/**
 * Check if the incoming message is invoking a role. If so, validate the invoked role.
 * For cross-protocol role invocation, the role record may live in a different protocol
 * (resolved via the composing protocol's `uses` map).
 */
export async function verifyInvokedRole(
  tenant: string,
  incomingMessage: RecordsCount | RecordsDelete | RecordsQuery | RecordsRead | RecordsSubscribe | RecordsWrite,
  protocolUri: string,
  contextId: string | undefined,
  protocolDefinition: ProtocolDefinition,
  validationStateReader: ValidationStateReader,
  validationMode: ValidationMode,
  governingTimestamp?: string,
): Promise<void> {
  const protocolRole = incomingMessage.signaturePayload?.protocolRole;

  // Only verify role if there is a role being invoked
  if (protocolRole === undefined) {
    return;
  }

  // Determine the protocol URI and protocol path for the role record.
  // For cross-protocol roles (e.g., "threads:thread/participant"), resolve the alias.
  let roleProtocolUri = protocolUri;
  let roleProtocolPath = protocolRole;

  if (isCrossProtocolRef(protocolRole)) {
    const parsed = parseCrossProtocolRef(protocolRole);
    if (parsed === undefined) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationNotARole,
        `Cross-protocol role '${protocolRole}' could not be parsed as a valid 'alias:path' format.`
      );
    }

    if (protocolDefinition.uses?.[parsed.alias] === undefined) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationNotARole,
        `Cross-protocol role alias '${parsed.alias}' in '${protocolRole}' does not exist in the protocol's 'uses' map.`
      );
    }

    roleProtocolUri = protocolDefinition.uses[parsed.alias];
    roleProtocolPath = parsed.protocolPath;

    // Fetch the referenced protocol's definition to validate the role exists
    const refDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant, roleProtocolUri, governingTimestamp
    );
    const roleRuleSet = getRuleSetAtPath(roleProtocolPath, refDefinition.structure);
    if (!roleRuleSet?.$role) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationNotARole,
        `Cross-protocol role path ${protocolRole} does not match role record type.`
      );
    }
  } else {
    // Local role: validate in the composing protocol's definition
    const roleRuleSet = getRuleSetAtPath(protocolRole, protocolDefinition.structure);
    if (!roleRuleSet?.$role) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationNotARole,
        `Protocol path ${protocolRole} does not match role record type.`
      );
    }
  }

  const ancestorSegmentCountOfRolePath = roleProtocolPath.split('/').length - 1;
  if (contextId === undefined && ancestorSegmentCountOfRolePath > 0) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationMissingContextId,
      'Could not verify role because contextId is missing.'
    );
  }

  // Compute `contextId` prefix for fetching the invoked role record if the role path is not at the root level.
  // e.g. if invoked role path is `Thread/Participant`, and the `contextId` of the message is `threadX/messageY/attachmentZ`,
  // then we need to use the prefix `threadX` for the `contextId`
  // because the `contextId` of the Participant record would be in the form of be `threadX/participantA`
  let contextIdPrefix: string | undefined;
  if (ancestorSegmentCountOfRolePath > 0) {
    const contextIdSegments = contextId!.split('/'); // NOTE: currently contextId segment count is never shorter than the role path count.
    contextIdPrefix = contextIdSegments.slice(0, ancestorSegmentCountOfRolePath).join('/');
  }

  // fetch the invoked role record (read-set row 4 — the reader applies the replicated-mode fallback)
  const matchingRoleRecordExists = await validationStateReader.hasMatchingRoleRecord({
    tenant,
    protocol     : roleProtocolUri,
    protocolPath : roleProtocolPath,
    recipient    : incomingMessage.author!,
    contextIdPrefix,
    validationMode,
  });

  if (!matchingRoleRecordExists) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound,
      `No matching role record found for protocol path ${roleProtocolPath}`
    );
  }
}

/**
 * Returns all the ProtocolActions that would authorized the incoming message
 * (but we still need to later verify if there is a rule defined that matches one of the actions).
 * NOTE: the reason why there could be multiple actions is because:
 * - In case of an initial RecordsWrite, the RecordsWrite can be authorized by an allow `create` or `write` rule.
 * - In case of a non-initial RecordsWrite by the original record author, the RecordsWrite can be authorized by a `write` or `co-update` rule.
 *
 * It is important to recognize that the `write` access that allowed the original record author to create the record maybe revoked
 * (e.g. by role revocation) by the time a "non-initial" write by the same author is attempted.
 */
export async function getActionsSeekingARuleMatch(
  tenant: string,
  incomingMessage: RecordsCount | RecordsDelete | RecordsQuery | RecordsRead | RecordsSubscribe | RecordsWrite,
  validationStateReader: ValidationStateReader,
): Promise<ProtocolAction[]> {

  switch (incomingMessage.message.descriptor.method) {
  case DwnMethodName.Delete: {
    const recordsDelete = incomingMessage as RecordsDelete;
    const recordId = recordsDelete.message.descriptor.recordId;
    const initialWrite = await validationStateReader.fetchInitialRecordsWrite(tenant, recordId);

    // if there is no initial write, then no action rule can authorize the incoming message, because we won't know who the original author is
    // NOTE: purely defensive programming: currently not reachable
    // because RecordsDelete handler already have an existence check prior to this method being called.
    if (initialWrite === undefined) {
      return [];
    }

    const actionsThatWouldAuthorizeDelete: ProtocolAction[] = [];
    const prune = recordsDelete.message.descriptor.prune;
    if (prune) {
      actionsThatWouldAuthorizeDelete.push(ProtocolAction.CoPrune);

      // A prune by the original record author can also be authorized by a 'prune' rule.
      if (incomingMessage.author === initialWrite.author) {
        actionsThatWouldAuthorizeDelete.push(ProtocolAction.Prune);
      }
    } else {
      actionsThatWouldAuthorizeDelete.push(ProtocolAction.CoDelete);

      // A delete by the original record author can also be authorized by a 'delete' rule.
      if (incomingMessage.author === initialWrite.author) {
        actionsThatWouldAuthorizeDelete.push(ProtocolAction.Delete);
      }
    }

    return actionsThatWouldAuthorizeDelete;
  }

  case DwnMethodName.Count:
    return [ProtocolAction.Read];

  case DwnMethodName.Query:
    return [ProtocolAction.Read];

  case DwnMethodName.Read:
    return [ProtocolAction.Read];

  case DwnMethodName.Subscribe:
    return [ProtocolAction.Read];

  case DwnMethodName.Write: {
    const incomingRecordsWrite = incomingMessage as RecordsWrite;

    if (await incomingRecordsWrite.isInitialWrite()) {
      // A squash write seeks the `squash` action first, with fallback to `create`.
      // This means any DID authorized to `create` can also squash when no explicit `squash` rule exists.
      if (incomingRecordsWrite.message.descriptor.squash === true) {
        return [ProtocolAction.Squash, ProtocolAction.Create];
      }
      return [ProtocolAction.Create];
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
        return [ProtocolAction.CoUpdate, ProtocolAction.Update];
      } else {
        // An update by someone who is not the record author can only be authorized by a 'co-update' rule.
        return [ProtocolAction.CoUpdate];
      }
    }
  }
  }

  // purely defensive programming: should not be reachable
  // setting to empty array will prevent any message from being authorized
  return [];
}

/**
 * Verifies the given message is authorized by one of the action rules in the given protocol rule set.
 * @param protocolDefinition Optional protocol definition for resolving cross-protocol `of` and `role` references.
 * @throws {Error} if action not allowed.
 */
export async function authorizeAgainstAllowedActions(
  tenant: string,
  incomingMessage: RecordsCount | RecordsDelete | RecordsQuery | RecordsRead | RecordsSubscribe | RecordsWrite,
  ruleSet: ProtocolRuleSet,
  recordChain: RecordsWriteMessage[],
  validationStateReader: ValidationStateReader,
  protocolDefinition?: ProtocolDefinition,
): Promise<void> {
  const incomingMessageMethod = incomingMessage.message.descriptor.method;
  const actionsSeekingARuleMatch = await getActionsSeekingARuleMatch(tenant, incomingMessage, validationStateReader);
  const author = incomingMessage.author;
  const actionRules = ruleSet.$actions;

  // NOTE: We have already checked that the message is not from tenant, owner, or permission grant authorized prior to this method being called.

  if (actionRules === undefined) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationActionRulesNotFound,
      `no action rule defined for Records${incomingMessageMethod}, ${author} is unauthorized`
    );
  }

  const invokedRole = incomingMessage.signaturePayload?.protocolRole;

  // Iterate through the action rules to find a rule that authorizes the incoming message.
  for (const actionRule of actionRules) {
    // If the action rule does not have an allowed action that matches an action that can authorize the message, skip to evaluate next action rule.
    const ruleHasAMatchingAllowedAction = actionRule.can.some(
      (allowedAction: string): boolean => actionsSeekingARuleMatch.includes(allowedAction as ProtocolAction)
    );
    if (!ruleHasAMatchingAllowedAction) {
      continue;
    }

    // Code reaches here means this action rule has an allowed action that matches the action of the message.
    // The remaining code checks the actor/author of the incoming message.

    // If the action rule allows `anyone`, then no further checks are needed.
    if (actionRule.who === ProtocolActor.Anyone) {
      return;
    }

    // Since not `anyone` is allowed in this action rule, we will need to check the author of the incoming message,
    // if the author of incoming message is not defined, this action rule cannot authorize the incoming message.
    if (author === undefined) {
      continue;
    }

    // go through role validation path if a role is invoked by the incoming message
    if (invokedRole !== undefined) {
      // When a protocol role is being invoked, we require that there is a matching `role` rule.
      if (actionRule.role === invokedRole) {
        // role is successfully invoked
        return;
      } else {
        continue;
      }
    }

    // else we go through the actor (`who`) validation

    // If `of` is not set, handle it as a special case
    // NOTE: `of` is always set if `who` is set to `author` (we do this check in `validateRuleSetRecursively()`)
    if (actionRule.who === ProtocolActor.Recipient && actionRule.of === undefined) {
      // If the action rule specifies a recipient without `of` and the incoming message is authenticated:

      // Author must be recipient of the record being accessed
      let recordsWriteMessage: RecordsWriteMessage;
      if (incomingMessage.message.descriptor.method === DwnMethodName.Write) {
        recordsWriteMessage = incomingMessage.message as RecordsWriteMessage;
      } else {
        // else the incoming message must be a `RecordsDelete` because only `co-update`, `co-delete`, `co-prune` are allowed recipient actions,
        // (we do this check in `validateRuleSetRecursively()`)
        // and we have already checked that the incoming message is not a `RecordsWrite` above which covers `co-update` path.
        recordsWriteMessage = recordChain[recordChain.length - 1];
      }

      if (recordsWriteMessage.descriptor.recipient === author) {
        return;
      } else {
        continue;
      }
    }

    // validate the actor is allowed by the current action rule
    const ancestorRuleSuccess: boolean = await checkActor(author, actionRule, recordChain, protocolDefinition);
    if (ancestorRuleSuccess) {
      return;
    }
  }

  // No action rules were satisfied, message is not authorized
  throw new DwnError(
    DwnErrorCode.ProtocolAuthorizationActionNotAllowed,
    `Inbound message action Records${incomingMessageMethod} by author ${incomingMessage.author} not allowed.`
  );
}

/**
 * Checks if the `who: 'author' | 'recipient'` action rule has a matching record in the record chain.
 * For cross-protocol `of` references (e.g., `"threads:thread"`), matches against both the protocol URI
 * and the protocol path of the ancestor record.
 * @returns `true` if the action rule is satisfied; `false` otherwise.
 */
export async function checkActor(
  author: string,
  actionRule: ProtocolActionRule,
  recordChain: RecordsWriteMessage[],
  composingDefinition?: ProtocolDefinition,
): Promise<boolean> {
  const ofValue = actionRule.of;

  // `of` should always be defined when `checkActor` is called, but guard defensively
  if (ofValue === undefined) {
    return false;
  }

  let ancestorRecordsWrite: RecordsWriteMessage | undefined;

  if (isCrossProtocolRef(ofValue) && composingDefinition?.uses !== undefined) {
    // Cross-protocol `of`: resolve alias to protocol URI and match by both protocol + protocolPath
    const parsed = parseCrossProtocolRef(ofValue);
    if (parsed !== undefined) {
      const refProtocolUri = composingDefinition.uses[parsed.alias];
      if (refProtocolUri !== undefined) {
        ancestorRecordsWrite = recordChain.find((msg: RecordsWriteMessage): boolean =>
          msg.descriptor.protocol === refProtocolUri && msg.descriptor.protocolPath === parsed.protocolPath
        );
      }
    }
  } else {
    // Local `of`: match by protocolPath only (same protocol assumed)
    ancestorRecordsWrite = recordChain.find((msg: RecordsWriteMessage): boolean =>
      msg.descriptor.protocolPath === ofValue
    );
  }

  if (ancestorRecordsWrite === undefined) {
    // No matching ancestor found in the record chain. Return false to allow the caller
    // to continue evaluating other action rules that might authorize the request.
    return false;
  }

  if (actionRule.who === ProtocolActor.Recipient) {
    // author of the incoming message must be the recipient of the ancestor message
    return author === ancestorRecordsWrite.descriptor.recipient;
  } else { // actionRule.who === ProtocolActor.Author
    // author of the incoming message must be the author of the ancestor message
    const ancestorAuthor = (await RecordsWrite.parse(ancestorRecordsWrite)).author;
    return author === ancestorAuthor;
  }
}
