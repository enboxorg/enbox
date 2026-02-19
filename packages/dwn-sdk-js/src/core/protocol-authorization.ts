import type { Filter } from '../types/query-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { RecordsCount } from '../interfaces/records-count.js';
import type { RecordsDelete } from '../interfaces/records-delete.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsRead } from '../interfaces/records-read.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type {
  ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage, ProtocolType, ProtocolTypes
} from '../types/protocols-types.js';

import Ajv from 'ajv/dist/2020.js';
import { FilterUtility } from '../utils/filter.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { Records } from '../utils/records.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, isCrossProtocolRef, parseCrossProtocolRef } from '../utils/protocols.js';
import { ProtocolAction, ProtocolActor } from '../types/protocols-types.js';

export class ProtocolAuthorization {

  /**
   * Performs validation on the structure of RecordsWrite messages that use a protocol.
   * @throws {Error} if validation fails.
   */
  public static async validateReferentialIntegrity(
    tenant: string,
    incomingMessage: RecordsWrite,
    messageStore: MessageStore,
  ): Promise<void> {
    // Determine the governing timestamp for protocol definition lookup.
    // For an initial write, this is the message's own timestamp.
    // For an update, this is the initial write's timestamp (the protocol version is locked at creation time).
    const governingTimestamp = await ProtocolAuthorization.getGoverningTimestamp(
      tenant, incomingMessage, messageStore
    );

    // fetch the protocol definition that was active at the governing timestamp
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      incomingMessage.message.descriptor.protocol!,
      messageStore,
      governingTimestamp,
    );

    // verify declared protocol type exists in protocol and that it conforms to type specification.
    // For cross-protocol composition, the type may be defined in a referenced protocol.
    await ProtocolAuthorization.verifyTypeWithComposition(
      tenant, incomingMessage.message, protocolDefinition, messageStore
    );

    // validate `protocolPath`
    await ProtocolAuthorization.verifyProtocolPathAndContextId(
      tenant,
      incomingMessage,
      messageStore,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      incomingMessage.message.descriptor.protocolPath!,
      protocolDefinition,
    );

    // Validate as a role record if the incoming message is writing a role record
    await ProtocolAuthorization.verifyAsRoleRecordIfNeeded(
      tenant,
      incomingMessage,
      ruleSet,
      messageStore,
    );

    // Verify size limit
    ProtocolAuthorization.verifySizeLimit(incomingMessage, ruleSet);

