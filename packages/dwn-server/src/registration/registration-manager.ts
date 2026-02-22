import type { ProviderAuthPlugin } from './provider-auth-plugin.js';
import type { ActiveTenantCheckResult, TenantGate } from '@enbox/dwn-sdk-js';
import type { ProofOfWorkChallengeModel, RegistrationRequest } from '@enbox/dwn-clients';

import { readFileSync } from 'fs';

import { getDialectFromUrl } from '../storage.js';
import { ProofOfWork } from './proof-of-work.js';
import { ProofOfWorkManager } from './proof-of-work-manager.js';
import { RegistrationStore } from './registration-store.js';
import { DwnServerError, DwnServerErrorCode } from '../dwn-error.js';

/**
 * The RegistrationManager is responsible for managing the registration of tenants.
 * It handles tenant registration requests and provides the corresponding `TenantGate` implementation.
 */
export class RegistrationManager implements TenantGate {
  private proofOfWorkManager: ProofOfWorkManager;
  private providerAuthPlugin?: ProviderAuthPlugin;
  private registrationStore: RegistrationStore;

  private termsOfServiceHash?: string;
  private termsOfService?: string;

  /**
   * The terms-of-service.
   */
  public getTermsOfService(): string | undefined {
    return this.termsOfService;
  }

  /**
   * The terms-of-service hash.
   */
  public getTermsOfServiceHash(): string | undefined {
    return this.termsOfServiceHash;
  }

  /**
   * Updates the terms-of-service. Exposed for testing purposes.
   */
  public updateTermsOfService(termsOfService: string): void {
    this.termsOfServiceHash = ProofOfWork.hashAsHexString([termsOfService]);
    this.termsOfService = termsOfService;
  }

  /**
   * Creates a new RegistrationManager instance.
   * @param input.registrationStoreUrl - The URL of the registration store.
   * Set to `undefined` or empty string if tenant registration is not required (ie. DWN is open for all).
   *
   */
  public static async create(input: {
    registrationStoreUrl?: string,
    termsOfServiceFilePath?: string,
    proofOfWorkChallengeNonceSeed?: string,
    proofOfWorkInitialMaximumAllowedHash?: string,
    providerAuthPlugin?: ProviderAuthPlugin,
  }): Promise<RegistrationManager> {
    const { termsOfServiceFilePath, registrationStoreUrl } = input;

    const registrationManager = new RegistrationManager();

    // short-circuit if tenant registration is not required.
    if (!registrationStoreUrl) {
      return registrationManager;
    }

    // Initialize terms-of-service.
    if (termsOfServiceFilePath !== undefined) {
      const termsOfService = readFileSync(termsOfServiceFilePath).toString();
      registrationManager.updateTermsOfService(termsOfService);
    }

    // Initialize and start ProofOfWorkManager.
    registrationManager.proofOfWorkManager = await ProofOfWorkManager.create({
      autoStart                      : true,
      desiredSolveCountPerMinute     : 10,
      initialMaximumAllowedHashValue : input.proofOfWorkInitialMaximumAllowedHash,
      challengeSeed                  : input.proofOfWorkChallengeNonceSeed,
    });

    // Initialize RegistrationStore.
    const sqlDialect = getDialectFromUrl(new URL(registrationStoreUrl));
    const registrationStore = await RegistrationStore.create(sqlDialect);
    registrationManager.registrationStore = registrationStore;

    // Store optional provider auth plugin.
    if (input.providerAuthPlugin !== undefined) {
      registrationManager.providerAuthPlugin = input.providerAuthPlugin;
    }

    return registrationManager;
  }

  /**
   * Gets the proof-of-work challenge.
   */
  public getProofOfWorkChallenge(): ProofOfWorkChallengeModel {
    const proofOfWorkChallenge = this.proofOfWorkManager.getProofOfWorkChallenge();
    return proofOfWorkChallenge;
  }

  /**
   * Handles a registration request by dispatching to the appropriate handler
   * based on the credentials provided.
   */
  public async handleRegistrationRequest(registrationRequest: RegistrationRequest): Promise<void> {
    if (registrationRequest.providerAuth?.registrationToken !== undefined) {
      await this.handleProviderAuthRegistration(registrationRequest);
    } else if (registrationRequest.proofOfWork !== undefined) {
      await this.handleProofOfWorkRegistration(registrationRequest);
    } else {
      throw new DwnServerError(
        DwnServerErrorCode.RegistrationRequestMissingCredentials,
        'Registration request must include either providerAuth or proofOfWork credentials.',
      );
    }
  }

