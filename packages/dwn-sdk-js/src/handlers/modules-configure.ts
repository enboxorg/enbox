import type { GenericMessageReply } from '../types/message-types.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { ModuleDefinition, ModulesConfigureMessage } from '../types/modules-types.js';

import { authenticate } from '../core/auth.js';
import { isEncryptionControlPath } from '../core/constants.js';
import { lexicographicalCompare } from '../utils/string.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ModuleAuthorization } from '../core/module-authorization.js';
import { ModulesConfigure } from '../interfaces/modules-configure.js';
import { ModulesGrantAuthorization } from '../core/modules-grant-authorization.js';
import { preloadModuleDefinitions } from '../core/module-graph-loader.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { resolveModuleGraph } from '../core/module-graph.js';
import { StorageController } from '../store/storage-controller.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, getTypeName } from '../utils/modules.js';
import { validateImportedModuleContracts, validateModuleUpgrade } from '../core/module-upgrade.js';

type StoredInitialWriteConfigValidity = 'valid' | 'invalid' | 'unknown';

const STORED_INITIAL_WRITE_CONFIG_INVALID_CODES = new Set<string>([
  DwnErrorCode.EncryptionControlValidateAudienceRolePathInvalid,
  DwnErrorCode.EncryptionControlValidateAudienceSealKeyIdMismatch,
  DwnErrorCode.ModuleAuthorizationEncryptionKeyAgreementMissing,
  DwnErrorCode.ModuleAuthorizationEncryptionModulePathEntryMissing,
  DwnErrorCode.ModuleAuthorizationEncryptionNotAllowed,
  DwnErrorCode.ModuleAuthorizationEncryptionRequired,
  DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceEntryMissing,
  DwnErrorCode.ModuleAuthorizationIncorrectDataFormat,
  DwnErrorCode.ModuleAuthorizationInitialWriteRevalidationNotInitial,
  DwnErrorCode.ModuleAuthorizationInvalidSchema,
  DwnErrorCode.ModuleAuthorizationInvalidType,
  DwnErrorCode.ModuleAuthorizationMaxSizeInvalid,
  DwnErrorCode.ModuleAuthorizationMinSizeInvalid,
  DwnErrorCode.ModuleAuthorizationMissingRuleSet,
  DwnErrorCode.ModuleAuthorizationRefNodeWriteNotAllowed,
  DwnErrorCode.ModuleAuthorizationSquashNotEnabled,
  DwnErrorCode.ModuleAuthorizationSquashNotInitialWrite,
  DwnErrorCode.ModuleAuthorizationStoredInitialWriteActionNotAllowed,
  DwnErrorCode.ModuleAuthorizationStoredInitialWriteActionRulesNotFound,
  DwnErrorCode.ModuleAuthorizationStoredInitialWriteRoleMissingRecipient,
  DwnErrorCode.ModuleAuthorizationTagsInvalidSchema,
]);

