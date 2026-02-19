import type {
  AsymmetricKeyConverter,
  Cipher,
  DigestParams,
  DsaApi,
  GenerateKeyParams,
  GetPublicKeyParams,
  Jwk,
  KeyBytesDeriver,
  KeyWrapper,
  SignParams,
  VerifyParams,
} from '@enbox/crypto';

import type { BytesToPrivateKeyParams, BytesToPublicKeyParams, CipherParams, DeriveKeyBytesParams, DeriveKeyParams, PrivateKeyToBytesParams, PublicKeyToBytesParams, UnwrapKeyParams, WrapKeyParams } from './params-direct.js';

export type { DsaApi } from '@enbox/crypto';

export interface CryptoApi<
  GenerateKeyInput = GenerateKeyParams,
  GenerateKeyOutput = Jwk,
  GetPublicKeyInput = GetPublicKeyParams,
  DigestInput = DigestParams,
  SignInput = SignParams,
  VerifyInput = VerifyParams,
  EncryptInput = CipherParams,
  DecryptInput = CipherParams,
  BytesToPublicKeyInput = BytesToPublicKeyParams,
  PublicKeyToBytesInput = PublicKeyToBytesParams,
  BytesToPrivateKeyInput = BytesToPrivateKeyParams,
  PrivateKeyToBytesInput = PrivateKeyToBytesParams,
  DeriveKeyInput = DeriveKeyParams,
  DeriveKeyOutput = Jwk,
  DeriveKeyBytesInput = DeriveKeyBytesParams,
  DeriveKeyBytesOutput = Uint8Array,
  WrapKeyInput = WrapKeyParams,
  UnwrapKeyInput = UnwrapKeyParams
> extends
  DsaApi<GenerateKeyInput, GenerateKeyOutput, GetPublicKeyInput, DigestInput, SignInput, VerifyInput>,
  Cipher<EncryptInput, DecryptInput>,
  AsymmetricKeyConverter<BytesToPublicKeyInput, PublicKeyToBytesInput, BytesToPrivateKeyInput, PrivateKeyToBytesInput>,
  KeyBytesDeriver<DeriveKeyBytesInput, DeriveKeyBytesOutput>,
  KeyWrapper<WrapKeyInput, UnwrapKeyInput> {

  /**
   * Derives a cryptographic key based on the provided input parameters.
   *
   * @param params - The parameters for the key derivation process.
   * @returns A Promise resolving to the derived key.
   */
  deriveKey(params: DeriveKeyInput): Promise<DeriveKeyOutput>;
}
