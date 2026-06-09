import type { GenericMessageReply } from '../types/message-types.js';
import type { MessageStore } from '../types//message-store.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage } from '../types/protocols-types.js';

import { authenticate } from '../core/auth.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { ProtocolsConfigure } from '../interfaces/protocols-configure.js';
import { ProtocolsGrantAuthorization } from '../core/protocols-grant-authorization.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { StorageController } from '../store/storage-controller.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, parseCrossProtocolRef } from '../utils/protocols.js';

type StoredInitialWriteConfigValidity = 'valid' | 'invalid' | 'unknown';

const STORED_INITIAL_WRITE_CONFIG_INVALID_CODES = new Set<string>([
  DwnErrorCode.ProtocolAuthorizationEncryptionRequired,
  DwnErrorCode.ProtocolAuthorizationIncorrectDataFormat,
  DwnErrorCode.ProtocolAuthorizationInitialWriteRevalidationNotInitial,
  DwnErrorCode.ProtocolAuthorizationInvalidSchema,
  DwnErrorCode.ProtocolAuthorizationInvalidType,
  DwnErrorCode.ProtocolAuthorizationMaxSizeInvalid,
  DwnErrorCode.ProtocolAuthorizationMinSizeInvalid,
  DwnErrorCode.ProtocolAuthorizationMissingRuleSet,
  DwnErrorCode.ProtocolAuthorizationSquashNotEnabled,
  DwnErrorCode.ProtocolAuthorizationSquashNotInitialWrite,
  DwnErrorCode.ProtocolAuthorizationStoredInitialWriteActionNotAllowed,
  DwnErrorCode.ProtocolAuthorizationStoredInitialWriteActionRulesNotFound,
  DwnErrorCode.ProtocolAuthorizationStoredInitialWriteRoleMissingRecipient,
  DwnErrorCode.ProtocolAuthorizationTagsInvalidSchema,
]);

