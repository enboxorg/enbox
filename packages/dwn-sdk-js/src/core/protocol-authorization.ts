import type { RecordsCount } from '../interfaces/records-count.js';
import type { RecordsDelete } from '../interfaces/records-delete.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsRead } from '../interfaces/records-read.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { getRuleSetAtPath } from '../utils/protocols.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { ProtocolAction, ProtocolActor } from '../types/protocols-types.js';

import { authorizeAgainstAllowedActions, verifyInvokedRole } from './protocol-authorization-action.js';
import {
  verifyAsRoleRecordIfNeeded,
  verifyImmutability,
  verifyProtocolPathAndContextId,
  verifyRecordLimit,
  verifySizeLimit,
  verifySquashEligibility,
  verifyTagsIfNeeded,
  verifyTypeWithComposition,
} from './protocol-authorization-validation.js';

export class ProtocolAuthorization {

  /**
   * Performs validation on the structure of RecordsWrite messages that use a protocol.
   * @throws {Error} if validation fails.
   */
  public static async validateReferentialIntegrity(
    tenant: string,
    incomingMessage: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    const protocolDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the protocol definition active at the incoming message timestamp
    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      incomingMessage.message.descriptor.protocol,
      protocolDefinitionTimestamp,
    );

    // verify declared protocol type exists in protocol and that it conforms to type specification.
    // For cross-protocol composition, the type may be defined in a referenced protocol.
    await verifyTypeWithComposition(
      tenant, incomingMessage.message, protocolDefinition, validationStateReader, protocolDefinitionTimestamp
    );

    // validate `protocolPath`
    await verifyProtocolPathAndContextId(
      tenant, incomingMessage, validationStateReader, protocolDefinitionTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      incomingMessage.message.descriptor.protocolPath,
      protocolDefinition,
    );

    // Validate as a role record if the incoming message is writing a role record
    await verifyAsRoleRecordIfNeeded(
      tenant,
      incomingMessage,
      ruleSet,
      validationStateReader,
    );

    // Verify size limit
    verifySizeLimit(incomingMessage, ruleSet);

    // Verify protocol tags
    verifyTagsIfNeeded(incomingMessage, ruleSet);

    // Verify immutability — reject updates to write-once records
    await verifyImmutability(incomingMessage, ruleSet);

    // Verify squash eligibility — ensure squash writes are at $squash: true paths and are initial writes
    await verifySquashEligibility(incomingMessage, ruleSet);

