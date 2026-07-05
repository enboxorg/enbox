import type { KeyDerivationScheme } from '../utils/hd-key.js';
import type { KeyUnwrapPayload, SealKeyWrap } from '../utils/encryption.js';
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
  RoleHolder = 'roleHolder',
}

export type EncryptionControlDeliveryTags = RoleAudienceKeyId & {
  recipientAuthority: EncryptionControlDeliveryRecipientAuthority | `${EncryptionControlDeliveryRecipientAuthority}`;
};

export type EncryptionControlSeal = SealKeyWrap;

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
