import type { ModuleScope } from '../utils/permission-scope.js';
import type { PermissionGrant } from '../modules/permission-grant.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { PermissionConditions, RecordsPermissionScope } from '../types/permission-types.js';
import type { RecordsCountMessage, RecordsDeleteMessage, RecordsQueryMessage, RecordsReadMessage, RecordsSubscribeMessage, RecordsWriteMessage } from '../types/records-types.js';

import { GrantAuthorization } from './grant-authorization.js';
import { PermissionConditionPublication } from '../types/permission-types.js';
import { PermissionScopeMatcher } from '../utils/permission-scope.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

export class RecordsGrantAuthorization {
  /**
   * Authorizes the given RecordsWrite in the scope of the DID given.
   */
  public static async authorizeWrite(input: {
    recordsWriteMessage: RecordsWriteMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrant: PermissionGrant,
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      recordsWriteMessage, expectedGrantor, expectedGrantee, permissionGrant, validationStateReader
    } = input;

    await GrantAuthorization.performBaseValidation({
      incomingMessage: recordsWriteMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrant,
      validationStateReader
    });

    // NOTE: validated the invoked permission is for Records in GrantAuthorization.performBaseValidation()
    RecordsGrantAuthorization.verifyScope(recordsWriteMessage, permissionGrant.scope as RecordsPermissionScope);

    RecordsGrantAuthorization.verifyConditions(recordsWriteMessage, permissionGrant.conditions);
  }

  /**
   * Authorizes a RecordsReadMessage using the given permission grant.
   * @param validationStateReader Used to check if the given grant has been revoked.
   */
  public static async authorizeRead(input: {
    recordsReadMessage: RecordsReadMessage,
    recordsWriteMessageToBeRead: RecordsWriteMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrant: PermissionGrant,
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      recordsReadMessage, recordsWriteMessageToBeRead, expectedGrantor, expectedGrantee, permissionGrant, validationStateReader
    } = input;

    await GrantAuthorization.performBaseValidation({
      incomingMessage: recordsReadMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrant,
      validationStateReader
    });

    // NOTE: validated the invoked permission is for Records in GrantAuthorization.performBaseValidation()
    RecordsGrantAuthorization.verifyScope(recordsWriteMessageToBeRead, permissionGrant.scope as RecordsPermissionScope);
  }

  /**
   * Authorizes the scope of a permission grant for RecordsQuery or RecordsSubscribe.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public static async authorizeQueryOrSubscribe(input: {
    incomingMessage: RecordsCountMessage | RecordsQueryMessage | RecordsSubscribeMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrant: PermissionGrant,
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      incomingMessage, expectedGrantor, expectedGrantee, permissionGrant, validationStateReader
    } = input;

    await GrantAuthorization.performBaseValidation({
      incomingMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrant,
      validationStateReader
    });

    // The grant's module must match the query/subscribe filter's module.
    // NOTE: validated the invoked permission is for Records in GrantAuthorization.performBaseValidation()
    const permissionScope = permissionGrant.scope as RecordsPermissionScope;
    const messageFilter = incomingMessage.descriptor.filter;
    if (!PermissionScopeMatcher.matches(permissionScope, {
      module     : messageFilter.module,
      modulePath : messageFilter.modulePath,
      contextId  : messageFilter.contextId,
    })) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationQueryOrSubscribeModuleScopeMismatch,
        `Grant scope does not match Records ${incomingMessage.descriptor.method} filter`
      );
    }
  }

  /**
   * Authorizes the scope of a permission grant for RecordsDelete.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public static async authorizeDelete(input: {
    recordsDeleteMessage: RecordsDeleteMessage,
    recordsWriteToDelete: RecordsWriteMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrant: PermissionGrant,
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      recordsDeleteMessage, recordsWriteToDelete, expectedGrantor, expectedGrantee, permissionGrant, validationStateReader
    } = input;

    await GrantAuthorization.performBaseValidation({
      incomingMessage: recordsDeleteMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrant,
      validationStateReader
    });

    // NOTE: validated the invoked permission is for Records in GrantAuthorization.performBaseValidation()
    RecordsGrantAuthorization.verifyDeleteScope(recordsWriteToDelete, permissionGrant.scope as RecordsPermissionScope);
  }

  /**
   * Verifies a record against the scope of the given grant.
   */
  private static verifyScope(
    recordsWriteMessage: RecordsWriteMessage,
    grantScope: RecordsPermissionScope
  ): void {
    const target = RecordsGrantAuthorization.getModuleScopeTarget(recordsWriteMessage);

    if (PermissionScopeMatcher.matches(grantScope, target)) {
      return;
    }

    if (grantScope.module !== target.module) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationScopeModuleMismatch,
        `Grant scope specifies different module than what appears in the record`
      );
    }

    RecordsGrantAuthorization.throwScopeMismatchAfterModuleMatch(grantScope, target);
  }

  /**
   * Verifies RecordsDelete scope while preserving the delete-specific module mismatch code.
   */
  private static verifyDeleteScope(
    recordsWriteMessage: RecordsWriteMessage,
    grantScope: RecordsPermissionScope
  ): void {
    const target = RecordsGrantAuthorization.getModuleScopeTarget(recordsWriteMessage);

    if (PermissionScopeMatcher.matches(grantScope, target)) {
      return;
    }

    if (grantScope.module !== target.module) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationDeleteModuleScopeMismatch,
        `Grant module scope ${grantScope.module} does not match module in record to delete ${target.module}`
      );
    }

    RecordsGrantAuthorization.throwScopeMismatchAfterModuleMatch(grantScope, target);
  }

  private static getModuleScopeTarget(recordsWriteMessage: RecordsWriteMessage): ModuleScope {
    return {
      module     : recordsWriteMessage.descriptor.module,
      modulePath : recordsWriteMessage.descriptor.modulePath,
      contextId  : recordsWriteMessage.contextId,
    };
  }

  private static throwScopeMismatchAfterModuleMatch(
    grantScope: RecordsPermissionScope,
    target: ModuleScope
  ): never {
    // If grant specifies a contextId, check that record falls under that contextId
    if (grantScope.contextId !== undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationScopeContextIdMismatch,
        `Grant scope specifies different contextId than what appears in the record`
      );
    }

    // If grant specifies modulePath, check that record is at that modulePath
    if (grantScope.modulePath !== undefined && grantScope.modulePath !== target.modulePath) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationScopeModulePathMismatch,
        `Grant scope specifies different modulePath than what appears in the record`
      );
    }

    throw new DwnError(
      DwnErrorCode.RecordsGrantAuthorizationScopeMismatch,
      `Grant scope does not match the record`
    );
  }

  /**
   * Verifies grant `conditions`.
   * Currently the only condition is `published` which only applies to RecordsWrites
   */
  private static verifyConditions(recordsWriteMessage: RecordsWriteMessage, conditions: PermissionConditions | undefined): void {

    // If conditions require publication, RecordsWrite must have `published` === true
    if (conditions?.publication === PermissionConditionPublication.Required && !recordsWriteMessage.descriptor.published) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationConditionPublicationRequired,
        'Permission grant requires message to be published'
      );
    }

    // if conditions prohibit publication, RecordsWrite must have published === false or undefined
    if (conditions?.publication === PermissionConditionPublication.Prohibited && recordsWriteMessage.descriptor.published) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationConditionPublicationProhibited,
        'Permission grant prohibits message from being published'
      );
    }
  }
}