    // Verify record count limit
    await verifyRecordLimit(tenant, incomingMessage, ruleSet, validationStateReader);
  }

  /**
   * Revalidates a stored initial write against the protocol definition that governed its creation timestamp.
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
    await ProtocolAuthorization.verifyStoredInitialWrite(incomingMessage);

    const protocolDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;
    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      incomingMessage.message.descriptor.protocol,
      protocolDefinitionTimestamp,
    );

    await verifyTypeWithComposition(
      tenant, incomingMessage.message, protocolDefinition, validationStateReader, protocolDefinitionTimestamp
    );

    const ruleSet = ProtocolAuthorization.getRuleSet(
      incomingMessage.message.descriptor.protocolPath,
      protocolDefinition,
    );

    ProtocolAuthorization.verifyStoredInitialWriteRoleRecipientIfNeeded(incomingMessage, ruleSet);
    verifySizeLimit(incomingMessage, ruleSet);
    verifyTagsIfNeeded(incomingMessage, ruleSet);
    await verifySquashEligibility(incomingMessage, ruleSet);
    ProtocolAuthorization.verifyStoredInitialWriteCreateAction(tenant, incomingMessage, ruleSet);

    // `verifyRecordLimit()` is not replayed here. It is stateful and counts the present
    // latest live set, which would incorrectly reject the record being revalidated.
    // Inbound writes continue to enforce record limits at admission time.
  }

  /**
   * Performs protocol-based authorization against the incoming RecordsWrite message.
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

    const protocolDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the protocol definition active at the incoming message timestamp
    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      incomingMessage.message.descriptor.protocol,
      protocolDefinitionTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      incomingMessage.message.descriptor.protocolPath,
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      incomingMessage.message.descriptor.protocol,
      incomingMessage.message.contextId,
      protocolDefinition,
      validationStateReader,
      protocolDefinitionTimestamp,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      recordChain,
      validationStateReader,
      protocolDefinition,
    );
  }

  /**
   * Performs protocol-based authorization against the incoming `RecordsRead` message.
   * @param newestRecordsWrite The latest RecordsWrite associated with the recordId being read.
   * @throws {Error} if authorization fails.
   */
  public static async authorizeRead(
    tenant: string,
    incomingMessage: RecordsRead,
    newestRecordsWrite: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    // fetch record chain
    const recordChain: RecordsWriteMessage[] =
      await validationStateReader.constructRecordChain(tenant, newestRecordsWrite.message.recordId);

    const protocolDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the protocol definition active at the incoming message timestamp
    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      newestRecordsWrite.message.descriptor.protocol,
      protocolDefinitionTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      newestRecordsWrite.message.descriptor.protocolPath,
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      newestRecordsWrite.message.descriptor.protocol,
      newestRecordsWrite.message.contextId,
      protocolDefinition,
      validationStateReader,
      protocolDefinitionTimestamp,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      recordChain,
      validationStateReader,
      protocolDefinition,
    );
  }

  public static async authorizeQueryOrSubscribe(
    tenant: string,
    incomingMessage: RecordsCount | RecordsQuery | RecordsSubscribe,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    const { protocol, protocolPath, contextId } = incomingMessage.message.descriptor.filter;

    // fetch the protocol definition
    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      protocol!, // `authorizeQueryOrSubscribe` is only called if `protocol` is present
      incomingMessage.message.descriptor.messageTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      protocolPath!, // presence of `protocolPath` is verified in `parse()`
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      protocol!,
      contextId,
      protocolDefinition,
      validationStateReader,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      [], // record chain is not relevant to queries or subscriptions
      validationStateReader,
      protocolDefinition,
    );
  }

  /**
   * Performs protocol-based authorization against the incoming `RecordsDelete` message.
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

    const protocolDefinitionTimestamp = incomingMessage.message.descriptor.messageTimestamp;

    // fetch the protocol definition active at the incoming message timestamp
    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      recordsWrite.message.descriptor.protocol,
      protocolDefinitionTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      recordsWrite.message.descriptor.protocolPath,
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      recordsWrite.message.descriptor.protocol,
      recordsWrite.message.contextId,
      protocolDefinition,
      validationStateReader,
      protocolDefinitionTimestamp,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      recordChain,
      validationStateReader,
      protocolDefinition,
    );
  }

  /**
   * Gets the rule set corresponding to the given protocolPath.
   */
  private static getRuleSet(
    protocolPath: string,
    protocolDefinition: ProtocolDefinition,
  ): ProtocolRuleSet {
    const ruleSet = getRuleSetAtPath(protocolPath, protocolDefinition.structure);
    if (ruleSet === undefined) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationMissingRuleSet,
        `No rule set defined for protocolPath ${protocolPath}`);
    }
    return ruleSet;
  }

  private static async verifyStoredInitialWrite(incomingMessage: RecordsWrite): Promise<void> {
    if (await incomingMessage.isInitialWrite()) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationInitialWriteRevalidationNotInitial,
      'stored write revalidation only supports initial RecordsWrite messages'
    );
  }

  private static verifyStoredInitialWriteRoleRecipientIfNeeded(
    incomingMessage: RecordsWrite,
    ruleSet: ProtocolRuleSet,
  ): void {
    if (ruleSet.$role !== true || incomingMessage.message.descriptor.recipient !== undefined) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationStoredInitialWriteRoleMissingRecipient,
      'role records must have a recipient'
    );
  }

  private static verifyStoredInitialWriteCreateAction(
    tenant: string,
    incomingMessage: RecordsWrite,
    ruleSet: ProtocolRuleSet,
  ): void {
    if (ProtocolAuthorization.isStoredInitialWriteDirectlyAuthorized(tenant, incomingMessage)) {
      return;
    }

    const actions = incomingMessage.message.descriptor.squash === true
      ? [ProtocolAction.Squash, ProtocolAction.Create]
      : [ProtocolAction.Create];
    const actionRules = ruleSet.$actions;
    if (actionRules === undefined) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationStoredInitialWriteActionRulesNotFound,
        `no create action rule defined for stored RecordsWrite by author ${incomingMessage.author}`
      );
    }

    const invokedRole = incomingMessage.signaturePayload?.protocolRole;
    for (const actionRule of actionRules) {
      if (!actionRule.can.some((allowedAction: string): boolean => actions.includes(allowedAction as ProtocolAction))) {
        continue;
      }

      if (invokedRole !== undefined) {
        if (actionRule.role === invokedRole) {
          return;
        }
        continue;
      }

      if (actionRule.who === ProtocolActor.Anyone) {
        return;
      }

      // Author/recipient-of rules depend on the parent chain. This repair path preserves
      // instead of hard-purging when validity depends on mutable or missing dependency records.
      if (actionRule.who === ProtocolActor.Author || actionRule.who === ProtocolActor.Recipient) {
        return;
      }
    }

    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationStoredInitialWriteActionNotAllowed,
      `stored RecordsWrite by author ${incomingMessage.author} is not allowed by the resolved protocol config`
    );
  }

  private static isStoredInitialWriteDirectlyAuthorized(tenant: string, incomingMessage: RecordsWrite): boolean {
    return incomingMessage.owner !== undefined ||
      incomingMessage.author === tenant ||
      incomingMessage.isSignedByAuthorDelegate ||
      incomingMessage.isSignedByOwnerDelegate ||
      incomingMessage.signaturePayload?.permissionGrantId !== undefined;
  }

}
