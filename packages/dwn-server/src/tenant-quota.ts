import type { RegistrationStore } from './registration/registration-store.js';
import type { TenantQuota } from './admin/types.js';
import type { GenericMessage, MessageStoreQuotaResolver } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, Records } from '@enbox/dwn-sdk-js';

export type TenantQuotaDefaults = {
  quotaMaxMessages: number;
  quotaMaxStorageBytes: number;
};

export type ResolvedTenantQuota = {
  maxMessages: number;
  maxStorageBytes: number;
  source: 'global' | 'tenant' | 'unlimited';
};

const maximumPersistedMessageQuota = 2_147_483_647;

/** Resolves a tenant override, where zero inherits the corresponding global default. */
export function resolveTenantQuota(
  defaults: TenantQuotaDefaults,
  tenantQuota?: TenantQuota,
): ResolvedTenantQuota {
  const tenantMessageLimit = tenantQuota !== undefined && tenantQuota.maxMessages > 0;
  const tenantStorageLimit = tenantQuota !== undefined && tenantQuota.maxStorageBytes > 0;
  const maxMessages = tenantMessageLimit ? tenantQuota.maxMessages : defaults.quotaMaxMessages;
  const maxStorageBytes = tenantStorageLimit ? tenantQuota.maxStorageBytes : defaults.quotaMaxStorageBytes;
  let source: ResolvedTenantQuota['source'] = 'unlimited';
  if (tenantMessageLimit || tenantStorageLimit) {
    source = 'tenant';
  } else if (maxMessages > 0 || maxStorageBytes > 0) {
    source = 'global';
  }

  return {
    maxMessages,
    maxStorageBytes,
    source,
  };
}

/** Returns whether a quota input is representable by the server and its stores. */
export function isValidQuotaLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Returns whether a message quota fits every supported SQL integer column. */
export function isValidMessageQuotaLimit(value: unknown): value is number {
  return isValidQuotaLimit(value) && value <= maximumPersistedMessageQuota;
}

/**
 * Returns whether this message kind is subject to stored-message quota admission.
 * Deletes remain admissible at the limit so a tenant can release data and converge;
 * this is an admission budget rather than a strict physical-row ceiling.
 */
export function requiresTenantQuotaEnforcement(message: GenericMessage): boolean {
  return Records.isRecordsWrite(message)
    || (message.descriptor.interface === DwnInterfaceName.Protocols
      && message.descriptor.method === DwnMethodName.Configure);
}

/** Builds the single quota-policy hook used by the SQL message store. */
export function createMessageStoreQuotaResolver(
  defaults: TenantQuotaDefaults,
  registrationStore?: RegistrationStore,
): MessageStoreQuotaResolver {
  return async (tenant, message) => {
    if (!requiresTenantQuotaEnforcement(message)) {
      return undefined;
    }

    const quota = resolveTenantQuota(defaults, await registrationStore?.getQuota(tenant));
    return quota.maxMessages === 0 && quota.maxStorageBytes === 0
      ? undefined
      : { maxMessages: quota.maxMessages, maxStorageBytes: quota.maxStorageBytes };
  };
}