    // Verify protocol tags
    ProtocolAuthorization.verifyTagsIfNeeded(incomingMessage, ruleSet);
  }

  /**
   * Performs protocol-based authorization against the incoming RecordsWrite message.
   * @throws {Error} if authorization fails.
   */
  public static async authorizeWrite(
    tenant: string,
    incomingMessage: RecordsWrite,
    messageStore: MessageStore,
  ): Promise<void> {
    const existingInitialWrite = await ProtocolAuthorization.fetchInitialWrite(tenant, incomingMessage.message.recordId, messageStore);

    let recordChain;
    if (existingInitialWrite === undefined) {
      // NOTE: we can assume this message is an initial write because an existing initial write does not exist.
      // Additionally, we check further down in the `RecordsWriteHandler` if the incoming message is an initialWrite,
      // so we don't check explicitly here to avoid an unnecessary duplicate check.
      recordChain = await ProtocolAuthorization.constructRecordChain(tenant, incomingMessage.message.descriptor.parentId, messageStore);
    } else {
      recordChain = await ProtocolAuthorization.constructRecordChain(tenant, incomingMessage.message.recordId, messageStore);
    }

    // Determine the governing timestamp for protocol definition lookup.
    const governingTimestamp = await ProtocolAuthorization.getGoverningTimestamp(
      tenant, incomingMessage, messageStore
    );

    // fetch the protocol definition that was active at the governing timestamp
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      incomingMessage.message.descriptor.protocol!,
      messageStore,
      governingTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      incomingMessage.message.descriptor.protocolPath!,
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await ProtocolAuthorization.verifyInvokedRole(
      tenant,
      incomingMessage,
      incomingMessage.message.descriptor.protocol!,
      incomingMessage.message.contextId!,
      protocolDefinition,
      messageStore,
    );

    // verify method invoked against the allowed actions in the rule set
    await ProtocolAuthorization.authorizeAgainstAllowedActions(
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
  ): Promise<void> {
    // fetch record chain
    const recordChain: RecordsWriteMessage[] =
      await ProtocolAuthorization.constructRecordChain(tenant, newestRecordsWrite.message.recordId, messageStore);

    // Use the initial write's timestamp to determine the governing protocol definition.
    // The protocol version is locked at the time the record was first created.
    const initialWrite = await ProtocolAuthorization.fetchInitialWrite(
      tenant, newestRecordsWrite.message.recordId, messageStore
    );
    const governingTimestamp = initialWrite !== undefined
      ? initialWrite.descriptor.messageTimestamp
      : newestRecordsWrite.message.descriptor.messageTimestamp;

    // fetch the protocol definition that was active when the record was created
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      newestRecordsWrite.message.descriptor.protocol!,
      messageStore,
      governingTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      newestRecordsWrite.message.descriptor.protocolPath!,
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await ProtocolAuthorization.verifyInvokedRole(
      tenant,
      incomingMessage,
      newestRecordsWrite.message.descriptor.protocol!,
      newestRecordsWrite.message.contextId!,
      protocolDefinition,
      messageStore,
    );

    // verify method invoked against the allowed actions in the rule set
    await ProtocolAuthorization.authorizeAgainstAllowedActions(
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
  ): Promise<void> {
    const { protocol, protocolPath, contextId } = incomingMessage.message.descriptor.filter;

    // fetch the protocol definition
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      protocol!, // `authorizeQueryOrSubscribe` is only called if `protocol` is present
      messageStore,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      protocolPath!, // presence of `protocolPath` is verified in `parse()`
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await ProtocolAuthorization.verifyInvokedRole(
      tenant,
      incomingMessage,
      protocol!,
      contextId,
      protocolDefinition,
      messageStore,
    );

    // verify method invoked against the allowed actions in the rule set
    await ProtocolAuthorization.authorizeAgainstAllowedActions(
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
  ): Promise<void> {

    // fetch record chain
    const recordChain: RecordsWriteMessage[] =
      await ProtocolAuthorization.constructRecordChain(tenant, incomingMessage.message.descriptor.recordId, messageStore);

    // Use the initial write's timestamp to determine the governing protocol definition.
    const initialWrite = await ProtocolAuthorization.fetchInitialWrite(
      tenant, incomingMessage.message.descriptor.recordId, messageStore
    );
    const governingTimestamp = initialWrite !== undefined
      ? initialWrite.descriptor.messageTimestamp
      : recordsWrite.message.descriptor.messageTimestamp;

    // fetch the protocol definition that was active when the record was created
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant,
      recordsWrite.message.descriptor.protocol!,
      messageStore,
      governingTimestamp,
    );

    // get the rule set for the inbound message
    const ruleSet = ProtocolAuthorization.getRuleSet(
      recordsWrite.message.descriptor.protocolPath!,
      protocolDefinition,
    );

    // If the incoming message has `protocolRole` in the descriptor, validate the invoked role
    await ProtocolAuthorization.verifyInvokedRole(
      tenant,
      incomingMessage,
      recordsWrite.message.descriptor.protocol!,
      recordsWrite.message.contextId!,
      protocolDefinition,
      messageStore,
    );

    // verify method invoked against the allowed actions in the rule set
    await ProtocolAuthorization.authorizeAgainstAllowedActions(
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
   */
  private static async fetchProtocolDefinition(
    tenant: string,
    protocolUri: string,
    messageStore: MessageStore,
    messageTimestamp?: string,
  ): Promise<ProtocolDefinition> {
    // if first-class protocol, return the definition from const object directly without going to data store
    if (protocolUri === PermissionsProtocol.uri) {
      return PermissionsProtocol.definition;
    }

    // fetch the corresponding protocol definition
    const query: Filter = {
      interface : DwnInterfaceName.Protocols,
      method    : DwnMethodName.Configure,
      protocol  : protocolUri,
    };

    if (messageTimestamp !== undefined) {
      // temporal lookup: find the protocol definition active at the given timestamp
      query.messageTimestamp = { lte: messageTimestamp };
    } else {
      // default: return only the latest protocol definition
      query.isLatestBaseState = true;
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
   * Constructs the chain of EXISTING records in the datastore where the first record is the root initial `RecordsWrite` of the record chain
   * and last record is the initial `RecordsWrite` of the descendant record specified.
   * @param descendantRecordId The ID of the descendent record to start constructing the record chain from by repeatedly looking up the parent.
   * @returns the record chain where each record is represented by its initial `RecordsWrite`;
   *          returns empty array if `descendantRecordId` is `undefined`.
   * @throws {DwnError} if `descendantRecordId` is defined but any initial `RecordsWrite` is not found in the chain of records.
   */
  private static async constructRecordChain(
    tenant: string,
    descendantRecordId: string | undefined,
    messageStore: MessageStore
  ) : Promise<RecordsWriteMessage[]> {

    if (descendantRecordId === undefined) {
      return [];
    }

    const recordChain: RecordsWriteMessage[] = [];

    // keep walking up the chain from the inbound message's parent, until there is no more parent
    let currentRecordId: string | undefined = descendantRecordId;
    while (currentRecordId !== undefined) {

      const initialWrite = await ProtocolAuthorization.fetchInitialWrite(tenant, currentRecordId, messageStore);

      // RecordsWrite needed should be available since we perform necessary checks at the time of writes,
      // eg. check the immediate parent in `verifyProtocolPathAndContextId` at the time of writing,
      // so if this condition is triggered, it means there is an unexpected bug that caused an incomplete chain.
      // We add additional defensive check here because returning an unexpected/incorrect record chain could lead to security vulnerabilities.
      if (initialWrite === undefined) {
        throw new DwnError(
          DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain,
          `Unexpected error that should never trigger: no parent found with ID ${currentRecordId} when constructing record chain.`
        );
      }

      recordChain.push(initialWrite);
      currentRecordId = initialWrite.descriptor.parentId;
    }

    return recordChain.reverse(); // root record first
  }

  /**
   * Fetches the initial RecordsWrite message associated with the given (tenant + recordId).
   */
  private static async fetchInitialWrite(
    tenant: string,
    recordId: string,
    messageStore: MessageStore
  ): Promise<RecordsWriteMessage | undefined> {

    const query: Filter = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      recordId  : recordId
    };
    const { messages } = await messageStore.query(tenant, [query]);

    if (messages.length === 0) {
      return undefined;
    }

    const initialWrite = await RecordsWrite.getInitialWrite(messages);
    return initialWrite;
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

  /**
   * Verifies the `protocolPath` declared in the given message (if it is a RecordsWrite) matches the path of actual record chain.
   * For cross-protocol composition, the parent record may belong to a different protocol (resolved via `$ref` in the composing protocol).
   * @throws {DwnError} if fails verification.
   */
  private static async verifyProtocolPathAndContextId(
    tenant: string,
    inboundMessage: RecordsWrite,
    messageStore: MessageStore
  ): Promise<void> {
    const declaredProtocolPath = inboundMessage.message.descriptor.protocolPath!;
    const declaredTypeName = ProtocolAuthorization.getTypeName(declaredProtocolPath);

    const parentId = inboundMessage.message.descriptor.parentId;
    if (parentId === undefined) {
      if (declaredProtocolPath !== declaredTypeName) {
        throw new DwnError(
          DwnErrorCode.ProtocolAuthorizationParentlessIncorrectProtocolPath,
          `Declared protocol path '${declaredProtocolPath}' is not valid for records with no parent'.`
        );
      }

      return;
    }

    // Else `parentId` is defined, so we need to verify both protocolPath and contextId

    // Determine the protocol URI for the parent query.
    // If the parent path segment has a `$ref` in the composing protocol, the parent lives in a different protocol.
    const childProtocol = inboundMessage.message.descriptor.protocol!;
    const parentProtocolUri = await ProtocolAuthorization.resolveParentProtocolUri(
      tenant, childProtocol, declaredProtocolPath, messageStore
    );

    // fetch the parent message
    const query: Filter = {
      isLatestBaseState : true, // NOTE: this filter is critical, to ensure are are not returning a deleted parent
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      protocol          : parentProtocolUri,
      recordId          : parentId
    };
    const { messages: parentMessages } = await messageStore.query(tenant, [query]);
    const parentMessage = (parentMessages as RecordsWriteMessage[])[0];

    if (parentMessage === undefined) {
      // if this is a cross-protocol composition lookup, use a more descriptive error
      if (parentProtocolUri !== childProtocol) {
        throw new DwnError(
          DwnErrorCode.ProtocolAuthorizationCrossProtocolParentNotFound,
          `Could not find parent record '${parentId}' in protocol '${parentProtocolUri}' ` +
          `for cross-protocol child at path '${declaredProtocolPath}'.`
        );
      }

      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationIncorrectProtocolPath,
        `Could not find matching parent record to verify declared protocol path '${declaredProtocolPath}'.`
      );
    }

    // verifying protocolPath of incoming message is a child of the parent message's protocolPath
    const parentProtocolPath = parentMessage.descriptor.protocolPath;
    const expectedProtocolPath = `${parentProtocolPath}/${declaredTypeName}`;
    if (expectedProtocolPath !== declaredProtocolPath) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationIncorrectProtocolPath,
        `Could not find matching parent record to verify declared protocol path '${declaredProtocolPath}'.`
      );
    }

    // verifying contextId of incoming message is a child of the parent message's contextId
    const expectedContextId = `${parentMessage.contextId}/${inboundMessage.message.recordId}`;
    const actualContextId = inboundMessage.message.contextId;
    if (actualContextId !== expectedContextId) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationIncorrectContextId,
        `Declared contextId '${actualContextId}' is not the same as expected: '${expectedContextId}'.`
      );
    }

  }

  /**
   * Resolves the protocol URI that should be used when querying for the parent record.
   * For standard (non-composed) records, this is the same as the child's protocol.
   * For cross-protocol composition, the parent may live in a different protocol
   * (resolved via `$ref` in the composing protocol's definition).
   *
   * Logic: Given a child at protocolPath `a/b/c`, the parent is at `a/b`.
   * Walk up the composing protocol's structure from root to `a/b`.
   * If any segment along the way has a `$ref`, the parent (and its ancestors up to the `$ref` boundary)
   * live in the referenced protocol. Specifically, the `$ref` at the topmost ancestor tells us
   * the parent's protocol URI.
   */
  private static async resolveParentProtocolUri(
    tenant: string,
    childProtocolUri: string,
    childProtocolPath: string,
    messageStore: MessageStore,
  ): Promise<string> {
    const segments = childProtocolPath.split('/');

    // A root-level record (no `/` in path) has no parent or uses the same protocol
    if (segments.length <= 1) {
      return childProtocolUri;
    }

    // Fetch the composing protocol's definition
    const composingDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
      tenant, childProtocolUri, messageStore
    );

    // Walk the structure to find the parent's path segment
    // The parent's position in the structure is at segments[0..n-2]
    // We check if the first segment has a `$ref`, which means the parent is in a different protocol
    const firstSegmentRuleSet = composingDefinition.structure[segments[0]];
    if (firstSegmentRuleSet?.$ref !== undefined) {
      const parsed = parseCrossProtocolRef(firstSegmentRuleSet.$ref);
      if (parsed !== undefined && composingDefinition.uses !== undefined) {
        const resolvedUri = composingDefinition.uses[parsed.alias];
        if (resolvedUri !== undefined) {
          // The parent path is within the `$ref` boundary — check if the parent IS the `$ref` node
          // or is a descendant of it (which would still be in the composing protocol).
          // If segments.length === 2, parent is at segments[0] which IS the $ref node → parent's protocol is the referenced one.
          // If segments.length > 2, parent is at segments[0..n-2]. If segments[0] is $ref, the parent could be:
          //   - Still the $ref node itself (segments.length === 2) → referenced protocol
          //   - A child of the $ref node defined in the composing protocol (segments.length > 2) → composing protocol
          if (segments.length === 2) {
            // Parent is the $ref node itself (e.g., child is "thread/comment", parent is "thread")
            return resolvedUri;
          }
          // else: parent is a deeper child defined in the composing protocol
          return childProtocolUri;
        }
      }
    }

    return childProtocolUri;
  }

  /**
   * Verifies the `dataFormat` and `schema` declared in the given message matches the type in the protocol.
   * For cross-protocol composition, if the type is at a `$ref` position in the structure,
   * the type definition is looked up in the referenced protocol's `types` map instead.
   */
  private static async verifyTypeWithComposition(
    tenant: string,
    inboundMessage: RecordsWriteMessage,
    protocolDefinition: ProtocolDefinition,
    messageStore: MessageStore,
  ): Promise<void> {
    const declaredProtocolPath = inboundMessage.descriptor.protocolPath!;
    const declaredTypeName = ProtocolAuthorization.getTypeName(declaredProtocolPath);

    // Resolve which protocol types map to use.
    // If the first path segment has `$ref`, this record's type might be defined in a referenced protocol.
    const protocolTypes = await ProtocolAuthorization.resolveProtocolTypesForPath(
      tenant, declaredProtocolPath, protocolDefinition, messageStore
    );

    ProtocolAuthorization.verifyType(inboundMessage, protocolTypes, declaredTypeName);
  }

  /**
   * Resolves the `ProtocolTypes` map that contains the type definition for the given protocol path.
   * For non-composed records, this is the protocol definition's own `types` map.
   * For records at a `$ref` position, this is the referenced protocol's `types` map.
   */
  private static async resolveProtocolTypesForPath(
    tenant: string,
    protocolPath: string,
    protocolDefinition: ProtocolDefinition,
    messageStore: MessageStore,
  ): Promise<ProtocolTypes> {
    const segments = protocolPath.split('/');

    // Check if the first segment has a `$ref`
    const firstSegmentRuleSet = protocolDefinition.structure[segments[0]];
    if (firstSegmentRuleSet?.$ref !== undefined && segments.length === 1) {
      // This record IS the $ref node itself — its type is defined in the referenced protocol
      const parsed = parseCrossProtocolRef(firstSegmentRuleSet.$ref);
      if (parsed !== undefined && protocolDefinition.uses !== undefined) {
        const refProtocolUri = protocolDefinition.uses[parsed.alias];
        if (refProtocolUri !== undefined) {
          const refDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
            tenant, refProtocolUri, messageStore
          );
          return refDefinition.types;
        }
      }
    }

    // Default: use the composing protocol's own types
    return protocolDefinition.types;
  }

  /**
   * Verifies the `dataFormat` and `schema` declared in the given message (if it is a RecordsWrite) matches dataFormat
   * and schema of the type in the given protocol.
   * @throws {DwnError} if fails verification.
   */
  private static verifyType(
    inboundMessage: RecordsWriteMessage,
    protocolTypes: ProtocolTypes,
    typeName?: string,
  ): void {
    const declaredTypeName = typeName ?? ProtocolAuthorization.getTypeName(inboundMessage.descriptor.protocolPath!);
    const typeNames = Object.keys(protocolTypes);

    if (!typeNames.includes(declaredTypeName)) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationInvalidType,
        `record with type ${declaredTypeName} not allowed in protocol`);
    }

    const protocolType: ProtocolType = protocolTypes[declaredTypeName];

    // no `schema` specified in protocol definition means that any schema is allowed
    const { schema } = inboundMessage.descriptor;
    if (protocolType.schema !== undefined && protocolType.schema !== schema) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationInvalidSchema,
        `type '${declaredTypeName}' must have schema '${protocolType.schema}', \
        instead has '${schema}'`
      );
    }

    // no `dataFormats` specified in protocol definition means that all dataFormats are allowed
    const { dataFormat } = inboundMessage.descriptor;
    if (protocolType.dataFormats !== undefined && !protocolType.dataFormats.includes(dataFormat)) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationIncorrectDataFormat,
        `type '${declaredTypeName}' must have data format in (${protocolType.dataFormats}), \
        instead has '${dataFormat}'`
      );
    }
  }

  /**
   * Check if the incoming message is invoking a role. If so, validate the invoked role.
   * For cross-protocol role invocation, the role record may live in a different protocol
   * (resolved via the composing protocol's `uses` map).
   */
  private static async verifyInvokedRole(
    tenant: string,
    incomingMessage: RecordsCount | RecordsDelete | RecordsQuery | RecordsRead | RecordsSubscribe | RecordsWrite,
    protocolUri: string,
    contextId: string | undefined,
    protocolDefinition: ProtocolDefinition,
    messageStore: MessageStore,
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

      if (protocolDefinition.uses === undefined || protocolDefinition.uses[parsed.alias] === undefined) {
        throw new DwnError(
          DwnErrorCode.ProtocolAuthorizationNotARole,
          `Cross-protocol role alias '${parsed.alias}' in '${protocolRole}' does not exist in the protocol's 'uses' map.`
        );
      }

      roleProtocolUri = protocolDefinition.uses[parsed.alias];
      roleProtocolPath = parsed.protocolPath;

      // Fetch the referenced protocol's definition to validate the role exists
      const refDefinition = await ProtocolAuthorization.fetchProtocolDefinition(
        tenant, roleProtocolUri, messageStore
      );
      const roleRuleSet = getRuleSetAtPath(roleProtocolPath, refDefinition.structure);
      if (roleRuleSet === undefined || !roleRuleSet.$role) {
        throw new DwnError(
          DwnErrorCode.ProtocolAuthorizationNotARole,
          `Cross-protocol role path ${protocolRole} does not match role record type.`
        );
      }
    } else {
      // Local role: validate in the composing protocol's definition
      const roleRuleSet = getRuleSetAtPath(protocolRole, protocolDefinition.structure);
      if (roleRuleSet === undefined || !roleRuleSet.$role) {
        throw new DwnError(
          DwnErrorCode.ProtocolAuthorizationNotARole,
          `Protocol path ${protocolRole} does not match role record type.`
        );
      }
    }

    // Construct a filter to fetch the invoked role record
    const roleRecordFilter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      protocol          : roleProtocolUri,
      protocolPath      : roleProtocolPath,
      recipient         : incomingMessage.author!,
      isLatestBaseState : true,
    };

    const ancestorSegmentCountOfRolePath = roleProtocolPath.split('/').length - 1;
    if (contextId === undefined && ancestorSegmentCountOfRolePath > 0) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationMissingContextId,
        'Could not verify role because contextId is missing.'
      );
    }

    // Compute `contextId` prefix filter for fetching the invoked role record if the role path is not at the root level.
    // e.g. if invoked role path is `Thread/Participant`, and the `contextId` of the message is `threadX/messageY/attachmentZ`,
    // then we need to add a prefix filter as `threadX` for the `contextId`
    // because the `contextId` of the Participant record would be in the form of be `threadX/participantA`
    if (ancestorSegmentCountOfRolePath > 0) {
      const contextIdSegments = contextId!.split('/'); // NOTE: currently contextId segment count is never shorter than the role path count.
      const contextIdPrefix = contextIdSegments.slice(0, ancestorSegmentCountOfRolePath).join('/');
      const contextIdPrefixFilter = FilterUtility.constructPrefixFilterAsRangeFilter(contextIdPrefix);

      roleRecordFilter.contextId = contextIdPrefixFilter;
    }


    const { messages: matchingMessages } = await messageStore.query(tenant, [roleRecordFilter]);

    if (matchingMessages.length === 0) {
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
  private static async getActionsSeekingARuleMatch(
    tenant: string,
    incomingMessage: RecordsCount | RecordsDelete | RecordsQuery | RecordsRead | RecordsSubscribe | RecordsWrite,
    messageStore: MessageStore,
  ): Promise<ProtocolAction[]> {

    switch (incomingMessage.message.descriptor.method) {
    case DwnMethodName.Delete:
      const recordsDelete = incomingMessage as RecordsDelete;
      const recordId = recordsDelete.message.descriptor.recordId;
      const initialWrite = await RecordsWrite.fetchInitialRecordsWrite(messageStore, tenant, recordId);

      // if there is no initial write, then no action rule can authorize the incoming message, because we won't know who the original author is
      // NOTE: purely defensive programming: currently not reachable
      // because RecordsDelete handler already have an existence check prior to this method being called.
      if (initialWrite === undefined) {
        return [];
      }

      const actionsThatWouldAuthorizeDelete = [];
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

    case DwnMethodName.Count:
      return [ProtocolAction.Read];

    case DwnMethodName.Query:
      return [ProtocolAction.Read];

    case DwnMethodName.Read:
      return [ProtocolAction.Read];

    case DwnMethodName.Subscribe:
      return [ProtocolAction.Read];

    case DwnMethodName.Write:
      const incomingRecordsWrite = incomingMessage as RecordsWrite;

      if (await incomingRecordsWrite.isInitialWrite()) {
        return [ProtocolAction.Create];
      } else {
        // else incoming RecordsWrite not an initial write

        const recordId = (incomingMessage as RecordsWrite).message.recordId;
        const initialWrite = await RecordsWrite.fetchInitialRecordsWrite(messageStore, tenant, recordId);

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

    // purely defensive programming: should not be reachable
    // setting to empty array will prevent any message from being authorized
    return [];
  }

  /**
   * Verifies the given message is authorized by one of the action rules in the given protocol rule set.
   * @param protocolDefinition Optional protocol definition for resolving cross-protocol `of` and `role` references.
   * @throws {Error} if action not allowed.
   */
  private static async authorizeAgainstAllowedActions(
    tenant: string,
    incomingMessage: RecordsCount | RecordsDelete | RecordsQuery | RecordsRead | RecordsSubscribe | RecordsWrite,
    ruleSet: ProtocolRuleSet,
    recordChain: RecordsWriteMessage[],
    messageStore: MessageStore,
    protocolDefinition?: ProtocolDefinition,
  ): Promise<void> {
    const incomingMessageMethod = incomingMessage.message.descriptor.method;
    const actionsSeekingARuleMatch = await ProtocolAuthorization.getActionsSeekingARuleMatch(tenant, incomingMessage, messageStore);
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
      const ruleHasAMatchingAllowedAction = actionRule.can.some(allowedAction => actionsSeekingARuleMatch.includes(allowedAction as ProtocolAction));
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
      const ancestorRuleSuccess: boolean = await ProtocolAuthorization.checkActor(author, actionRule, recordChain, protocolDefinition);
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
   * Verifies that writes adhere to the $size constraints if provided
   * @throws {Error} if size is exceeded.
   */
  private static verifySizeLimit(
    incomingMessage: RecordsWrite,
    ruleSet: ProtocolRuleSet
  ): void {
    const { min = 0, max } = ruleSet.$size || {};

    const dataSize = incomingMessage.message.descriptor.dataSize;

    if (dataSize < min) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationMinSizeInvalid, `data size ${dataSize} is less than allowed ${min}`);
    }

    if (max === undefined) {
      return;
    }

    if (dataSize > max) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationMaxSizeInvalid, `data size ${dataSize} is more than allowed ${max}`);
    }
  }

  private static verifyTagsIfNeeded(
    incomingMessage: RecordsWrite,
    ruleSet: ProtocolRuleSet
  ): void {
    if (ruleSet.$tags !== undefined) {
      const { tags = {}, protocol, protocolPath } = incomingMessage.message.descriptor;

      const { $allowUndefinedTags, $requiredTags, ...properties } = ruleSet.$tags;

      // if $allowUndefinedTags is set to false and there are properties not defined in the schema, an error is thrown
      const additionalProperties = $allowUndefinedTags || false;

      // if $requiredTags is set, all required tags must be present
      const required = $requiredTags || [];

      const ajv = new Ajv.default();
      const compiledTags = ajv.compile({
        type: 'object',
        properties,
        required,
        additionalProperties,
      });

      const validSchema = compiledTags(tags);
      if (!validSchema) {
        // the `dataVar` is used to add a qualifier to the error message.
        // For example. If the error is related to a tag `status` in a protocol `https://example.protocol` with the protocolPath `example/path`
        // the error would be described as `https://example.protocol/example/path/$tags/status'
        // without this decorator it would show up as `data/status` which may be confusing.
        const schemaError = ajv.errorsText(compiledTags.errors, { dataVar: `${protocol}/${protocolPath}/$tags` });
        throw new DwnError(DwnErrorCode.ProtocolAuthorizationTagsInvalidSchema, `tags schema validation error: ${schemaError}`);
      }
    }
  }

  /**
   * If the given RecordsWrite is not a role record, this method does nothing and succeeds immediately.
   *
   * Else it verifies the validity of the given `RecordsWrite` as a role record, including:
   * 1. The same role has not been assigned to the same entity/recipient.
   */
  private static async verifyAsRoleRecordIfNeeded(
    tenant: string,
    incomingMessage: RecordsWrite,
    ruleSet: ProtocolRuleSet,
    messageStore: MessageStore,
  ): Promise<void> {
    if (!ruleSet.$role) {
      return;
    }

    // else this is a role record

    const incomingRecordsWrite = incomingMessage;
    const recipient = incomingRecordsWrite.message.descriptor.recipient;
    if (recipient === undefined) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationRoleMissingRecipient,
        'Role records must have a recipient'
      );
    }

    const protocolPath = incomingRecordsWrite.message.descriptor.protocolPath!;
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      protocol          : incomingRecordsWrite.message.descriptor.protocol!,
      protocolPath,
      recipient,
    };

    const parentContextId = Records.getParentContextFromOfContextId(incomingRecordsWrite.message.contextId)!;

    // if this is not the root record, add a prefix filter to the query
    if (parentContextId !== '') {
      const prefixFilter = FilterUtility.constructPrefixFilterAsRangeFilter(parentContextId);
      filter.contextId = prefixFilter;
    }

    const { messages: matchingMessages } = await messageStore.query(tenant, [filter]);
    const matchingRecords = matchingMessages as RecordsWriteMessage[];
    const matchingRecordsExceptIncomingRecordId = matchingRecords.filter((recordsWriteMessage) =>
      recordsWriteMessage.recordId !== incomingRecordsWrite.message.recordId
    );
    if (matchingRecordsExceptIncomingRecordId.length > 0) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationDuplicateRoleRecipient,
        `DID '${recipient}' is already recipient of a role record at protocol path '${protocolPath} under the parent context ${parentContextId}.`
      );
    }
  }

  /**
   * Checks if the `who: 'author' | 'recipient'` action rule has a matching record in the record chain.
   * For cross-protocol `of` references (e.g., `"threads:thread"`), matches against both the protocol URI
   * and the protocol path of the ancestor record.
   * @returns `true` if the action rule is satisfied; `false` otherwise.
   */
  private static async checkActor(
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
          ancestorRecordsWrite = recordChain.find((msg) =>
            msg.descriptor.protocol === refProtocolUri && msg.descriptor.protocolPath === parsed.protocolPath
          );
        }
      }
    } else {
      // Local `of`: match by protocolPath only (same protocol assumed)
      ancestorRecordsWrite = recordChain.find((msg) =>
        msg.descriptor.protocolPath === ofValue
      );
    }

    if (ancestorRecordsWrite === undefined) {
      // This should be unreachable for valid protocol definitions because `ProtocolsConfigure.validateRuleSetRecursively()`
      // now validates that `actionRule.of` is an ancestor of the current protocol path at definition time.
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationActionNotAllowed,
        `No ancestor record found with protocol path '${ofValue}' in the record chain. ` +
        `This indicates an invalid protocol definition that should have been rejected at configuration time.`
      );
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

  /**
   * Determines the timestamp that governs which protocol definition version applies to the given RecordsWrite.
   * For an update, this is the initial write's `messageTimestamp` (the protocol version is locked at creation time).
   * For a new initial write, returns `undefined` — the latest protocol definition should be used because the
   * record is being created now and must conform to the current protocol rules.
   */
  private static async getGoverningTimestamp(
    tenant: string,
    incomingMessage: RecordsWrite,
    messageStore: MessageStore,
  ): Promise<string | undefined> {
    const existingInitialWrite = await ProtocolAuthorization.fetchInitialWrite(
      tenant, incomingMessage.message.recordId, messageStore
    );

    if (existingInitialWrite !== undefined) {
      // update case: use the initial write's timestamp
      return existingInitialWrite.descriptor.messageTimestamp;
    }

    // initial write case: validate against the latest protocol definition
    return undefined;
  }

  private static getTypeName(protocolPath: string): string {
    return protocolPath.split('/').slice(-1)[0];
  }
}