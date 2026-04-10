import type { CoreProtocolRegistry } from './core-protocol.js';
import type { Filter } from '../types/query-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { RecordsCount } from '../interfaces/records-count.js';
import type { RecordsDelete } from '../interfaces/records-delete.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsRead } from '../interfaces/records-read.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage } from '../types/protocols-types.js';

import { getRuleSetAtPath } from '../utils/protocols.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

import { authorizeAgainstAllowedActions, verifyInvokedRole } from './protocol-authorization-action.js';
import { constructRecordChain, fetchInitialWrite, getGoverningTimestamp } from './record-chain.js';
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

/**
 * Function signature for fetching a protocol definition.
 * Used by extracted modules to break the circular dependency on `ProtocolAuthorization`.
 */
export type FetchProtocolDefinitionFn = (
  tenant: string,
  protocolUri: string,
  messageStore: MessageStore,
  messageTimestamp?: string,
) => Promise<ProtocolDefinition>;

export class ProtocolAuthorization {

  /**
   * Performs validation on the structure of RecordsWrite messages that use a protocol.
   * @throws {Error} if validation fails.
   */
  public static async validateReferentialIntegrity(
    tenant: string,
    incomingMessage: RecordsWrite,
    messageStore: MessageStore,
    coreProtocols?: CoreProtocolRegistry,
  ): Promise<void> {
    // Determine the governing timestamp for protocol definition lookup.
    // For an initial write, this is the message's own timestamp.
    // For an update, this is the initial write's timestamp (the protocol version is locked at creation time).
    const governingTimestamp = await getGoverningTimestamp(
      tenant, incomingMessage, messageStore
    );

    // fetch the protocol definition that was active at the governing timestamp
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      incomingMessage.message.descriptor.protocol,
      messageStore,
      governingTimestamp,
      coreProtocols,
    );

    // Create a bound fetch function that captures the registry for downstream callbacks.
    const boundFetchDefinition = ProtocolAuthorization.createBoundFetchDefinition(coreProtocols);

    // verify declared protocol type exists in protocol and that it conforms to type specification.
    // For cross-protocol composition, the type may be defined in a referenced protocol.
    await verifyTypeWithComposition(
      tenant, incomingMessage.message, protocolDefinition, messageStore,
      boundFetchDefinition, governingTimestamp
    );

    // validate `protocolPath`
    await verifyProtocolPathAndContextId(
      tenant, incomingMessage, messageStore,
      boundFetchDefinition, governingTimestamp,
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
      messageStore,
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
    await verifyRecordLimit(tenant, incomingMessage, ruleSet, messageStore);
  }

  /**
   * Performs protocol-based authorization against the incoming RecordsWrite message.
   * @throws {Error} if authorization fails.
   */
  public static async authorizeWrite(
    tenant: string,
    incomingMessage: RecordsWrite,
    messageStore: MessageStore,
    coreProtocols?: CoreProtocolRegistry,
  ): Promise<void> {
    const existingInitialWrite = await fetchInitialWrite(tenant, incomingMessage.message.recordId, messageStore);

    let recordChain;
    if (existingInitialWrite === undefined) {
      // NOTE: we can assume this message is an initial write because an existing initial write does not exist.
      // Additionally, we check further down in the `RecordsWriteHandler` if the incoming message is an initialWrite,
      // so we don't check explicitly here to avoid an unnecessary duplicate check.
      recordChain = await constructRecordChain(tenant, incomingMessage.message.descriptor.parentId, messageStore);
    } else {
      recordChain = await constructRecordChain(tenant, incomingMessage.message.recordId, messageStore);
    }

    // Determine the governing timestamp for protocol definition lookup.
    const governingTimestamp = await getGoverningTimestamp(
      tenant, incomingMessage, messageStore
    );

    // fetch the protocol definition that was active at the governing timestamp
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      incomingMessage.message.descriptor.protocol,
      messageStore,
      governingTimestamp,
      coreProtocols,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      incomingMessage.message.descriptor.protocolPath,
      protocolDefinition,
    );