  /**
   * Handles a provider-auth registration request.
   */
  private async handleProviderAuthRegistration(registrationRequest: RegistrationRequest): Promise<void> {
    if (this.providerAuthPlugin === undefined) {
      throw new DwnServerError(
        DwnServerErrorCode.ProviderAuthNotEnabled,
        'Provider auth registration is not enabled on this server.',
      );
    }

    const token = registrationRequest.providerAuth!.registrationToken;
    const validationResult = await this.providerAuthPlugin.validateRegistrationToken(token);

    if (!validationResult.isValid) {
      throw new DwnServerError(
        DwnServerErrorCode.ProviderAuthTokenInvalid,
        validationResult.detail ?? 'Provider auth registration token is invalid.',
      );
    }

    // Validate ToS only when the server has ToS configured AND the request includes a hash.
    if (this.termsOfServiceHash !== undefined && registrationRequest.registrationData.termsOfServiceHash !== undefined) {
      if (registrationRequest.registrationData.termsOfServiceHash !== this.termsOfServiceHash) {
        throw new DwnServerError(DwnServerErrorCode.RegistrationManagerInvalidOrOutdatedTermsOfServiceHash,
          `Expecting terms-of-service hash ${this.termsOfServiceHash}, ` +
          `but got ${registrationRequest.registrationData.termsOfServiceHash}.`,
        );
      }
    }

    await this.registrationStore.insertOrUpdateTenantRegistration({
      did                : registrationRequest.registrationData.did,
      termsOfServiceHash : registrationRequest.registrationData.termsOfServiceHash,
      accountId          : validationResult.accountId,
      registrationType   : 'provider-auth',
      metadata           : validationResult.metadata !== undefined
        ? JSON.stringify(validationResult.metadata)
        : undefined,
    });
  }

  /**
   * Handles a proof-of-work registration request.
   */
  private async handleProofOfWorkRegistration(registrationRequest: RegistrationRequest): Promise<void> {
    // Validate ToS only when the server has ToS configured.
    if (this.termsOfServiceHash !== undefined) {
      if (registrationRequest.registrationData.termsOfServiceHash !== this.termsOfServiceHash) {
        throw new DwnServerError(DwnServerErrorCode.RegistrationManagerInvalidOrOutdatedTermsOfServiceHash,
          `Expecting terms-of-service hash ${this.termsOfServiceHash}, ` +
          `but got ${registrationRequest.registrationData.termsOfServiceHash}.`,
        );
      }
    }

    const { challengeNonce, responseNonce } = registrationRequest.proofOfWork!;

    await this.proofOfWorkManager.verifyProofOfWork({
      challengeNonce,
      responseNonce,
      requestData: JSON.stringify(registrationRequest.registrationData),
    });

    // Store tenant registration data in database.
    await this.recordTenantRegistration({
      did                : registrationRequest.registrationData.did,
      termsOfServiceHash : registrationRequest.registrationData.termsOfServiceHash,
      registrationType   : 'proof-of-work',
    });
  }

  /**
   * Records the given registration data in the database.
   * Exposed as a public method for testing purposes.
   */
  public async recordTenantRegistration(registrationData: {
    did: string;
    termsOfServiceHash?: string;
    accountId?: string;
    registrationType?: string;
    metadata?: string;
  }): Promise<void> {
    await this.registrationStore.insertOrUpdateTenantRegistration(registrationData);
  }

  /**
   * The TenantGate implementation.
   */
  public async isActiveTenant(tenant: string): Promise<ActiveTenantCheckResult> {
    // If there is no registration store initialized, then DWN is open for all.
    if (this.registrationStore === undefined) {
      return { isActiveTenant: true };
    }

    const tenantRegistration = await this.registrationStore.getTenantRegistration(tenant);

    if (tenantRegistration === undefined) {
      return {
        isActiveTenant : false,
        detail         : 'Not a registered tenant.'
      };
    }

    if (tenantRegistration.suspended) {
      return {
        isActiveTenant : false,
        detail         : 'Tenant is suspended.'
      };
    }

    // Only enforce ToS hash check when the server has a ToS configured.
    if (this.termsOfServiceHash !== undefined &&
      tenantRegistration.termsOfServiceHash !== this.termsOfServiceHash) {
      return {
        isActiveTenant : false,
        detail         : 'Agreed terms-of-service is outdated.'
      };
    }

    return { isActiveTenant: true };
  }

  /**
   * Returns the underlying RegistrationStore, if initialized.
   * Used by the admin API to access tenant data.
   */
  public getRegistrationStore(): RegistrationStore | undefined {
    return this.registrationStore;
  }
}