export class ProtocolsConfigureHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
  }: {tenant: string, message: ProtocolsConfigureMessage }): Promise<GenericMessageReply> {
    let protocolsConfigure: ProtocolsConfigure;
    try {
      protocolsConfigure = await ProtocolsConfigure.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication & authorization
    try {
      await authenticate(message.authorization, this.deps.didResolver);
      await ProtocolsConfigureHandler.authorizeProtocolsConfigure(tenant, protocolsConfigure, this.deps.messageStore);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // validate composition dependencies: all `uses` protocols must already be installed,
    // `$ref` paths must exist in the referenced protocols, and cross-protocol roles must exist.
    try {
      await ProtocolsConfigureHandler.validateCompositionDependencies(
        tenant, message.descriptor.definition, this.deps.messageStore
      );
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // attempt to get existing protocol
    const query = {
      interface : DwnInterfaceName.Protocols,
      method    : DwnMethodName.Configure,
      protocol  : message.descriptor.definition.protocol
    };
    const { messages: existingMessages } = await this.deps.messageStore.query(tenant, [ query ]);

    // If the exact same message already exists, return 409 immediately.
    // This prevents duplicate key violations in the MessageStore and StateIndex
    // when sync pushes a message that the remote already has.
    const incomingCid = await Message.getCid(message);
    for (const existing of existingMessages) {
      if (await Message.getCid(existing) === incomingCid) {
        return { status: { code: 409, detail: 'Conflict' } };
      }
    }

    // find newest message, and if the incoming message is the newest
    let newestMessage = await Message.getNewestMessage(existingMessages);
    let incomingMessageIsNewest = false;
    if (newestMessage === undefined || await Message.isNewer(message, newestMessage)) {
      incomingMessageIsNewest = true;
      newestMessage = message;
    }

    // write the incoming message to DB if incoming message is newest
    let messageReply: GenericMessageReply;
    if (incomingMessageIsNewest) {
      const indexes = ProtocolsConfigureHandler.constructIndexes(protocolsConfigure, true);

      await this.deps.messageStore.put(tenant, message, indexes);
      const messageCid = await Message.getCid(message);
      await this.deps.stateIndex!.insert(tenant, messageCid, indexes);

      // only emit if the event log is set
      if (this.deps.eventLog !== undefined) {
        await this.deps.eventLog.emit(tenant, { message }, indexes, messageCid);
      }

      messageReply = {
        status: { code: 202, detail: 'Accepted' }
      };
    } else {
      // incoming message is older — still store it as a historical version (not the latest)
      const indexes = ProtocolsConfigureHandler.constructIndexes(protocolsConfigure, false);

      await this.deps.messageStore.put(tenant, message, indexes);
      const messageCid = await Message.getCid(message);
      await this.deps.stateIndex!.insert(tenant, messageCid, indexes);

      messageReply = {
        status: { code: 202, detail: 'Accepted' }
      };
    }

    // re-index previously-latest messages as no longer the latest base state.
    // We must delete and re-put (not just put) to properly replace old index entries.
    for (const existingMessage of existingMessages) {
      if (existingMessage !== newestMessage) {
        const existingProtocolsConfigure = await ProtocolsConfigure.parse(existingMessage as ProtocolsConfigureMessage);
        const updatedIndexes = ProtocolsConfigureHandler.constructIndexes(existingProtocolsConfigure, false);
        const existingCid = await Message.getCid(existingMessage);

        await this.deps.messageStore.delete(tenant, existingCid);
        await this.deps.messageStore.put(tenant, existingMessage, updatedIndexes);
      }
    }

    await this.purgeRecordsInvalidatedByProtocolConfig(tenant, message.descriptor.definition.protocol);

    return messageReply;
  };

  static constructIndexes(protocolsConfigure: ProtocolsConfigure, isLatestBaseState: boolean): { [key: string]: string | boolean } {
    // strip out `definition` as it is not indexable
    const { definition, ...propertiesToIndex } = protocolsConfigure.message.descriptor;
    const { author } = protocolsConfigure;

    const indexes: { [key: string]: string | boolean } = {
      ...propertiesToIndex,
      author    : author!,
      protocol  : definition.protocol, // retain protocol url from `definition`,
      published : definition.published, // retain published state from definition
      isLatestBaseState,
    };

    return indexes;
  }

  private static async authorizeProtocolsConfigure(tenant: string, protocolConfigure: ProtocolsConfigure, messageStore: MessageStore): Promise<void> {

    if (protocolConfigure.isSignedByAuthorDelegate) {
      await protocolConfigure.authorizeAuthorDelegate(messageStore);
    }

    if (protocolConfigure.author === tenant) {
      return;
    } else if (protocolConfigure.author !== undefined && Message.getPermissionGrantId(protocolConfigure.signaturePayload!) !== undefined) {
      const permissionGrantId = Message.getPermissionGrantId(protocolConfigure.signaturePayload!)!;
      const permissionGrant = await PermissionsProtocol.fetchGrant(tenant, messageStore, permissionGrantId);
      await ProtocolsGrantAuthorization.authorizeConfigure({
        protocolsConfigureMessage : protocolConfigure.message,
        expectedGrantor           : tenant,
        expectedGrantee           : protocolConfigure.author,
        permissionGrant,
        messageStore
      });
    } else {
      throw new DwnError(DwnErrorCode.ProtocolsConfigureAuthorizationFailed, 'message failed authorization');
    }
  }

  private async purgeRecordsInvalidatedByProtocolConfig(tenant: string, protocol: string): Promise<void> {
    const dataStore = this.deps.dataStore;
    const stateIndex = this.deps.stateIndex;
    if (dataStore === undefined || stateIndex === undefined) {
      return;
    }

    const { messages } = await this.deps.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      protocol,
    }]);

    const checkedRecordIds = new Set<string>();
    for (const message of messages) {
      const recordsWriteMessage = message as RecordsWriteMessage;
      if (checkedRecordIds.has(recordsWriteMessage.recordId)) {
        continue;
      }

      const isInitialWrite = await RecordsWrite.isInitialWrite(recordsWriteMessage);
      if (!isInitialWrite) {
        continue;
      }

      checkedRecordIds.add(recordsWriteMessage.recordId);

      const validity = await this.getStoredInitialWriteConfigValidity(tenant, recordsWriteMessage);
      if (validity !== 'invalid') {
        continue;
      }

      const { messages: recordMessages } = await this.deps.messageStore.query(tenant, [{
        interface : DwnInterfaceName.Records,
        recordId  : recordsWriteMessage.recordId,
      }]);
      if (recordMessages.length === 0) {
        continue;
      }

      // A DWN cannot synthesize a valid RecordsDelete on behalf of the record author.
      // This repair therefore performs a local hard purge of only the invalid initial
      // record. Descendants are evaluated independently so valid child records are not
      // destroyed as collateral.
      await StorageController.purgeRecordMessages(
        tenant, recordMessages, this.deps.messageStore, dataStore, stateIndex
      );
    }
  }

  private async getStoredInitialWriteConfigValidity(
    tenant: string,
    message: RecordsWriteMessage,
  ): Promise<StoredInitialWriteConfigValidity> {
    try {
      const recordsWrite = await RecordsWrite.parse(message);
      // Stored records were authenticated when admitted. Reconciliation should not make
      // record retention depend on fresh DID resolution availability or mutable dependency state.
      await ProtocolAuthorization.validateStoredInitialWrite(
        tenant, recordsWrite, this.deps.messageStore, this.deps.coreProtocols
      );
      return 'valid';
    } catch (error) {
      if (ProtocolsConfigureHandler.isStoredInitialWriteConfigInvalidError(error)) {
        return 'invalid';
      }

      return 'unknown';
    }
  }

  private static isStoredInitialWriteConfigInvalidError(error: unknown): boolean {
    return error instanceof DwnError && STORED_INITIAL_WRITE_CONFIG_INVALID_CODES.has(error.code);
  }

  /**
   * Validates composition dependencies at install time:
   * 1. All `uses` protocols must already be installed for the tenant.
   * 2. Each `$ref` path must exist in the referenced protocol's structure.
   * 3. Cross-protocol role references must point to valid role paths in the referenced protocol.
   *
   * This is a no-op if the protocol definition has no `uses` map.
   */
  private static async validateCompositionDependencies(
    tenant: string, definition: ProtocolDefinition, messageStore: MessageStore
  ): Promise<void> {
    const { uses } = definition;
    if (uses === undefined) {
      return;
    }

    // Fetch all referenced protocol definitions
    const referencedDefinitions = new Map<string, ProtocolDefinition>();
    for (const alias in uses) {
      const protocolUri = uses[alias];
      const refDefinition = await ProtocolsConfigureHandler.fetchInstalledProtocolDefinition(tenant, protocolUri, messageStore);

      if (refDefinition === undefined) {
        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled,
          `composed protocol '${protocolUri}' (alias '${alias}') is not installed for tenant '${tenant}'.`
        );
      }

      referencedDefinitions.set(alias, refDefinition);
    }

    // Walk the structure and validate all $ref paths and cross-protocol role references
    ProtocolsConfigureHandler.validateRefsAndRolesRecursively(definition.structure as ProtocolRuleSet, '', referencedDefinitions);
  }

  /**
   * Fetches the latest installed protocol definition for the given protocol URI.
   * @returns The protocol definition, or `undefined` if not installed.
   */
  private static async fetchInstalledProtocolDefinition(
    tenant: string, protocolUri: string, messageStore: MessageStore
  ): Promise<ProtocolDefinition | undefined> {
    const query = {
      interface         : DwnInterfaceName.Protocols,
      method            : DwnMethodName.Configure,
      protocol          : protocolUri,
      isLatestBaseState : true
    };
    const { messages } = await messageStore.query(tenant, [query]);

    if (messages.length === 0) {
      return undefined;
    }

    return (messages[0] as ProtocolsConfigureMessage).descriptor.definition;
  }

  /**
   * Recursively walks the structure tree to validate:
   * - `$ref` type paths exist in the referenced protocol's structure
   * - Cross-protocol `role` references point to valid `$role: true` paths in the referenced protocol
   */
  private static validateRefsAndRolesRecursively(
    ruleSet: ProtocolRuleSet,
    protocolPath: string,
    referencedDefinitions: Map<string, ProtocolDefinition>
  ): void {
    for (const key in ruleSet) {
      if (key.startsWith('$')) {
        continue;
      }

      const childRuleSet = ruleSet[key] as ProtocolRuleSet;
      const childProtocolPath = protocolPath === '' ? key : `${protocolPath}/${key}`;

      // Validate $ref path exists in the referenced protocol and does not traverse through another $ref
      if (childRuleSet.$ref !== undefined) {
        const parsed = parseCrossProtocolRef(childRuleSet.$ref);
        if (parsed !== undefined) {
          const refDefinition = referencedDefinitions.get(parsed.alias);
          if (refDefinition === undefined) {
            // Defensive: alias was validated by validateRefNode() and definition was fetched by validateCompositionDependencies()
            throw new DwnError(
              DwnErrorCode.ProtocolsConfigureInvalidRefAlias,
              `'$ref' alias '${parsed.alias}' at protocol path '${childProtocolPath}' ` +
              `was not found in the referenced definitions map.`
            );
          }

          // Walk the target path segment-by-segment and reject if any intermediate node has a $ref
          const segments = parsed.protocolPath.split('/');
          let currentLevel: { [key: string]: ProtocolRuleSet } = refDefinition.structure;

          for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const node = currentLevel[segment] as ProtocolRuleSet | undefined;

            if (node === undefined) {
              throw new DwnError(
                DwnErrorCode.ProtocolsConfigureInvalidRefProtocolPath,
                `'$ref' at protocol path '${childProtocolPath}' references type path '${parsed.protocolPath}' ` +
                `which does not exist in protocol '${refDefinition.protocol}'.`
              );
            }

            // If any node along the target path (including the final target) has a $ref,
            // it means the composition chain passes through another protocol boundary.
            // Multi-level composition is not supported — reject at install time.
            if (node.$ref !== undefined) {
              const traversedPath = segments.slice(0, i + 1).join('/');
              throw new DwnError(
                DwnErrorCode.ProtocolsConfigureInvalidRefTargetThroughRef,
                `'$ref' at protocol path '${childProtocolPath}' references type path '${parsed.protocolPath}' ` +
                `in protocol '${refDefinition.protocol}', but the node '${traversedPath}' is itself ` +
                `a '$ref' composition point. multi-level composition (chaining through '$ref' nodes) is not supported.`
              );
            }

            currentLevel = node as { [key: string]: ProtocolRuleSet };
          }
        }
      }

      // Validate cross-protocol references in $actions (roles and `of` paths)
      const actionRules = childRuleSet.$actions ?? [];
      for (const actionRule of actionRules) {
        // Validate cross-protocol role references
        if (actionRule.role !== undefined) {
          const parsed = parseCrossProtocolRef(actionRule.role);
          if (parsed !== undefined) {
            const refDefinition = referencedDefinitions.get(parsed.alias);
            if (refDefinition === undefined) {
              throw new DwnError(
                DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole,
                `cross-protocol role alias '${parsed.alias}' in '${actionRule.role}' at protocol path '${childProtocolPath}' ` +
                `was not found in the referenced definitions map.`
              );
            }

            // Check that the role path exists and is marked $role: true in the referenced protocol
            const roleRuleSet = getRuleSetAtPath(parsed.protocolPath, refDefinition.structure);
            if (!roleRuleSet?.$role) {
              throw new DwnError(
                DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole,
                `cross-protocol role '${actionRule.role}' at protocol path '${childProtocolPath}' ` +
                `does not point to a valid role ($role: true) in protocol '${refDefinition.protocol}'.`
              );
            }
          }
        }

        // Validate cross-protocol `of` references: the path must exist in the referenced protocol's structure
        if (actionRule.of !== undefined) {
          const parsed = parseCrossProtocolRef(actionRule.of);
          if (parsed !== undefined) {
            const refDefinition = referencedDefinitions.get(parsed.alias);
            if (refDefinition === undefined) {
              throw new DwnError(
                DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolOf,
                `cross-protocol 'of' alias '${parsed.alias}' in '${actionRule.of}' at protocol path '${childProtocolPath}' ` +
                `was not found in the referenced definitions map.`
              );
            }

            const ofRuleSet = getRuleSetAtPath(parsed.protocolPath, refDefinition.structure);
            if (ofRuleSet === undefined) {
              throw new DwnError(
                DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolOf,
                `cross-protocol 'of' reference '${actionRule.of}' at protocol path '${childProtocolPath}' ` +
                `does not point to a valid type path in protocol '${refDefinition.protocol}'.`
              );
            }
          }
        }
      }

      // Recurse into children
      ProtocolsConfigureHandler.validateRefsAndRolesRecursively(childRuleSet, childProtocolPath, referencedDefinitions);
    }
  }
}
