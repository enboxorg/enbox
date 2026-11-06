import type { DataStore } from '../types/data-store.js';
import type { Filter } from '../types/query-types.js';
import type { GenericMessageReply } from '../types/message-types.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { ModuleActionRule, ModuleDefinition, ModuleRuleSet, ModulesConfigureMessage } from '../types/modules-types.js';

import { authenticate } from '../core/auth.js';
import { isEncryptionControlPath } from '../core/constants.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ModuleAuthorization } from '../core/module-authorization.js';
import { ModulesConfigure } from '../interfaces/modules-configure.js';
import { ModulesGrantAuthorization } from '../core/modules-grant-authorization.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { resolveModuleTypesForPath } from '../core/module-authorization-validation.js';
import { StorageController } from '../store/storage-controller.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, getTypeName, parseCrossModuleRef } from '../utils/modules.js';

type StoredInitialWriteConfigValidity = 'valid' | 'invalid' | 'unknown';

const STORED_INITIAL_WRITE_CONFIG_INVALID_CODES = new Set<string>([
  DwnErrorCode.EncryptionControlValidateAudienceRolePathInvalid,
  DwnErrorCode.EncryptionControlValidateAudienceSealKeyIdMismatch,
  DwnErrorCode.ModuleAuthorizationEncryptionNotAllowed,
  DwnErrorCode.ModuleAuthorizationEncryptionRequired,
  DwnErrorCode.ModuleAuthorizationIncorrectDataFormat,
  DwnErrorCode.ModuleAuthorizationInitialWriteRevalidationNotInitial,
  DwnErrorCode.ModuleAuthorizationInvalidSchema,
  DwnErrorCode.ModuleAuthorizationInvalidType,
  DwnErrorCode.ModuleAuthorizationMaxSizeInvalid,
  DwnErrorCode.ModuleAuthorizationMinSizeInvalid,
  DwnErrorCode.ModuleAuthorizationMissingRuleSet,
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
    incomingTimestamp: string,
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
        const incomingTypes = await resolveModuleTypesForPath( // NOSONAR: S9382 — stop before reading later paths after a policy mismatch.
          tenant,
          modulePath,
          incomingDefinition,
          this.deps.validationStateReader,
          incomingTimestamp,
        );
        incomingEncryptionRequired = incomingTypes[getTypeName(modulePath)]?.encryptionRequired === true;
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

    await this.validateComposedEncryptionPolicyIsImmutable(tenant, incomingDefinition);
    return recordsWrites;
  }

  /** Prevents a referenced module from changing the representation of records stored by composing modules. */
  private async validateComposedEncryptionPolicyIsImmutable(
    tenant: string,
    incomingDefinition: ModuleDefinition,
  ): Promise<void> {
    const { messages: configurationMessages } = await this.deps.messageStore.query(tenant, [{
      interface         : DwnInterfaceName.Modules,
      isLatestBaseState : true,
      method            : DwnMethodName.Configure,
    }]);
    const policiesByModule = ModulesConfigureHandler.getComposedPathPolicies(
      configurationMessages as ModulesConfigureMessage[],
      incomingDefinition,
    );
    if (policiesByModule.size === 0) {
      return;
    }

    const { messages: dependentRecordsWrites } = await this.deps.messageStore.query(
      tenant,
      [...policiesByModule.keys()].map((module): Filter => ({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        module,
      })),
    );
    for (const message of dependentRecordsWrites) {
      const recordsWrite = message as RecordsWriteMessage;
      const { module, modulePath } = recordsWrite.descriptor;
      if (module === undefined) {
        continue;
      }

      const encryptionRequired = policiesByModule.get(module)?.get(modulePath);
      if (encryptionRequired === undefined || (recordsWrite.encryption !== undefined) === encryptionRequired) {
        continue;
      }

      throw new DwnError(
        DwnErrorCode.ModulesConfigureEncryptionPolicyImmutable,
        `cannot change encryption policy for module path '${modulePath}' imported by module '${module}' ` +
        `after records exist; install the changed definition under a new module URI.`
      );
    }
  }

  /** Maps each installed composing module to root `$ref` paths whose policy comes from the incoming definition. */
  private static getComposedPathPolicies(
    configurations: ModulesConfigureMessage[],
    incomingDefinition: ModuleDefinition,
  ): Map<string, Map<string, boolean>> {
    const policiesByModule = new Map<string, Map<string, boolean>>();
    for (const configuration of configurations) {
      const composingDefinition = configuration.descriptor.definition;
      const pathPolicies = ModulesConfigureHandler.getImportedPathPolicies(
        composingDefinition,
        incomingDefinition,
      );
      if (pathPolicies.size > 0) {
        policiesByModule.set(composingDefinition.module, pathPolicies);
      }
    }

    return policiesByModule;
  }

  /** Resolves the effective policy for root `$ref` paths that import one definition. */
  private static getImportedPathPolicies(
    composingDefinition: ModuleDefinition,
    incomingDefinition: ModuleDefinition,
  ): Map<string, boolean> {
    const pathPolicies = new Map<string, boolean>();
    const importedAliases = new Set(
      Object.entries(composingDefinition.uses ?? {})
        .filter(([, module]): boolean => module === incomingDefinition.module)
        .map(([alias]): string => alias),
    );
    if (importedAliases.size === 0) {
      return pathPolicies;
    }

    for (const [modulePath, ruleSet] of Object.entries(composingDefinition.structure)) {
      const reference = ruleSet.$ref === undefined ? undefined : parseCrossModuleRef(ruleSet.$ref);
      if (reference === undefined || !importedAliases.has(reference.alias)) {
        continue;
      }

      const typeName = getTypeName(modulePath);
      pathPolicies.set(modulePath, incomingDefinition.types[typeName]?.encryptionRequired === true);
    }

    return pathPolicies;
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

    return ModulesConfigureHandler.getCompositionEncryptionPolicySignature(previousDefinition) !==
      ModulesConfigureHandler.getCompositionEncryptionPolicySignature(incomingDefinition);
  }

  /** Captures only composition fields that can redirect a path to another type policy. */
  private static getCompositionEncryptionPolicySignature(definition: ModuleDefinition): string {
    const references: string[] = [];
    const visit = (ruleSet: ModuleRuleSet, parentPath: string): void => {
      for (const [typeName, value] of Object.entries(ruleSet)) {
        if (typeName.startsWith('$')) {
          continue;
        }

        const childRuleSet = value as ModuleRuleSet;
        const modulePath = parentPath === '' ? typeName : `${parentPath}/${typeName}`;
        if (childRuleSet.$ref !== undefined) {
          references.push(`${modulePath}=${childRuleSet.$ref}`);
        }
        visit(childRuleSet, modulePath);
      }
    };
    visit(definition.structure as ModuleRuleSet, '');

    const uses = Object.entries(definition.uses ?? {})
      .sort(([left], [right]): number => left.localeCompare(right));
    references.sort((left, right): number => left.localeCompare(right));
    return JSON.stringify({ references, uses });
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

  /**
   * Validates composition dependencies at install time:
   * 1. All `uses` modules must already be installed for the tenant.
   * 2. Each `$ref` path must exist in the referenced module's structure.
   * 3. Cross-module role references must point to valid role paths in the referenced module.
   *
   * This is a no-op if the module definition has no `uses` map.
   */
  private static async validateCompositionDependencies(
    tenant: string,
    definition: ModuleDefinition,
    validationStateReader: ValidationStateReader,
    messageTimestamp?: string,
  ): Promise<void> {
    const { uses } = definition;
    if (uses === undefined) {
      return;
    }

    // Fetch all referenced module definitions
    const referencedDefinitions = new Map<string, ModuleDefinition>();
    for (const alias in uses) {
      const moduleUri = uses[alias];
      try {
        const refDefinition = await validationStateReader.fetchModuleDefinition( // NOSONAR: S9382 — bound reads and preserve first-alias failure.
          tenant, moduleUri, messageTimestamp,
        );
        referencedDefinitions.set(alias, refDefinition);
      } catch (error) {
        if (!(error instanceof DwnError) || error.code !== DwnErrorCode.ModuleAuthorizationModuleNotFound) {
          throw error;
        }

        throw new DwnError(
          DwnErrorCode.ModulesConfigureComposedModuleNotInstalled,
          `composed module '${moduleUri}' (alias '${alias}') is not installed for tenant '${tenant}'.`
        );
      }
    }

    // Walk the structure and validate all $ref paths and cross-module role references
    ModulesConfigureHandler.validateRefsAndRolesRecursively(
      definition,
      definition.structure as ModuleRuleSet,
      '',
      referencedDefinitions,
    );
  }

  /** Walk each declared node and validate its attachment and explicit action references. */
  private static validateRefsAndRolesRecursively(
    definition: ModuleDefinition,
    ruleSet: ModuleRuleSet,
    modulePath: string,
    referencedDefinitions: Map<string, ModuleDefinition>,
  ): void {
    for (const key in ruleSet) {
      if (key.startsWith('$')) {
        continue;
      }
      const childRuleSet = ruleSet[key] as ModuleRuleSet;
      const childModulePath = modulePath === '' ? key : `${modulePath}/${key}`;
      ModulesConfigureHandler.validateReferenceTarget(childRuleSet.$ref, childModulePath, referencedDefinitions);

      const isEncryptedPath = definition.types[getTypeName(childModulePath)]?.encryptionRequired === true;
      for (const action of childRuleSet.$actions ?? []) {
        ModulesConfigureHandler.validateCrossModuleRoleReference(action, childModulePath, isEncryptedPath, referencedDefinitions);
        ModulesConfigureHandler.validateCrossModuleActorReference(action.of, childModulePath, referencedDefinitions);
      }
      ModulesConfigureHandler.validateRefsAndRolesRecursively(definition, childRuleSet, childModulePath, referencedDefinitions);
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
