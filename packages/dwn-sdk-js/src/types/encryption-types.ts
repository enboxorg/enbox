import type { KeyDerivationScheme } from '../utils/hd-key.js';
import type { PublicKeyJwk } from './jose-types.js';
import type { RecordsWriteMessage } from './records-types.js';
import type { KeyEncryption, KeyUnwrapPayload } from '../utils/encryption.js';

export type KeyDecrypterDerivationScheme = KeyDerivationScheme | 'roleAudience';

export type FindKeyEncryptionParams = {
  keyEncryptions: KeyEncryption[];
  fullDerivationPath: string[];
  recordsWrite: RecordsWriteMessage;
};

export interface EncryptionKeyDeriver {
  rootKeyId: string;
  derivationScheme: KeyDerivationScheme;

  derivePublicKey(fullDerivationPath: string[]): Promise<PublicKeyJwk>;
}

export interface KeyDecrypter {
  rootKeyId: string;
  derivationScheme: KeyDecrypterDerivationScheme;

  derivePublicKey?(fullDerivationPath: string[]): Promise<PublicKeyJwk>;

  findKeyEncryption?(params: FindKeyEncryptionParams): Promise<KeyEncryption | undefined>;

  decrypt(
    fullDerivationPath: string[],
    keyUnwrapPayload: KeyUnwrapPayload,
  ): Promise<Uint8Array>;
}
