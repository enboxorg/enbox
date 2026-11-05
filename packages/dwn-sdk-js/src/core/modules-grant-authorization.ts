import type { ModulePermissionScope } from '../types/permission-types.js';
import type { PermissionGrant } from '../modules/permission-grant.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ModulesConfigureMessage, ModulesQueryMessage } from '../types/modules-types.js';

import { GrantAuthorization } from './grant-authorization.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

export class ModulesGrantAuthorization {
  /**
   * Authorizes the given ModulesConfigure in the scope of the DID given.
   */
  public static async authorizeConfigure(input: {
    modulesConfigureMessage: ModulesConfigureMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrant: PermissionGrant,
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      modulesConfigureMessage, expectedGrantor, expectedGrantee, permissionGrant, validationStateReader
    } = input;

    await GrantAuthorization.performBaseValidation({
      incomingMessage: modulesConfigureMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrant,
      validationStateReader
    });

    ModulesGrantAuthorization.verifyScope(modulesConfigureMessage, permissionGrant.scope as ModulePermissionScope);
  }

  /**
   * Authorizes the scope of a permission grant for a ModulesQuery message.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public static async authorizeQuery(input: {
    expectedGrantor: string,
    expectedGrantee: string,
    incomingMessage: ModulesQueryMessage;
    permissionGrant: PermissionGrant;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const { expectedGrantee, expectedGrantor, incomingMessage, permissionGrant, validationStateReader } = input;

    await GrantAuthorization.performBaseValidation({
      incomingMessage: incomingMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrant,
      validationStateReader
    });

    // If the grant specifies a module, the query must specify the same module.
    const permissionScope = permissionGrant.scope as ModulePermissionScope;
    const moduleInGrant = permissionScope.module;
    const moduleInMessage = incomingMessage.descriptor.filter?.module;
    if (moduleInGrant !== undefined && moduleInMessage !== moduleInGrant) {
      throw new DwnError(
        DwnErrorCode.ModulesGrantAuthorizationQueryModuleScopeMismatch,
        `Grant module scope ${moduleInGrant} does not match module in message ${moduleInMessage}`
      );
    }
  }

  /**
   * Verifies a ModulesConfigure against the scope of the given grant.
   */
  private static verifyScope(
    modulesConfigureMessage: ModulesConfigureMessage,
    grantScope: ModulePermissionScope
  ): void {

    // if the grant scope does not specify a module, then it is am unrestricted grant
    if (grantScope.module === undefined) {
      return;
    }

    if (grantScope.module !== modulesConfigureMessage.descriptor.definition.module) {
      throw new DwnError(
        DwnErrorCode.ModulesGrantAuthorizationScopeModuleMismatch,
        `Grant scope specifies different module than what appears in the configure message.`
      );
    }
  }
}
