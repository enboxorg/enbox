import type { GenericMessage } from '../types/message-types.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export class GrantAuthorization {

  /**
   * Performs base permissions-grant-based authorization against the given message:
   * 1. Validates the `expectedGrantor` and `expectedGrantee` values against the actual values in given permission grant.
   * 2. Verifies that the incoming message is within the allowed time frame of the grant, and the grant has not been revoked.
   * 3. Verifies that the `interface` and `method` grant scopes match the incoming message.
   *
   * NOTE: Does not validate grant `conditions` or `scope` beyond `interface` and `method`
   *
   * @param validationStateReader Used to check if the grant has been revoked.
   * @throws {DwnError} if validation fails
   */
  public static async performBaseValidation(input: {
    incomingMessage: GenericMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrant: PermissionGrant,
    validationStateReader: ValidationStateReader,
    }): Promise<void> {
    const { incomingMessage, expectedGrantor, expectedGrantee, permissionGrant, validationStateReader } = input;

    const incomingMessageDescriptor = incomingMessage.descriptor;

    GrantAuthorization.verifyExpectedGrantorAndGrantee(expectedGrantor, expectedGrantee, permissionGrant);

    // verify that grant is active during incomingMessage's timestamp
    const grantedFor = expectedGrantor; // renaming for better readability now that we have verified the grantor above
    await GrantAuthorization.verifyGrantActive(
      grantedFor,
      incomingMessageDescriptor.messageTimestamp,
      permissionGrant,
      validationStateReader
    );

    // Check grant scope for interface and method
    await GrantAuthorization.verifyGrantScopeInterfaceAndMethod(
      incomingMessageDescriptor.interface,
      incomingMessageDescriptor.method,
      permissionGrant,
    );
  }

  /**
   * Verifies the given `expectedGrantor` and `expectedGrantee` values against
   * the actual signer and recipient in given permission grant.
   * @throws {DwnError} if `expectedGrantor` or `expectedGrantee` do not match the actual values in the grant.
   */
  private static verifyExpectedGrantorAndGrantee(
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrant: PermissionGrant
  ): void {

    const actualGrantee = permissionGrant.grantee;
    if (expectedGrantee !== actualGrantee) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationNotGrantedToAuthor,
        `Permission grant is granted to ${actualGrantee}, but need to be granted to ${expectedGrantee}`
      );
    }

    const actualGrantor = permissionGrant.grantor;
    if (expectedGrantor !== actualGrantor) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationNotGrantedForTenant,
        `Permission grant is granted by ${actualGrantor}, but need to be granted by ${expectedGrantor}`
      );
    }
  }

  /**
   * Verify that the incoming message is within the allowed time frame of the grant,
   * and the grant has not been revoked.
   * @param validationStateReader Used to check if the grant has been revoked.
   * @throws {DwnError} if incomingMessage has timestamp for a time in which the grant is not active.
   */
  private static async verifyGrantActive(
    grantedFor: string,
    incomingMessageTimestamp: string,
    permissionGrant: PermissionGrant,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    // Check that incomingMessage is within the grant's time frame
    if (incomingMessageTimestamp < permissionGrant.dateGranted) {
      // grant is not yet active
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantNotYetActive,
        `The message has a timestamp before the associated permission grant becomes active`,
      );
    }

    if (incomingMessageTimestamp >= permissionGrant.dateExpires) {
      // grant has expired
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantExpired,
        `The message has timestamp after the expiry of the associated permission grant`,
      );
    }

    const oldestExistingRevoke = await validationStateReader.fetchOldestGrantRevocation(grantedFor, permissionGrant.id);

    if (oldestExistingRevoke !== undefined && oldestExistingRevoke.descriptor.messageTimestamp <= incomingMessageTimestamp) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantRevoked,
        `Permission grant with CID ${permissionGrant.id} has been revoked`,
      );
    }
  }

  /**
   * Verify that the `interface` and `method` grant scopes match the incoming message.
   *
   * For the Messages interface, a `Read` scope is treated as a unified scope that also authorizes
   * `Query`, `Subscribe`, and `Sync` operations.
   *
   * @throws {DwnError} if the `interface` and `method` of the incoming message do not match the scope of the permission grant.
   */
  private static async verifyGrantScopeInterfaceAndMethod(
    dwnInterface: string,
    dwnMethod: string,
    permissionGrant: PermissionGrant,
  ): Promise<void> {

    if (dwnInterface !== permissionGrant.scope.interface) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationInterfaceMismatch,
        `DWN Interface of incoming message is outside the scope of permission grant with ID ${permissionGrant.id}`
      );
    }

    // Messages.Read is the only valid Messages scope and covers Read, Query, and Subscribe operations.
    // Reject any Messages grant with method !== Read.
    if (dwnInterface === DwnInterfaceName.Messages) {
      if (permissionGrant.scope.method !== DwnMethodName.Read) {
        throw new DwnError(
          DwnErrorCode.GrantAuthorizationMethodMismatch,
          `messages permission grant must have method 'Read', got '${permissionGrant.scope.method}' for grant ${permissionGrant.id}`
        );
      }
      const allowedMethods = [DwnMethodName.Read, DwnMethodName.Query, DwnMethodName.Subscribe];
      if (!allowedMethods.includes(dwnMethod as DwnMethodName)) {
        throw new DwnError(
          DwnErrorCode.GrantAuthorizationMethodMismatch,
          `DWN Method of incoming message is outside the scope of permission grant with ID ${permissionGrant.id}`
        );
      }
      return;
    }

    if (dwnMethod !== permissionGrant.scope.method) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationMethodMismatch,
        `DWN Method of incoming message is outside the scope of permission grant with ID ${permissionGrant.id}`
      );
    }
  }
}
