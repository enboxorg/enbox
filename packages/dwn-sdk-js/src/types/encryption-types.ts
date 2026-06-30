import type { KeyDerivationScheme } from '../utils/hd-key.js';
import type { KeyUnwrapPayload } from '../utils/encryption.js';
import type { PublicKeyJwk } from './jose-types.js';

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