export class ModulesConfigureHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
  }: { tenant: string, message: ModulesConfigureMessage }): Promise<GenericMessageReply> {
    let modulesConfigure: ModulesConfigure;
    try {
      modulesConfigure = await ModulesConfigure.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication & authorization
    try {
      await authenticate(message.authorization, this.deps.didResolver);
      await ModulesConfigureHandler.authorizeModulesConfigure(tenant, modulesConfigure, this.deps);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // validate composition dependencies: all `uses` modules must already be installed,
    // `$ref` paths must exist in the referenced modules, and cross-module roles must exist.
    try {
      await ModulesConfigureHandler.validateCompositionDependencies(
        tenant,
        message.descriptor.definition,
        this.deps.validationStateReader,
        message.descriptor.messageTimestamp,
      );
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // attempt to get existing module
    const query = {
      interface : DwnInterfaceName.Modules,
      method    : DwnMethodName.Configure,
      module    : message.descriptor.definition.module
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

    let newestMessage = await Message.getNewestMessage(existingMessages) as ModulesConfigureMessage | undefined;
    let prefetchedRecordsWrites: RecordsWriteMessage[] | undefined;
    try {
      prefetchedRecordsWrites = await this.validateEncryptionPolicyIsImmutable(
        tenant,
        message.descriptor.definition,
        newestMessage,
      );
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // Historical imports validate their own governing-time graph, never today's dependents.
    const incomingMessageIsNewest = newestMessage === undefined || await Message.isNewer(message, newestMessage);
    if (incomingMessageIsNewest) {
      try {
        if (newestMessage !== undefined) {
          await this.validateCompositionUpgradeCompatibility(tenant, newestMessage.descriptor.definition, message.descriptor.definition);
        } else {
          // A first installation becomes active even when its signed time predates a
          // provider update. Its current binding must also be usable in the active graph.
          await ModulesConfigureHandler.validateCompositionDependencies(
            tenant, message.descriptor.definition, this.deps.validationStateReader,
          );
        }
      } catch (error) {
        return messageReplyFromError(error, 400);
      }
      newestMessage = message;
    }

    // write the incoming message to DB if incoming message is newest
    let messageReply: GenericMessageReply;
    let position: ProgressToken | undefined;
    if (incomingMessageIsNewest) {
      const indexes = ModulesConfigureHandler.constructIndexes(modulesConfigure, true);

      const putResult = await this.deps.messageStore.put(tenant, message, indexes);
      position = putResult.position;

      messageReply = {
        status: { code: 202, detail: 'Accepted' },
        position,
      };
    } else {
      // incoming message is older — still store it as a historical version (not the latest)
      const indexes = ModulesConfigureHandler.constructIndexes(modulesConfigure, false);

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
        await this.markConfigurationHistorical( // NOSONAR: S9382 — a failed durable demotion must stop subsequent index mutations.
          tenant, existingMessage as ModulesConfigureMessage,
        );
      }
    }

    await this.purgeRecordsInvalidatedByModuleConfig(
      tenant,
      message.descriptor.definition.module,
      prefetchedRecordsWrites,
    );

    return messageReply;
  };

  /** Demote stored metadata without parsing or revalidating a retained historical definition. */
  private async markConfigurationHistorical(tenant: string, message: ModulesConfigureMessage): Promise<void> {
    const indexes = ModulesConfigureHandler.constructIndexesFromMessage(message, false);
    const messageCid = await Message.getCid(message);
    await this.deps.messageStore.updateIndexes(tenant, messageCid, indexes);
  }

  static constructIndexes(modulesConfigure: ModulesConfigure, isLatestBaseState: boolean): { [key: string]: string | boolean } {
    return ModulesConfigureHandler.constructIndexesFromMessage(modulesConfigure.message, isLatestBaseState);
  }

  private static constructIndexesFromMessage(message: ModulesConfigureMessage, isLatestBaseState: boolean): { [key: string]: string | boolean } {
    // strip out `definition` as it is not indexable
    const { definition, ...propertiesToIndex } = message.descriptor;
    const author = Message.getAuthor(message);

    const indexes: { [key: string]: string | boolean } = {
      ...propertiesToIndex,
      author    : author!,
      module    : definition.module, // retain module url from `definition`,
      published : definition.published, // retain published state from definition
      isLatestBaseState,
    };

    return indexes;
  }

  private static async authorizeModulesConfigure(tenant: string, moduleConfigure: ModulesConfigure, deps: HandlerDependencies): Promise<void> {

    if (moduleConfigure.isSignedByAuthorDelegate) {
      await moduleConfigure.authorizeAuthorDelegate(deps.validationStateReader);
    }

    if (moduleConfigure.author === tenant) {
      return;
    } else if (moduleConfigure.author !== undefined && Message.getPermissionGrantId(moduleConfigure.signaturePayload!) !== undefined) {
      const permissionGrantId = Message.getPermissionGrantId(moduleConfigure.signaturePayload!)!;
      const permissionGrant = await deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
      await ModulesGrantAuthorization.authorizeConfigure({
        modulesConfigureMessage : moduleConfigure.message,
        expectedGrantor         : tenant,
        expectedGrantee         : moduleConfigure.author,
        permissionGrant,
        validationStateReader   : deps.validationStateReader
      });
    } else {
      throw new DwnError(DwnErrorCode.ModulesConfigureAuthorizationFailed, 'message failed authorization');
    }
  }

  /**
   * Prevents a module URI from changing the at-rest representation of a path
   * after records have been admitted under that path. A policy migration must use
   * a new module URI so one store never contains both plaintext and ciphertext
   * records governed by the same module version.
   */
  private async validateEncryptionPolicyIsImmutable(
    tenant: string,
    incomingDefinition: ModuleDefinition,
    previousConfiguration: ModulesConfigureMessage | undefined,
  ): Promise<RecordsWriteMessage[] | undefined> {
    if (previousConfiguration === undefined || !ModulesConfigureHandler.hasEncryptionPolicyChange(
      previousConfiguration.descriptor.definition,
      incomingDefinition,
    )) {
      return undefined;
    }

    const { messages } = await this.deps.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      module    : incomingDefinition.module,
    }]);
    const recordsWrites = messages as RecordsWriteMessage[];
    const incomingPolicyByPath = new Map<string, boolean>();
    for (const recordsWrite of recordsWrites) {
      const { modulePath } = recordsWrite.descriptor;
      if (isEncryptionControlPath(modulePath)) {
        continue;
      }

      // Removing a path does not change its representation policy. Existing
      // records remain governed by the configuration active at their timestamp.
      if (getRuleSetAtPath(modulePath, incomingDefinition.structure) === undefined) {
        continue;
      }

      let incomingEncryptionRequired = incomingPolicyByPath.get(modulePath);
      if (incomingEncryptionRequired === undefined) {
        incomingEncryptionRequired = incomingDefinition.types[getTypeName(modulePath)]?.encryptionRequired === true;
        incomingPolicyByPath.set(modulePath, incomingEncryptionRequired);
      }

      if ((recordsWrite.encryption !== undefined) === incomingEncryptionRequired) {
        continue;
      }

      throw new DwnError(
        DwnErrorCode.ModulesConfigureEncryptionPolicyImmutable,
        `cannot change encryption policy for module path '${modulePath}' after records exist; ` +
        'install the changed definition under a new module URI.'
      );
    }

    return recordsWrites;
  }

  /** Returns true when a configure can change a path's stored representation. */
  private static hasEncryptionPolicyChange(
    previousDefinition: ModuleDefinition,
    incomingDefinition: ModuleDefinition,
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

    return false;
  }

  private async purgeRecordsInvalidatedByModuleConfig(
    tenant: string,
    module: string,
    prefetchedRecordsWrites?: RecordsWriteMessage[],
  ): Promise<void> {
    const dataStore = this.deps.dataStore;
    if (dataStore === undefined) {
      return;
    }

    const recordsWrites = prefetchedRecordsWrites ?? (await this.deps.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      module,
    }])).messages as RecordsWriteMessage[];

    const checkedRecordIds = new Set<string>();
    for (const message of recordsWrites) {
      if (checkedRecordIds.has(message.recordId)) {
        continue;
      }

      const checked = await this.purgeInvalidInitialWrite( // NOSONAR: S9382 — later validity checks must observe earlier purges.
        tenant, message, dataStore,
      );
      if (checked) {
        checkedRecordIds.add(message.recordId);
      }
    }
  }

  /** Reconcile one initial write, returning whether this record's initial state was checked. */
  private async purgeInvalidInitialWrite(tenant: string, message: RecordsWriteMessage, dataStore: DataStore): Promise<boolean> {
    if (!await RecordsWrite.isInitialWrite(message)) {
      return false;
    }
    const validity = await this.getStoredInitialWriteConfigValidity(tenant, message);
    if (validity !== 'invalid') {
      return true;
    }
    const { messages: recordMessages } = await this.deps.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      recordId  : message.recordId,
    }]);
    if (recordMessages.length === 0) {
      return true;
    }

    // A DWN cannot synthesize an author's RecordsDelete. Purge only this invalid
    // record; descendants are checked independently against the resulting state.
    await StorageController.purgeRecordMessages(tenant, recordMessages, this.deps.messageStore, dataStore);
    return true;
  }

  private async getStoredInitialWriteConfigValidity(
    tenant: string,
    message: RecordsWriteMessage,
  ): Promise<StoredInitialWriteConfigValidity> {
    try {
      const recordsWrite = await RecordsWrite.parse(message);
      // Stored records were authenticated when admitted. Reconciliation should not make
      // record retention depend on fresh DID resolution availability or mutable dependency state.
      await ModuleAuthorization.validateStoredInitialWrite(
        tenant, recordsWrite, this.deps.validationStateReader
      );
      return 'valid';
    } catch (error) {
      if (ModulesConfigureHandler.isStoredInitialWriteConfigInvalidError(error)) {
        return 'invalid';
      }

      return 'unknown';
    }
  }

  private static isStoredInitialWriteConfigInvalidError(error: unknown): boolean {
    return error instanceof DwnError && STORED_INITIAL_WRITE_CONFIG_INVALID_CODES.has(error.code);
  }

  /** Load the governing-time closure, then validate its complete graph synchronously. */
  private static async validateCompositionDependencies(
    tenant: string,
    definition: ModuleDefinition,
    validationStateReader: ValidationStateReader,
    messageTimestamp?: string,
  ): Promise<void> {
    const definitions = await preloadModuleDefinitions(definition, async (uri): Promise<ModuleDefinition> => {
      try {
        return await validationStateReader.fetchModuleDefinition(tenant, uri, messageTimestamp);
      } catch (error) {
        if (!(error instanceof DwnError) || error.code !== DwnErrorCode.ModuleAuthorizationModuleNotFound) {
          throw error;
        }
        throw new DwnError(
          DwnErrorCode.ModulesConfigureComposedModuleNotInstalled,
          `composed module '${uri}' is not installed for tenant '${tenant}' at ${messageTimestamp ?? 'the active snapshot'}`
        );
      }
    });
    resolveModuleGraph(definition, uri => definitions.get(uri), { requireKeyAgreement: true });
  }

  /** Compare active old/new snapshots without substituting historical configurations. */
  private async validateCompositionUpgradeCompatibility(
    tenant: string,
    previous: ModuleDefinition,
    incoming: ModuleDefinition,
  ): Promise<void> {
    const { messages } = await this.deps.messageStore.query(tenant, [{
      interface         : DwnInterfaceName.Modules,
      method            : DwnMethodName.Configure,
      isLatestBaseState : true,
    }]);
    const oldDefinitions = new Map((messages as ModulesConfigureMessage[])
      .map((configuration): [string, ModuleDefinition] => [configuration.descriptor.definition.module, configuration.descriptor.definition]));
    oldDefinitions.set(previous.module, previous);
    const newDefinitions = new Map(oldDefinitions);
    newDefinitions.set(incoming.module, incoming);

    const graph = async (definition: ModuleDefinition, snapshot: Map<string, ModuleDefinition>): Promise<ReturnType<typeof resolveModuleGraph>> => {
      const closure = await preloadModuleDefinitions(definition, async (uri): Promise<ModuleDefinition> => {
        const installed = snapshot.get(uri) ?? await this.deps.validationStateReader.fetchModuleDefinition(tenant, uri);
        snapshot.set(uri, installed);
        return installed;
      });
      return resolveModuleGraph(definition, uri => closure.get(uri), { requireKeyAgreement: true });
    };
    const oldGraph = await graph(previous, oldDefinitions);
    const newGraph = await graph(incoming, newDefinitions);
    const removesAttachment = [...oldGraph.nodesByDeclaredPath].some(([path, node]): boolean =>
      node.kind === 'ref' && !newGraph.nodesByDeclaredPath.has(path)
    );
    const introducesAttachment = [...newGraph.nodesByDeclaredPath].some(([path, node]): boolean =>
      node.kind === 'ref' && !oldGraph.nodesByDeclaredPath.has(path)
    );
    const writes = removesAttachment || introducesAttachment ? (await this.deps.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      module    : incoming.module,
    }])).messages : [];
    const storedPaths = new Set((writes as RecordsWriteMessage[]).map(write => write.descriptor.modulePath));
    validateModuleUpgrade(previous, incoming, oldGraph, newGraph, storedPaths);

    // A changed module affects every current dependent reachable under either snapshot.
    const affected = new Set([incoming.module]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const definition of [...oldDefinitions.values(), ...newDefinitions.values()]) {
        if (!affected.has(definition.module) && Object.values(definition.uses ?? {}).some(uri => affected.has(uri))) {
          affected.add(definition.module);
          expanded = true;
        }
      }
    }
    const visited = new Set<string>();
    const validateDependent = async (uri: string): Promise<void> => {
      if (visited.has(uri)) {
        return;
      }
      visited.add(uri);
      const definition = newDefinitions.get(uri)!;
      for (const dependency of Object.values(definition.uses ?? {})) {
        if (affected.has(dependency)) {
          await validateDependent(dependency);
        }
      }
      if (uri === incoming.module) {
        return;
      }
      try {
        const before = await graph(oldDefinitions.get(uri)!, oldDefinitions);
        const after = await graph(definition, newDefinitions);
        validateImportedModuleContracts(before, after);
      } catch (error) {
        if (!(error instanceof DwnError)) {
          throw error;
        }
        throw new DwnError(
          DwnErrorCode.ModulesConfigureIncompatibleContractUpdate,
          `module '${incoming.module}' update breaks dependent '${uri}': ${error.message}`
        );
      }
    };
    for (const uri of [...affected].sort(lexicographicalCompare)) {
      await validateDependent(uri);
    }
  }

  /** Resolve an attachment alias while retaining the current one-boundary composition contract. */
  private static validateReferenceTarget(
    reference: string | undefined,
    modulePath: string,
    referencedDefinitions: ReadonlyMap<string, ModuleDefinition>,
  ): void {
    const parsed = reference === undefined ? undefined : parseCrossModuleRef(reference);
    if (parsed === undefined) {
      return;
    }
    const definition = referencedDefinitions.get(parsed.alias);
    if (definition === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidRefAlias,
        `'$ref' alias '${parsed.alias}' at module path '${modulePath}' ` +
        `was not found in the referenced definitions map.`
      );
    }
    ModulesConfigureHandler.validateReferencedTypePath(definition, parsed.modulePath, modulePath);
  }

  /** Every node in a referenced target path must exist and must not cross another attachment. */
  private static validateReferencedTypePath(definition: ModuleDefinition, targetPath: string, modulePath: string): void {
    const segments = targetPath.split('/');
    let currentLevel = definition.structure;
    for (const [index, segment] of segments.entries()) {
      const node = currentLevel[segment] as ModuleRuleSet | undefined;
      if (node === undefined) {
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRefModulePath,
          `'$ref' at module path '${modulePath}' references type path '${targetPath}' ` +
          `which does not exist in module '${definition.module}'.`
        );
      }
      if (node.$ref !== undefined) {
        const traversedPath = segments.slice(0, index + 1).join('/');
        throw new DwnError(
          DwnErrorCode.ModulesConfigureInvalidRefTargetThroughRef,
          `'$ref' at module path '${modulePath}' references type path '${targetPath}' ` +
          `in module '${definition.module}', but the node '${traversedPath}' is itself ` +
          `a '$ref' composition point. multi-level composition (chaining through '$ref' nodes) is not supported.`
        );
      }
      currentLevel = node as { [key: string]: ModuleRuleSet };
    }
  }

  /** Validate imported role identity and the existing encrypted-read key requirement. */
  private static validateCrossModuleRoleReference(
    action: ModuleActionRule,
    modulePath: string,
    isEncryptedPath: boolean,
    referencedDefinitions: ReadonlyMap<string, ModuleDefinition>,
  ): void {
    const reference = action.role;
    const parsed = reference === undefined ? undefined : parseCrossModuleRef(reference);
    if (parsed === undefined) {
      return;
    }
    const definition = referencedDefinitions.get(parsed.alias);
    if (definition === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidCrossModuleRole,
        `cross-module role alias '${parsed.alias}' in '${reference}' at module path '${modulePath}' ` +
        `was not found in the referenced definitions map.`
      );
    }
    const roleRuleSet = getRuleSetAtPath(parsed.modulePath, definition.structure);
    if (!roleRuleSet?.$role) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidCrossModuleRole,
        `cross-module role '${reference}' at module path '${modulePath}' ` +
        `does not point to a valid role ($role: true) in module '${definition.module}'.`
      );
    }
    if (isEncryptedPath && action.can.includes('read') && roleRuleSet.$keyAgreement === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidEncryptedRoleMissingKeyAgreement,
        `encrypted module path '${modulePath}' references cross-module role '${reference}' ` +
        `with no $keyAgreement.`
      );
    }
  }

  /** Validate an explicit imported author/recipient target without inheriting provider policy. */
  private static validateCrossModuleActorReference(
    reference: string | undefined,
    modulePath: string,
    referencedDefinitions: ReadonlyMap<string, ModuleDefinition>,
  ): void {
    const parsed = reference === undefined ? undefined : parseCrossModuleRef(reference);
    if (parsed === undefined) {
      return;
    }
    const definition = referencedDefinitions.get(parsed.alias);
    if (definition === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidCrossModuleOf,
        `cross-module 'of' alias '${parsed.alias}' in '${reference}' at module path '${modulePath}' ` +
        `was not found in the referenced definitions map.`
      );
    }
    if (getRuleSetAtPath(parsed.modulePath, definition.structure) === undefined) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidCrossModuleOf,
        `cross-module 'of' reference '${reference}' at module path '${modulePath}' ` +
        `does not point to a valid type path in module '${definition.module}'.`
      );
    }
  }
}
