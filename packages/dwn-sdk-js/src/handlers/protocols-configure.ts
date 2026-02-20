import type { DidResolver } from '@enbox/dids';
import type { EventStream } from '../types/subscriptions.js';
import type { GenericMessageReply } from '../types/message-types.js';
import type { MessageStore } from '../types//message-store.js';
import type { MethodHandler } from '../types/method-handler.js';
import type { StateIndex } from '../types/state-index.js';
import type { ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage } from '../types/protocols-types.js';

import { authenticate } from '../core/auth.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { ProtocolsConfigure } from '../interfaces/protocols-configure.js';
import { ProtocolsGrantAuthorization } from '../core/protocols-grant-authorization.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, parseCrossProtocolRef } from '../utils/protocols.js';

export class ProtocolsConfigureHandler implements MethodHandler {

  constructor(
    private didResolver: DidResolver,
    private messageStore: MessageStore,
    private stateIndex: StateIndex,
    private eventStream?: EventStream
  ) { }

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
      await authenticate(message.authorization, this.didResolver);
      await ProtocolsConfigureHandler.authorizeProtocolsConfigure(tenant, protocolsConfigure, this.messageStore);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // validate composition dependencies: all `uses` protocols must already be installed,
    // `$ref` paths must exist in the referenced protocols, and cross-protocol roles must exist.
    try {
      await ProtocolsConfigureHandler.validateCompositionDependencies(
        tenant, message.descriptor.definition, this.messageStore
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
    const { messages: existingMessages } = await this.messageStore.query(tenant, [ query ]);

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

      await this.messageStore.put(tenant, message, indexes);
      const messageCid = await Message.getCid(message);
      await this.stateIndex.insert(tenant, messageCid, indexes);

      // only emit if the event stream is set
      if (this.eventStream !== undefined) {
        this.eventStream.emit(tenant, { message }, indexes);
      }

      messageReply = {
        status: { code: 202, detail: 'Accepted' }
      };
    } else {
      // incoming message is older — still store it as a historical version (not the latest)
      const indexes = ProtocolsConfigureHandler.constructIndexes(protocolsConfigure, false);

      await this.messageStore.put(tenant, message, indexes);
      const messageCid = await Message.getCid(message);
      await this.stateIndex.insert(tenant, messageCid, indexes);

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

        await this.messageStore.delete(tenant, existingCid);
        await this.messageStore.put(tenant, existingMessage, updatedIndexes);
      }
    }

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
    } else if (protocolConfigure.author !== undefined && protocolConfigure.signaturePayload!.permissionGrantId !== undefined) {
      const permissionGrant = await PermissionsProtocol.fetchGrant(tenant, messageStore, protocolConfigure.signaturePayload!.permissionGrantId);
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

      // Validate $ref path exists in the referenced protocol
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

          const targetRuleSet = getRuleSetAtPath(parsed.protocolPath, refDefinition.structure);
          if (targetRuleSet === undefined) {
            throw new DwnError(
              DwnErrorCode.ProtocolsConfigureInvalidRefProtocolPath,
              `'$ref' at protocol path '${childProtocolPath}' references type path '${parsed.protocolPath}' ` +
              `which does not exist in protocol '${refDefinition.protocol}'.`
            );
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
            if (roleRuleSet === undefined || !roleRuleSet.$role) {
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