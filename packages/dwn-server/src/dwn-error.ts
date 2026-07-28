/**
 * A class that represents a DWN Server error.
 */
export class DwnServerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);

    this.name = 'DwnServerError';
  }

  /**
   * Called by `JSON.stringify(...)` automatically.
   */
  public toJSON(): { code: string, message: string } {
    return {
      code    : this.code,
      message : this.message,
    };
  }
}

/**
 * DWN Server error codes.
 */
export enum DwnServerErrorCode {
  ConnectionSubscriptionJsonRpcIdExists = 'ConnectionSubscriptionJsonRpcIdExists',
  ConnectionSubscriptionJsonRpcIdNotFound = 'ConnectionSubscriptionJsonRpcIdNotFound',
  ConnectionSubscriptionLimitExceeded = 'ConnectionSubscriptionLimitExceeded',
  ConnectionSubscriptionOpeningNotFound = 'ConnectionSubscriptionOpeningNotFound',
  ProofOfWorkInsufficientSolutionNonce = 'ProofOfWorkInsufficientSolutionNonce',
  ProofOfWorkInvalidOrExpiredChallenge = 'ProofOfWorkInvalidOrExpiredChallenge',
  ProofOfWorkManagerInvalidChallengeNonce = 'ProofOfWorkManagerInvalidChallengeNonce',
  ProofOfWorkManagerInvalidResponseNonceFormat = 'ProofOfWorkManagerInvalidResponseNonceFormat',
  ProofOfWorkManagerResponseNonceReused = 'ProofOfWorkManagerResponseNonceReused',
  ProviderAuthNotEnabled = 'ProviderAuthNotEnabled',
  ProviderAuthPluginLoadFailed = 'ProviderAuthPluginLoadFailed',
  ProviderAuthPluginNotConfigured = 'ProviderAuthPluginNotConfigured',
  ProviderAuthTokenInvalid = 'ProviderAuthTokenInvalid',
  RateLimitExceeded = 'RateLimitExceeded',
  RecordDataSizeLimitExceeded = 'RecordDataSizeLimitExceeded',
  RegistrationManagerInvalidOrOutdatedTermsOfServiceHash = 'RegistrationManagerInvalidOrOutdatedTermsOfServiceHash',
  RegistrationRequestMissingCredentials = 'RegistrationRequestMissingCredentials',
  TenantMessageQuotaExceeded = 'TenantMessageQuotaExceeded',
  TenantQuotaUsageStoreUnavailable = 'TenantQuotaUsageStoreUnavailable',
  TenantRegistrationOutdatedTermsOfService = 'TenantRegistrationOutdatedTermsOfService',
  TenantStorageQuotaExceeded = 'TenantStorageQuotaExceeded',
  TenantSuspended = 'TenantSuspended',
}