    const boundFetchDefinition = ProtocolAuthorization.createBoundFetchDefinition(coreProtocols);

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      incomingMessage.message.descriptor.protocol,
      incomingMessage.message.contextId,
      protocolDefinition,
      messageStore,
      boundFetchDefinition,
      governingTimestamp,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      recordChain,
      messageStore,
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
    messageStore: MessageStore,
    coreProtocols?: CoreProtocolRegistry,
  ): Promise<void> {
    // fetch record chain
    const recordChain: RecordsWriteMessage[] =
      await constructRecordChain(tenant, newestRecordsWrite.message.recordId, messageStore);

    // Use the initial write's timestamp to determine the governing protocol definition.
    // The protocol version is locked at the time the record was first created.
    const initialWrite = await fetchInitialWrite(
      tenant, newestRecordsWrite.message.recordId, messageStore
    );
    const governingTimestamp = initialWrite === undefined
      ? newestRecordsWrite.message.descriptor.messageTimestamp
      : initialWrite.descriptor.messageTimestamp;

    // fetch the protocol definition that was active when the record was created
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      newestRecordsWrite.message.descriptor.protocol,
      messageStore,
      governingTimestamp,
      coreProtocols,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      newestRecordsWrite.message.descriptor.protocolPath,
      protocolDefinition,
    );

    const boundFetchDefinition = ProtocolAuthorization.createBoundFetchDefinition(coreProtocols);

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      newestRecordsWrite.message.descriptor.protocol,
      newestRecordsWrite.message.contextId,
      protocolDefinition,
      messageStore,
      boundFetchDefinition,
      governingTimestamp,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      recordChain,
      messageStore,
      protocolDefinition,
    );
  }

  public static async authorizeQueryOrSubscribe(
    tenant: string,
    incomingMessage: RecordsCount | RecordsQuery | RecordsSubscribe,
    messageStore: MessageStore,
    coreProtocols?: CoreProtocolRegistry,
  ): Promise<void> {
    const { protocol, protocolPath, contextId } = incomingMessage.message.descriptor.filter;

    // fetch the protocol definition
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      protocol!, // `authorizeQueryOrSubscribe` is only called if `protocol` is present
      messageStore,
      undefined,
      coreProtocols,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      protocolPath!, // presence of `protocolPath` is verified in `parse()`
      protocolDefinition,
    );

    const boundFetchDefinition = ProtocolAuthorization.createBoundFetchDefinition(coreProtocols);

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      protocol!,
      contextId,
      protocolDefinition,
      messageStore,
      boundFetchDefinition,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      [], // record chain is not relevant to queries or subscriptions
      messageStore,
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
    messageStore: MessageStore,
    coreProtocols?: CoreProtocolRegistry,
  ): Promise<void> {

    // fetch record chain
    const recordChain: RecordsWriteMessage[] =
      await constructRecordChain(tenant, incomingMessage.message.descriptor.recordId, messageStore);

    // Use the initial write's timestamp to determine the governing protocol definition.
    const initialWrite = await fetchInitialWrite(
      tenant, incomingMessage.message.descriptor.recordId, messageStore
    );
    const governingTimestamp = initialWrite === undefined
      ? recordsWrite.message.descriptor.messageTimestamp
      : initialWrite.descriptor.messageTimestamp;

    // fetch the protocol definition that was active when the record was created
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      recordsWrite.message.descriptor.protocol,
      messageStore,
      governingTimestamp,
      coreProtocols,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      recordsWrite.message.descriptor.protocolPath,
      protocolDefinition,
    );

    const boundFetchDefinition = ProtocolAuthorization.createBoundFetchDefinition(coreProtocols);

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await verifyInvokedRole(
      tenant,
      incomingMessage,
      recordsWrite.message.descriptor.protocol,
      recordsWrite.message.contextId,
      protocolDefinition,
      messageStore,
      boundFetchDefinition,
      governingTimestamp,
    );

    // verify method invoked against the allowed actions in the rule set
    await authorizeAgainstAllowedActions(
      tenant,
      incomingMessage,
      ruleSet,
      recordChain,
      messageStore,
      protocolDefinition,
    );
  }

  /**
   * Fetches the protocol definition based on the protocol specified in the given message.
   * When `messageTimestamp` is provided, returns the protocol definition that was active at that
   * point in time — i.e. the ProtocolsConfigure with the greatest `messageTimestamp` that is <= the
   * given timestamp. When not provided, returns the latest (current) protocol definition.
   *
   * When `coreProtocols` is provided, core protocol definitions are returned directly from the
   * registry without a message store query. The extra parameter does not affect the
   * `FetchProtocolDefinitionFn` callback type — callers that pass this function as a callback
   * should bind the registry via a closure (see `createBoundFetchDefinition`).
   */
  public static async fetchProtocolDefinition(
    tenant: string,
    protocolUri: string,
    messageStore: MessageStore,
    messageTimestamp?: string,
    coreProtocols?: CoreProtocolRegistry,
  ): Promise<ProtocolDefinition> {
    // if the protocol is a registered core protocol, return the definition directly without a store query
    if (coreProtocols !== undefined) {
      const coreDefinition = coreProtocols.getDefinition(protocolUri);
      if (coreDefinition !== undefined) {
        return coreDefinition;
      }
    }

    // fetch the corresponding protocol definition
    const query: Filter = {
      interface : DwnInterfaceName.Protocols,
      method    : DwnMethodName.Configure,
      protocol  : protocolUri,
    };

    if (messageTimestamp === undefined) {
      // default: return only the latest protocol definition
      query.isLatestBaseState = true;
    } else {
      // temporal lookup: find the protocol definition active at the given timestamp
      query.messageTimestamp = { lte: messageTimestamp };
    }

    const { messages: protocols } = await messageStore.query(
      tenant,
      [query],
      { messageTimestamp: SortDirection.Descending },
      { limit: 1 },
    );

    if (protocols.length === 0) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationProtocolNotFound, `unable to find protocol definition for ${protocolUri}`);
    }

    const protocolMessage = protocols[0] as ProtocolsConfigureMessage;
    return protocolMessage.descriptor.definition;
  }

  /**
   * Creates a `FetchProtocolDefinitionFn` closure that binds the given `CoreProtocolRegistry`.
   * This allows core protocol definitions to be resolved from the registry without changing
   * the `FetchProtocolDefinitionFn` type signature — zero ripple to downstream consumers
   * like `protocol-authorization-action.ts` and `protocol-authorization-validation.ts`.
   */
  private static createBoundFetchDefinition(coreProtocols?: CoreProtocolRegistry): FetchProtocolDefinitionFn {
    return (
      tenant: string,
      protocolUri: string,
      messageStore: MessageStore,
      messageTimestamp?: string,
    ): Promise<ProtocolDefinition> => {
      return ProtocolAuthorization.fetchProtocolDefinition(tenant, protocolUri, messageStore, messageTimestamp, coreProtocols);
    };
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

}
