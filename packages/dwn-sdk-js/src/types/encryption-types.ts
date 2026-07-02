import type { KeyDerivationScheme } from '../utils/hd-key.js';
import type { KeyUnwrapPayload } from '../utils/encryption.js';
import type { PrivateKeyJwk, PublicKeyJwk } from './jose-types.js';

export type RoleAudienceTuple = {
  protocol: string;
  rolePath: string;
  contextId: string;
};

export type RoleAudienceKeyId = RoleAudienceTuple & {
  keyId: string;
};

export enum EncryptionControlDeliveryRecipientAuthority {
  RoleCreatorAnyone = 'roleCreatorAnyone',
  RoleCreatorGrant = 'roleCreatorGrant',
  RoleCreatorRole = 'roleCreatorRole',
  RoleHolder = 'roleHolder',
}

export type EncryptionControlAudienceTags = RoleAudienceKeyId;

export type EncryptionControlDeliveryTags = RoleAudienceKeyId & {
  recipientAuthority: EncryptionControlDeliveryRecipientAuthority | `${EncryptionControlDeliveryRecipientAuthority}`;
  grantId?: string;
  roleRef?: string;
};

export type X25519KeyWrap = {
  algorithm: 'X25519-HKDF-SHA256+A256KW';
  keyId: string;
  ephemeralPublicKey: PublicKeyJwk;
  encryptedKey: string;
};

export type EncryptionControlSeal = X25519KeyWrap & {
  derivationScheme: 'seal';
};

export type EncryptionControlAudiencePayload = RoleAudienceKeyId & {
  publicKeyJwk: PublicKeyJwk;
  sealedPrivateKey: EncryptionControlSeal;
};

export type RoleAudienceKeyMaterial = {
  algorithm: 'X25519-HKDF-SHA256+A256KW';
  derivationScheme: 'roleAudience';
  keyId: string;
  publicKeyJwk: PublicKeyJwk;
  privateKeyJwk: PrivateKeyJwk;
};

export type EncryptionControlDeliveryPayload = RoleAudienceKeyId & {
  keyMaterial: RoleAudienceKeyMaterial;
};

export type KeyDecrypterDerivationScheme = KeyDerivationScheme | 'roleAudience';

export interface EncryptionKeyDeriver {
  rootKeyId: string;
  derivationScheme: KeyDerivationScheme;

  derivePublicKey(fullDerivationPath: string[]): Promise<PublicKeyJwk>;
}

export interface KeyDecrypter {
  rootKeyId: string;
  derivationScheme: KeyDecrypterDerivationScheme;

  derivePublicKey(fullDerivationPath: string[]): Promise<PublicKeyJwk>;

  decrypt(
    fullDerivationPath: string[],
    keyUnwrapPayload: KeyUnwrapPayload,
  ): Promise<Uint8Array>;
}
