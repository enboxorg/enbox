import type { GenericMessageReply } from '../types/message-types.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage } from '../types/protocols-types.js';

import { authenticate } from '../core/auth.js';
import { isEncryptionControlPath } from '../core/constants.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { ProtocolsConfigure } from '../interfaces/protocols-configure.js';
import { ProtocolsGrantAuthorization } from '../core/protocols-grant-authorization.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { resolveProtocolTypesForPath } from '../core/protocol-authorization-validation.js';
import { StorageController } from '../store/storage-controller.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, getTypeName, parseCrossProtocolRef } from '../utils/protocols.js';

type StoredInitialWriteConfigValidity = 'valid' | 'invalid' | 'unknown';

const STORED_INITIAL_WRITE_CONFIG_INVALID_CODES = new Set<string>([
  DwnErrorCode.EncryptionControlValidateAudienceRolePathInvalid,
  DwnErrorCode.EncryptionControlValidateAudienceSealKeyIdMismatch,
  DwnErrorCode.ProtocolAuthorizationEncryptionNotAllowed,
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
  }: { tenant: string, message: ProtocolsConfigureMessage }): Promise<GenericMessageReply> {
    let protocolsConfigure: ProtocolsConfigure;
    try {
      protocolsConfigure = await ProtocolsConfigure.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication & authorization
    try {
      await authenticate(message.authorization, this.deps.didResolver);
      await ProtocolsConfigureHandler.authorizeProtocolsConfigure(tenant, protocolsConfigure, this.deps);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // validate composition dependencies: all `uses` protocols must already be installed,
    // `$ref` paths must exist in the referenced protocols, and cross-protocol roles must exist.
    try {
      await ProtocolsConfigureHandler.validateCompositionDependencies(
        tenant,
        message.descriptor.definition,
        this.deps.validationStateReader,
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
    // This prevents duplicate key violations in the MessageStore when sync pushes
    // a message that the remote already has.
    const incomingCid = await Message.getCid(message);
    for (const existing of existingMessages) {
      if (await Message.getCid(existing) === incomingCid) {
        return { status: { code: 409, detail: 'Conflict' } };
      }
    }

    let newestMessage = await Message.getNewestMessage(existingMessages) as ProtocolsConfigureMessage | undefined;
    let prefetchedRecordsWrites: RecordsWriteMessage[] | undefined;
    try {
      prefetchedRecordsWrites = await this.validateEncryptionPolicyIsImmutable(
        tenant,
        message.descriptor.definition,
        message.descriptor.messageTimestamp,
        newestMessage,
      );
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // find newest message, and if the incoming message is the newest
    let incomingMessageIsNewest = false;
    if (newestMessage === undefined || await Message.isNewer(message, newestMessage)) {
      incomingMessageIsNewest = true;
      newestMessage = message;
    }

    // write the incoming message to DB if incoming message is newest
    let messageReply: GenericMessageReply;
    let position: ProgressToken | undefined;
    if (incomingMessageIsNewest) {
      const indexes = ProtocolsConfigureHandler.constructIndexes(protocolsConfigure, true);

      const putResult = await this.deps.messageStore.put(tenant, message, indexes);
      position = putResult.position;

      messageReply = {
        status: { code: 202, detail: 'Accepted' },
        position,
      };
    } else {
      // incoming message is older — still store it as a historical version (not the latest)
      const indexes = ProtocolsConfigureHandler.constructIndexes(protocolsConfigure, false);

      const putResult = await this.deps.messageStore.put(tenant, message, indexes);
      position = putResult.position;

      messageReply = {
        status: { code: 202, detail: 'Accepted' },
        position,
      };
    }

    // re-index previously-latest messages as no longer the latest base state.
    for (const existingMessage of existingMessages) {
      if (existingMessage !== newestMessage) {
        const updatedIndexes = ProtocolsConfigureHandler.constructIndexesFromMessage(existingMessage as ProtocolsConfigureMessage, false);
        const existingCid = await Message.getCid(existingMessage);

        await this.deps.messageStore.updateIndexes(tenant, existingCid, updatedIndexes);
      }
    }

    await this.purgeRecordsInvalidatedByProtocolConfig(
      tenant,
      message.descriptor.definition.protocol,
      prefetchedRecordsWrites,
    );

    return messageReply;
  };

  static constructIndexes(protocolsConfigure: ProtocolsConfigure, isLatestBaseState: boolean): { [key: string]: string | boolean } {
    return ProtocolsConfigureHandler.constructIndexesFromMessage(protocolsConfigure.message, isLatestBaseState);
  }

  private static constructIndexesFromMessage(message: ProtocolsConfigureMessage, isLatestBaseState: boolean): { [key: string]: string | boolean } {
    // strip out `definition` as it is not indexable
    const { definition, ...propertiesToIndex } = message.descriptor;
    const author = Message.getAuthor(message);

    const indexes: { [key: string]: string | boolean } = {
      ...propertiesToIndex,
      author    : author!,
      protocol  : definition.protocol, // retain protocol url from `definition`,
      published : definition.published, // retain published state from definition
      isLatestBaseState,
    };

    return indexes;
  }

  private static async authorizeProtocolsConfigure(tenant: string, protocolConfigure: ProtocolsConfigure, deps: HandlerDependencies): Promise<void> {

    if (protocolConfigure.isSignedByAuthorDelegate) {
      await protocolConfigure.authorizeAuthorDelegate(deps.validationStateReader);
    }

    if (protocolConfigure.author === tenant) {
      return;
    } else if (protocolConfigure.author !== undefined && Message.getPermissionGrantId(protocolConfigure.signaturePayload!) !== undefined) {
      const permissionGrantId = Message.getPermissionGrantId(protocolConfigure.signaturePayload!)!;
      const permissionGrant = await deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
      await ProtocolsGrantAuthorization.authorizeConfigure({
        protocolsConfigureMessage : protocolConfigure.message,
        expectedGrantor           : tenant,
        expectedGrantee           : protocolConfigure.author,
        permissionGrant,
        validationStateReader     : deps.validationStateReader
      });
    } else {
      throw new DwnError(DwnErrorCode.ProtocolsConfigureAuthorizationFailed, 'message failed authorization');
    }
  }

  /**
   * Prevents a protocol URI from changing the at-rest representation of a path
   * after records have been admitted under that path. A policy migration must use
   * a new protocol URI so one store never contains both plaintext and ciphertext
   * records governed by the same protocol version.
   */
  private async validateEncryptionPolicyIsImmutable(
    tenant: string,
    incomingDefinition: ProtocolDefinition,
    incomingTimestamp: string,
    previousConfiguration: ProtocolsConfigureMessage | undefined,
  ): Promise<RecordsWriteMessage[] | undefined> {
    if (previousConfiguration === undefined || !ProtocolsConfigureHandler.hasEncryptionPolicyChange(
      previousConfiguration.descriptor.definition,
      incomingDefinition,
    )) {
      return undefined;
    }

    const { messages } = await this.deps.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      protocol  : incomingDefinition.protocol,
    }]);
    const recordsWrites = messages as RecordsWriteMessage[];
    const incomingPolicyByPath = new Map<string, boolean>();
    for (const recordsWrite of recordsWrites) {
      const { protocolPath } = recordsWrite.descriptor;
      if (isEncryptionControlPath(protocolPath)) {
        continue;
      }

      // Removing a path does not change its representation policy. Existing
      // records remain governed by the configuration active at their timestamp.
      if (getRuleSetAtPath(protocolPath, incomingDefinition.structure) === undefined) {
        continue;
      }

      let incomingEncryptionRequired = incomingPolicyByPath.get(protocolPath);
      if (incomingEncryptionRequired === undefined) {
        const incomingTypes = await resolveProtocolTypesForPath(
          tenant,
          protocolPath,
          incomingDefinition,
          this.deps.validationStateReader,
          incomingTimestamp,
        );
        incomingEncryptionRequired = incomingTypes[getTypeName(protocolPath)]?.encryptionRequired === true;
        incomingPolicyByPath.set(protocolPath, incomingEncryptionRequired);
      }

      if ((recordsWrite.encryption !== undefined) === incomingEncryptionRequired) {
        continue;
      }

      throw new DwnError(
        DwnErrorCode.ProtocolsConfigureEncryptionPolicyImmutable,
        `cannot change encryption policy for protocol path '${protocolPath}' after records exist; ` +
        'install the changed definition under a new protocol URI.'
      );
    }

    return recordsWrites;
  }

  /** Returns true when a configure can change a path's stored representation. */
  private static hasEncryptionPolicyChange(
    previousDefinition: ProtocolDefinition,
    incomingDefinition: ProtocolDefinition,
  ): boolean {
    const typeNames = new Set([
      ...Object.keys(previousDefinition.types),
      ...Object.keys(incomingDefinition.types),
    ]);
    for (const typeName of typeNames) {
      const previousRequired = previousDefinition.types[typeName]?.encryptionRequired === true;
      const incomingRequired = incomingDefinition.types[typeName]?.encryptionRequired === true;
      if (previousRequired !== incomingRequired) {
        return true;
      }
    }

    return ProtocolsConfigureHandler.getCompositionEncryptionPolicySignature(previousDefinition) !==
      ProtocolsConfigureHandler.getCompositionEncryptionPolicySignature(incomingDefinition);
  }

  /** Captures only composition fields that can redirect a path to another type policy. */
  private static getCompositionEncryptionPolicySignature(definition: ProtocolDefinition): string {
    const references: string[] = [];
    const visit = (ruleSet: ProtocolRuleSet, parentPath: string): void => {
      for (const [typeName, value] of Object.entries(ruleSet)) {
        if (typeName.startsWith('$')) {
          continue;
        }

        const childRuleSet = value as ProtocolRuleSet;
        const protocolPath = parentPath === '' ? typeName : `${parentPath}/${typeName}`;
        if (childRuleSet.$ref !== undefined) {
          references.push(`${protocolPath}=${childRuleSet.$ref}`);
        }
        visit(childRuleSet, protocolPath);
      }
    };
    visit(definition.structure as ProtocolRuleSet, '');

    const uses = Object.entries(definition.uses ?? {})
      .sort(([left], [right]): number => left.localeCompare(right));
    return JSON.stringify({ references: references.sort(), uses });
  }

  private async purgeRecordsInvalidatedByProtocolConfig(
    tenant: string,
    protocol: string,
    prefetchedRecordsWrites?: RecordsWriteMessage[],
  ): Promise<void> {
    const dataStore = this.deps.dataStore;
    if (dataStore === undefined) {
      return;
    }

    const recordsWrites = prefetchedRecordsWrites ?? (await this.deps.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      protocol,
    }])).messages as RecordsWriteMessage[];

    const checkedRecordIds = new Set<string>();
    for (const recordsWriteMessage of recordsWrites) {
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
        tenant, recordMessages, this.deps.messageStore, dataStore
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
        tenant, recordsWrite, this.deps.validationStateReader
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
    tenant: string,
    definition: ProtocolDefinition,
    validationStateReader: ValidationStateReader,
    messageTimestamp?: string,
  ): Promise<void> {
    const { uses } = definition;
    if (uses === undefined) {
      return;
    }

    // Fetch all referenced protocol definitions
    const referencedDefinitions = new Map<string, ProtocolDefinition>();
    for (const alias in uses) {
      const protocolUri = uses[alias];
      try {
        const refDefinition = await validationStateReader.fetchProtocolDefinition(tenant, protocolUri, messageTimestamp);
        referencedDefinitions.set(alias, refDefinition);
      } catch (error) {
        if (!(error instanceof DwnError) || error.code !== DwnErrorCode.ProtocolAuthorizationProtocolNotFound) {
          throw error;
        }

        throw new DwnError(
          DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled,
          `composed protocol '${protocolUri}' (alias '${alias}') is not installed for tenant '${tenant}'.`
        );
      }
    }

    // Walk the structure and validate all $ref paths and cross-protocol role references
    ProtocolsConfigureHandler.validateRefsAndRolesRecursively(
      definition,
      definition.structure as ProtocolRuleSet,
      '',
      referencedDefinitions,
    );
  }

  /**
   * Recursively walks the structure tree to validate:
   * - `$ref` type paths exist in the referenced protocol's structure
   * - Cross-protocol `role` references point to valid `$role: true` paths in the referenced protocol
   */
  private static validateRefsAndRolesRecursively(
    definition: ProtocolDefinition,
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
      const typeName = getTypeName(childProtocolPath);
      const isEncryptedPath = definition.types[typeName]?.encryptionRequired === true;
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

            if (isEncryptedPath && actionRule.can.includes('read') && roleRuleSet.$keyAgreement === undefined) {
              throw new DwnError(
                DwnErrorCode.ProtocolsConfigureInvalidEncryptedRoleMissingKeyAgreement,
                `encrypted protocol path '${childProtocolPath}' references cross-protocol role '${actionRule.role}' ` +
                `with no $keyAgreement.`
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
      ProtocolsConfigureHandler.validateRefsAndRolesRecursively(definition, childRuleSet, childProtocolPath, referencedDefinitions);
    }
  }
}
